import asyncio
import unittest
from unittest.mock import patch

from app.usage import RunTracker, _run_config_fields, scrub_secrets


class RunConfigFieldsTests(unittest.TestCase):
    def test_reads_run_metadata_without_touching_api_keys(self):
        fields = _run_config_fields({
            "model_slots": [
                {"provider": "openai", "model": "gpt-4o-mini", "api_key": "sk-secret"},
                {"provider": "anthropic", "model": "claude-sonnet-4-5", "api_key": "sk-other"},
            ],
            "runs_per_model": 3,
            "codebook": [
                {"label": "greeting", "type": "binary", "level": "episode"},
                {"label": "", "type": "binary"},  # unfinished row, not a variable
                {"label": "tone", "type": "numeric", "level": "sender"},
            ],
        })
        self.assertEqual(fields["providers"], ["openai", "anthropic"])
        self.assertEqual(fields["models"], ["gpt-4o-mini", "claude-sonnet-4-5"])
        self.assertEqual(fields["num_models"], 2)
        self.assertEqual(fields["runs_per_model"], 3)
        self.assertEqual(fields["num_variables"], 2)
        self.assertTrue(fields["per_sender"])
        self.assertNotIn("sk-secret", str(fields))


class ScrubSecretsTests(unittest.TestCase):
    """CAT promises never to store API keys. Provider 401s quote the rejected key —
    fully when it is short or malformed — so error samples must be scrubbed."""

    def test_removes_provider_keys_from_error_text(self):
        for message, secret in [
            ("Incorrect API key provided: sk-bad. See the docs.", "sk-bad"),
            ("Incorrect API key provided: sk-proj-abc****wxyz.", "sk-proj-abc"),
            ("Invalid key AIzaSyA1b2C3d4E5f6G7h8 for Gemini", "AIzaSyA1b2C3d4E5f6G7h8"),
            ("Authorization: Bearer abc123def456", "abc123def456"),
        ]:
            scrubbed = scrub_secrets(message)
            self.assertNotIn(secret, scrubbed, message)
            self.assertIn("[redacted]", scrubbed)

    def test_keeps_ordinary_error_text_readable(self):
        message = "Row 3 [openai/gpt-4o-mini]: connection timed out after 60s"
        self.assertEqual(scrub_secrets(message), message)

    def test_tracked_error_samples_are_scrubbed(self):
        tracker = RunTracker({})
        tracker.note_error("Incorrect API key provided: sk-bad.")
        self.assertNotIn("sk-bad", tracker.error_samples[0])


class RunTrackerTests(unittest.TestCase):
    """The server is the one reporter that cannot be lost to a declined consent
    prompt or a closed tab, so its record of the outcome must be right."""

    def _run(self, drive) -> list[dict]:
        written: list[dict] = []

        async def fake_write(**fields):
            written.append(fields)

        async def main():
            with patch("app.usage._write", fake_write):
                await drive()
                # let the fire-and-forget writes run
                await asyncio.sleep(0)
                await asyncio.sleep(0)

        asyncio.run(main())
        return written

    def test_completed_run_records_episode_counts(self):
        tracker = RunTracker({"model_slots": [{"provider": "openai", "model": "gpt-4o-mini"}]})

        async def drive():
            tracker.start()
            tracker.observe({"type": "progress", "current": 1, "total": 2})
            tracker.observe({"type": "complete", "total_rows": 10, "coded_rows": 9})
            tracker.finish()

        written = self._run(drive)
        self.assertEqual([w["event"] for w in written], ["run", "run_complete"])
        self.assertEqual(written[0]["status"], "started")
        self.assertEqual(written[1]["status"], "completed")
        self.assertEqual(written[1]["episodes_coded"], 9)
        self.assertEqual(written[1]["num_episodes"], 10)
        self.assertEqual(written[0]["run_id"], written[1]["run_id"])

    def test_counts_every_coding_rather_than_distinct_episodes(self):
        tracker = RunTracker({})

        async def drive():
            tracker.start()
            tracker.observe({"type": "complete", "total_rows": 3, "coded_rows": 3, "codings": 18})
            tracker.finish()

        written = self._run(drive)
        self.assertEqual(written[1]["episodes_coded"], 18)
        self.assertEqual(written[1]["num_episodes"], 3)

    def test_run_without_a_complete_event_is_failed_and_keeps_errors(self):
        tracker = RunTracker({})

        async def drive():
            tracker.start()
            tracker.observe({"type": "error", "index": 0, "message": "Row 1: 401 invalid key"})
            tracker.finish()

        written = self._run(drive)
        self.assertEqual(written[1]["status"], "failed")
        self.assertEqual(written[1]["error_count"], 1)
        self.assertEqual(written[1]["error_sample"], ["Row 1: 401 invalid key"])

    def test_run_that_coded_nothing_is_not_a_success(self):
        # Every provider call failed (a bad API key); the stream still reaches
        # "complete", but nothing was coded.
        tracker = RunTracker({})

        async def drive():
            tracker.start()
            tracker.observe({"type": "error", "message": "Row 1: 401 invalid key"})
            tracker.observe({"type": "error", "message": "Row 2: 401 invalid key"})
            tracker.observe({"type": "complete", "total_rows": 2, "coded_rows": 0})
            tracker.finish()

        written = self._run(drive)
        self.assertEqual(written[1]["status"], "failed")
        self.assertEqual(written[1]["error_count"], 2)

    def test_partly_coded_run_still_counts_as_completed(self):
        tracker = RunTracker({})

        async def drive():
            tracker.start()
            tracker.observe({"type": "error", "message": "Row 2 timed out"})
            tracker.observe({"type": "complete", "total_rows": 2, "coded_rows": 1})
            tracker.finish()

        self.assertEqual(self._run(drive)[1]["status"], "completed")

    def test_disconnected_run_is_stopped(self):
        tracker = RunTracker({})

        async def drive():
            tracker.start()
            tracker.stopped = True
            tracker.finish()

        self.assertEqual(self._run(drive)[1]["status"], "stopped")

    def test_reuses_the_browser_run_id_so_reports_merge(self):
        tracker = RunTracker({"client_run_id": "abc-123"})
        self.assertEqual(tracker.run_id, "abc-123")

    def test_generates_its_own_id_when_the_browser_sends_none(self):
        self.assertTrue(RunTracker({"client_run_id": None}).run_id)


if __name__ == "__main__":
    unittest.main()
