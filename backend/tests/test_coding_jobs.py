import asyncio
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "postgresql://test:test@127.0.0.1:5432/test")

from app import jobs
from app.config import settings
from app.mailer import run_link, send_run_finished, send_run_started


def job_row(**kwargs):
    base = dict(
        token="t" * 32, status="running", current_episode=0, total_episodes=0,
        episodes_coded=0, error_count=0, error_sample=[], message="",
        file_name="data.csv", models=["gpt-4o-mini"], runs_per_model=1,
        result_path="", email_status="", started_at=None, finished_at=None,
        expires_at=None,
    )
    base.update(kwargs)
    return SimpleNamespace(**base)


class RunTokenTests(unittest.TestCase):
    """The token is the only thing guarding a run's results, so it has to be
    unguessable and unique."""

    def test_tokens_are_long_and_do_not_repeat(self):
        tokens = {jobs.new_token() for _ in range(500)}
        self.assertEqual(len(tokens), 500)
        self.assertTrue(all(len(t) == 32 for t in tokens))

    def test_links_expire_after_the_configured_window(self):
        start = datetime(2026, 10, 1, 12, 0, 0)
        self.assertEqual(
            jobs.expiry_from(start),
            start + timedelta(hours=settings.run_link_ttl_hours),
        )


class AccessKeyTests(unittest.TestCase):
    """The link travels in a URL and URLs leak, so the key is the thing that
    actually protects a run's results."""

    def test_keys_are_unguessable_and_do_not_repeat(self):
        keys = {jobs.new_access_key() for _ in range(500)}
        self.assertEqual(len(keys), 500)

    def test_keys_avoid_characters_that_are_misread_when_retyped(self):
        alphabet = set(jobs._KEY_ALPHABET)
        for ambiguous in "O0I1lUV":
            self.assertNotIn(ambiguous, alphabet, ambiguous)

    def test_only_the_hash_is_ever_stored(self):
        key = jobs.new_access_key()
        stored = jobs.hash_access_key(key)
        self.assertNotIn(key, stored)
        self.assertEqual(len(stored), 64)

    def test_the_right_key_opens_the_run(self):
        key = jobs.new_access_key()
        job = SimpleNamespace(access_key_hash=jobs.hash_access_key(key))
        self.assertTrue(jobs.access_key_matches(job, key))

    def test_case_and_surrounding_space_are_forgiven(self):
        key = jobs.new_access_key()
        job = SimpleNamespace(access_key_hash=jobs.hash_access_key(key))
        self.assertTrue(jobs.access_key_matches(job, f"  {key.lower()} "))

    def test_a_wrong_or_missing_key_does_not(self):
        job = SimpleNamespace(access_key_hash=jobs.hash_access_key(jobs.new_access_key()))
        self.assertFalse(jobs.access_key_matches(job, "AAAAA-BBBBB"))
        self.assertFalse(jobs.access_key_matches(job, ""))

    def test_runs_created_before_keys_existed_still_open(self):
        self.assertTrue(jobs.access_key_matches(SimpleNamespace(access_key_hash=""), ""))


class EtaTests(unittest.TestCase):
    """The estimate comes from the rate the run itself achieves, which works
    because the coding loop is sequential — one awaited call per episode."""

    def test_no_estimate_until_enough_episodes_are_observed(self):
        self.assertIsNone(jobs.eta_seconds(1, 100, 2))
        self.assertIsNone(jobs.eta_seconds(4, 100, 8))

    def test_estimate_extrapolates_the_observed_rate(self):
        # 10 episodes in 20s is 2s each; 90 remain.
        self.assertEqual(jobs.eta_seconds(10, 100, 20), 180)

    def test_no_estimate_once_the_run_is_done(self):
        self.assertIsNone(jobs.eta_seconds(100, 100, 200))

    def test_a_stalled_clock_cannot_produce_a_negative_estimate(self):
        self.assertIsNone(jobs.eta_seconds(10, 100, 0))


