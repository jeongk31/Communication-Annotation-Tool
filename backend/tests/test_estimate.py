import os
import unittest
from datetime import datetime, timedelta

os.environ.setdefault("DATABASE_URL", "postgresql://test:test@127.0.0.1:5432/test")

from app import estimate


class TokenEstimateTests(unittest.TestCase):
    def test_longer_prompts_cost_more_input_tokens(self):
        short, _ = estimate.estimate_tokens("a" * 400, 2)
        long, _ = estimate.estimate_tokens("a" * 4000, 2)
        self.assertLess(short, long)
        self.assertAlmostEqual(short, 100, delta=1)

    def test_output_grows_with_the_number_of_coded_variables(self):
        _, one = estimate.estimate_tokens("prompt", 1)
        _, five = estimate.estimate_tokens("prompt", 5)
        self.assertLess(one, five)

    def test_an_empty_prompt_still_costs_something(self):
        input_tokens, _ = estimate.estimate_tokens("", 0)
        self.assertGreaterEqual(input_tokens, 1)


class EstimateShapeTests(unittest.TestCase):
    def test_calls_are_episodes_times_models_times_runs(self):
        result = estimate.build_estimate(
            episodes=120, models=2, runs_per_model=3, prompt="x" * 800,
            variable_count=2, seconds_each=2.5, measured=False,
        )
        self.assertEqual(result["calls"], 720)
        self.assertEqual(result["seconds"], 1800)
        self.assertFalse(result["timing_from_history"])

    def test_token_totals_scale_with_the_call_count(self):
        one = estimate.build_estimate(
            episodes=1, models=1, runs_per_model=1, prompt="x" * 800,
            variable_count=2, seconds_each=2, measured=True,
        )
        many = estimate.build_estimate(
            episodes=10, models=1, runs_per_model=1, prompt="x" * 800,
            variable_count=2, seconds_each=2, measured=True,
        )
        self.assertEqual(many["input_tokens"], one["input_tokens"] * 10)
        self.assertEqual(many["output_tokens"], one["output_tokens"] * 10)

    def test_a_dataset_with_no_episodes_asks_for_nothing(self):
        result = estimate.build_estimate(
            episodes=0, models=2, runs_per_model=3, prompt="x" * 100,
            variable_count=1, seconds_each=2, measured=False,
        )
        self.assertEqual(result["calls"], 0)
        self.assertEqual(result["input_tokens"], 0)
        self.assertEqual(result["seconds"], 0)

    def test_zero_runs_is_treated_as_one(self):
        result = estimate.build_estimate(
            episodes=5, models=1, runs_per_model=0, prompt="x",
            variable_count=1, seconds_each=1, measured=False,
        )
        self.assertEqual(result["runs_per_model"], 1)
        self.assertEqual(result["calls"], 5)

    def test_measured_timing_is_reported_as_such(self):
        result = estimate.build_estimate(
            episodes=5, models=1, runs_per_model=1, prompt="x",
            variable_count=1, seconds_each=4, measured=True,
        )
        self.assertTrue(result["timing_from_history"])
        self.assertEqual(result["seconds"], 20)


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    """Timing comes from this deployment's own completed runs, so it reflects the
    real providers and network rather than any published figure."""

    class _Rows:
        def __init__(self, rows):
            self._rows = rows

        def all(self):
            return self._rows

    class _Db:
        def __init__(self, rows, fail=False):
            self._rows = rows
            self._fail = fail

        async def execute(self, _query):
            if self._fail:
                raise RuntimeError("database unavailable")
            return HistoryTests._Rows(self._rows)

    def _job(self, seconds, units, models):
        start = datetime(2026, 10, 1, 12, 0, 0)
        return (start, start + timedelta(seconds=seconds), units, models)

    async def test_no_history_falls_back_and_says_so(self):
        rate, measured = await estimate.seconds_per_call(self._Db([]), ["gpt-4o-mini"])
        self.assertFalse(measured)
        self.assertEqual(rate, estimate._FALLBACK_SECONDS_PER_CALL)

    async def test_rate_is_taken_from_completed_runs(self):
        # 100 units in 300s is 3 seconds per call.
        db = self._Db([self._job(300, 100, ["gpt-4o-mini"])])
        rate, measured = await estimate.seconds_per_call(db, ["gpt-4o-mini"])
        self.assertTrue(measured)
        self.assertEqual(rate, 3.0)

    async def test_one_unusually_slow_run_does_not_dominate(self):
        db = self._Db([
            self._job(200, 100, ["m"]), self._job(300, 100, ["m"]),
            self._job(9000, 100, ["m"]),
        ])
        rate, _ = await estimate.seconds_per_call(db, ["m"])
        self.assertEqual(rate, 3.0)  # the median, not the mean

    async def test_runs_of_other_models_are_ignored_when_possible(self):
        db = self._Db([
            self._job(100, 100, ["fast-model"]),
            self._job(900, 100, ["slow-model"]),
        ])
        rate, _ = await estimate.seconds_per_call(db, ["slow-model"])
        self.assertEqual(rate, 9.0)

    async def test_a_database_failure_degrades_to_the_default(self):
        rate, measured = await estimate.seconds_per_call(self._Db([], fail=True), ["m"])
        self.assertFalse(measured)
        self.assertEqual(rate, estimate._FALLBACK_SECONDS_PER_CALL)


if __name__ == "__main__":
    unittest.main()