class JobPayloadTests(unittest.TestCase):
    def test_payload_carries_progress_and_no_dataset_content(self):
        started = datetime.utcnow() - timedelta(seconds=20)
        payload = jobs.job_payload(job_row(
            status="running", current_episode=10, total_episodes=100, started_at=started,
        ))
        self.assertEqual(payload["current"], 10)
        self.assertEqual(payload["total"], 100)
        self.assertIsNotNone(payload["eta_seconds"])
        # Nothing that could carry participant text or credentials.
        self.assertEqual(set(payload) & {"rows", "coded", "dataset", "api_key"}, set())
        # The result path is withheld while the run is still going.
        self.assertEqual(payload["result_path"], "")

    def test_the_result_path_is_released_only_once_the_run_completes(self):
        path = "/tmp/llm_coding_x/coded_results.csv"
        running = jobs.job_payload(job_row(status="running", result_path=path))
        done = jobs.job_payload(job_row(status="completed", result_path=path))
        failed = jobs.job_payload(job_row(status="failed", result_path=path))

        self.assertEqual(running["result_path"], "")
        self.assertEqual(failed["result_path"], "")
        # Needed by the normal results view to export and compute agreement, and
        # only reachable past the access-key check on the endpoint.
        self.assertEqual(done["result_path"], path)

    def test_finished_runs_report_no_estimate(self):
        payload = jobs.job_payload(job_row(
            status="completed", current_episode=100, total_episodes=100,
            started_at=datetime.utcnow() - timedelta(seconds=50),
            finished_at=datetime.utcnow(), result_path="/tmp/llm_coding_x/coded_results.csv",
        ))
        self.assertIsNone(payload["eta_seconds"])
        self.assertTrue(payload["has_results"])

    def test_results_are_not_offered_before_the_run_completes(self):
        payload = jobs.job_payload(job_row(
            status="failed", result_path="/tmp/llm_coding_x/coded_results.csv",
        ))
        self.assertFalse(payload["has_results"])


class CodedRowsTests(unittest.TestCase):
    """The run's page needs the coded rows to show the ordinary results view.
    They live beside the results on disk, never in the database."""

    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="llm_coding_")
        self.result_path = os.path.join(self.directory, "coded_results.csv")
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)

    def test_rows_survive_a_write_and_read(self):
        rows = [
            {"index": 0, "original": {"id": 1, "message": "hello"}, "coded": {"greeting": 1}},
            {"index": 1, "original": {"id": 2, "message": "bye"}, "coded": {"greeting": 0}},
        ]
        jobs._write_rows(self.result_path, rows)
        self.assertEqual(jobs.read_rows(self.result_path), rows)

    def test_rows_are_stored_beside_the_results_not_in_the_database(self):
        jobs._write_rows(self.result_path, [{"index": 0, "original": {}, "coded": {}}])
        self.assertTrue(os.path.isfile(os.path.join(self.directory, "rows.json")))

    def test_a_run_with_no_rows_writes_nothing(self):
        jobs._write_rows(self.result_path, [])
        self.assertFalse(os.path.exists(os.path.join(self.directory, "rows.json")))

    def test_missing_or_unreadable_rows_are_not_an_error(self):
        # The sweeper may have removed the directory; the page still has to load.
        self.assertEqual(jobs.read_rows(self.result_path), [])
        self.assertEqual(jobs.read_rows(""), [])
        with open(os.path.join(self.directory, "rows.json"), "w") as handle:
            handle.write("{not json")
        self.assertEqual(jobs.read_rows(self.result_path), [])

    def test_rows_are_capped_so_a_huge_run_cannot_exhaust_memory(self):
        self.assertLessEqual(jobs._MAX_KEPT_ROWS, 50000)


class MailerTests(unittest.TestCase):
    def test_no_link_without_a_public_url(self):
        with patch.object(settings, "public_base_url", ""):
            self.assertEqual(run_link("abc"), "")

    def test_link_points_at_the_runs_page(self):
        with patch.object(settings, "public_base_url", "https://example.org/"):
            self.assertEqual(run_link("abc"), "https://example.org/runs/abc")

    def test_mail_is_skipped_rather_than_failed_when_unconfigured(self):
        # A missing relay must not break a run: the results are on the server and
        # the link works regardless.
        with patch.object(settings, "smtp_host", ""):
            outcome = asyncio.run(send_run_finished("someone@example.org", "abc", "completed", 5, 5))
        self.assertEqual(outcome, "skipped")

    def test_mail_is_skipped_when_no_address_was_given(self):
        with patch.object(settings, "smtp_host", "smtp.example.org"), \
             patch.object(settings, "public_base_url", "https://example.org"):
            outcome = asyncio.run(send_run_finished("", "abc", "completed", 5, 5))
        self.assertEqual(outcome, "skipped")

    def test_a_relay_failure_is_reported_without_raising(self):
        def boom(_message):
            raise OSError("relay refused")

        with patch.object(settings, "smtp_host", "smtp.example.org"), \
             patch.object(settings, "public_base_url", "https://example.org"), \
             patch("app.mailer._send_sync", boom):
            outcome = asyncio.run(send_run_finished("someone@example.org", "abc", "completed", 5, 5))
        self.assertEqual(outcome, "failed")

    def test_the_start_message_hands_over_the_link_immediately(self):
        captured = {}

        def capture(message):
            captured["body"] = message.get_content()
            captured["subject"] = message["Subject"]

        with patch.object(settings, "smtp_host", "smtp.example.org"), \
             patch.object(settings, "public_base_url", "https://example.org"), \
             patch("app.mailer._send_sync", capture):
            outcome = asyncio.run(send_run_started("someone@example.org", "abc"))

        self.assertEqual(outcome, "sent")
        self.assertIn("started", captured["subject"].lower())
        # The point of the start message: they hold the link before anything can
        # go wrong with their connection.
        self.assertIn("https://example.org/runs/abc", captured["body"])
        self.assertIn(str(settings.run_link_ttl_hours), captured["body"])

    def test_both_messages_carry_the_access_key(self):
        for send, args in (
            (send_run_started, ("someone@example.org", "abc", "MWN24-MMY3M")),
            (send_run_finished, ("someone@example.org", "abc", "completed", 9, 10, "MWN24-MMY3M")),
        ):
            captured = {}
            with patch.object(settings, "smtp_host", "smtp.example.org"), \
                 patch.object(settings, "public_base_url", "https://example.org"), \
                 patch("app.mailer._send_sync", lambda m: captured.update(body=m.get_content())):
                self.assertEqual(asyncio.run(send(*args)), "sent")
            self.assertIn("MWN24-MMY3M", captured["body"], send.__name__)
            self.assertIn("https://example.org/runs/abc", captured["body"], send.__name__)

    def test_the_start_message_is_skipped_when_mail_is_unconfigured(self):
        with patch.object(settings, "smtp_host", ""):
            self.assertEqual(asyncio.run(send_run_started("someone@example.org", "abc")), "skipped")

    def test_a_relay_failure_at_start_does_not_raise(self):
        def boom(_message):
            raise OSError("relay refused")

        with patch.object(settings, "smtp_host", "smtp.example.org"), \
             patch.object(settings, "public_base_url", "https://example.org"), \
             patch("app.mailer._send_sync", boom):
            self.assertEqual(asyncio.run(send_run_started("someone@example.org", "abc")), "failed")

    def test_the_message_carries_a_link_and_never_the_results(self):
        captured = {}

        def capture(message):
            captured["body"] = message.get_content()
            captured["to"] = message["To"]
            captured["from"] = message["From"]

        with patch.object(settings, "smtp_host", "smtp.example.org"), \
             patch.object(settings, "public_base_url", "https://example.org"), \
             patch("app.mailer._send_sync", capture):
            outcome = asyncio.run(send_run_finished("someone@example.org", "abc", "completed", 9, 10))

        self.assertEqual(outcome, "sent")
        self.assertIn("https://example.org/runs/abc", captured["body"])
        self.assertIn("9 of 10 episodes", captured["body"])
        self.assertIn(settings.mail_from, captured["from"])
        self.assertIn(str(settings.run_link_ttl_hours), captured["body"])


if __name__ == "__main__":
    unittest.main()


class JobUsageTests(unittest.IsolatedAsyncioTestCase):
    """A run finished on the server must reach the usage dashboard like any other."""

    async def _run_job(self, updates, stop_after=None):
        written: list[dict] = []

        async def fake_write(**fields):
            written.append(fields)

        async def fake_updates(config, file_info):
            for i, update in enumerate(updates):
                if stop_after is not None and i == stop_after:
                    jobs.request_stop("tok")
                yield update

        async def no_save(job_id, **fields):
            return None

        with patch("app.usage._write", fake_write), \
                patch("app.routes.coding._coding_updates", fake_updates), \
                patch.object(jobs, "_save", no_save), \
                patch.object(jobs, "_write_rows", lambda *a: None), \
                patch.object(jobs, "_write_config", lambda *a: None):
            await jobs._run("job", "tok", {"runs_per_model": 3}, {}, "")
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        return written

    async def test_completed_job_is_recorded_with_every_coding(self):
        written = await self._run_job([
            {"type": "progress", "current": 9, "total": 9},
            {"type": "complete", "total_rows": 3, "coded_rows": 3, "codings": 18, "file_path": ""},
        ])
        self.assertEqual([w["event"] for w in written], ["run", "run_complete"])
        self.assertEqual(written[1]["status"], "completed")
        self.assertEqual(written[1]["episodes_coded"], 18)
        self.assertEqual(written[0]["run_id"], written[1]["run_id"])

    async def test_stopped_job_is_recorded_as_stopped(self):
        written = await self._run_job(
            [{"type": "progress", "current": 1, "total": 9}] * 3, stop_after=1,
        )
        self.assertEqual(written[-1]["event"], "run_complete")
        self.assertEqual(written[-1]["status"], "stopped")
