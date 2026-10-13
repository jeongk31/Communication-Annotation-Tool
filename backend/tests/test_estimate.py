import os
import unittest
from datetime import datetime, timedelta

os.environ.setdefault("DATABASE_URL", "postgresql://test:test@127.0.0.1:5432/test")

from app import estimate, prices


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
            episodes=120, models=["gpt-4.1", "claude-sonnet-5"], runs_per_model=3, prompt="x" * 800,
            variable_count=2, seconds_each=2.5, measured=False,
        )
        self.assertEqual(result["calls"], 720)
        self.assertEqual(result["seconds"], 1800)
        self.assertFalse(result["timing_from_history"])

    def test_token_totals_scale_with_the_call_count(self):
        one = estimate.build_estimate(
            episodes=1, models=["gpt-4.1"], runs_per_model=1, prompt="x" * 800,
            variable_count=2, seconds_each=2, measured=True,
        )
        many = estimate.build_estimate(
            episodes=10, models=["gpt-4.1"], runs_per_model=1, prompt="x" * 800,
            variable_count=2, seconds_each=2, measured=True,
        )
        self.assertEqual(many["input_tokens"], one["input_tokens"] * 10)
        self.assertEqual(many["output_tokens"], one["output_tokens"] * 10)

    def test_a_dataset_with_no_episodes_asks_for_nothing(self):
        result = estimate.build_estimate(
            episodes=0, models=["gpt-4.1", "gpt-4.1-mini"], runs_per_model=3, prompt="x" * 100,
            variable_count=1, seconds_each=2, measured=False,
        )
        self.assertEqual(result["calls"], 0)
        self.assertEqual(result["input_tokens"], 0)
        self.assertEqual(result["seconds"], 0)

    def test_zero_runs_is_treated_as_one(self):
        result = estimate.build_estimate(
            episodes=5, models=["gpt-4.1"], runs_per_model=0, prompt="x",
            variable_count=1, seconds_each=1, measured=False,
        )
        self.assertEqual(result["runs_per_model"], 1)
        self.assertEqual(result["calls"], 5)

    def test_measured_timing_is_reported_as_such(self):
        result = estimate.build_estimate(
            episodes=5, models=["gpt-4.1"], runs_per_model=1, prompt="x",
            variable_count=1, seconds_each=4, measured=True,
        )
        self.assertTrue(result["timing_from_history"])
        self.assertEqual(result["seconds"], 20)


class CostTests(unittest.TestCase):
    """Money comes from a table of published rates, never from a guess.

    The researcher pays this bill to their own provider, so a figure that is
    quietly wrong is worse than no figure: an unpriced model is named instead of
    being counted as free.
    """

    def _estimate(self, models, **kwargs):
        return estimate.build_estimate(
            episodes=kwargs.pop("episodes", 100), models=models,
            runs_per_model=kwargs.pop("runs_per_model", 1), prompt="x" * 4000,
            variable_count=2, seconds_each=2, measured=True, **kwargs,
        )

    def test_cost_is_priced_from_the_published_rate(self):
        result = self._estimate(["gpt-4.1"], episodes=1000)
        # 1000 calls x 1000 input tokens at $2/1M, plus 31 output tokens at $8/1M.
        expected = (1_000_000 / 1e6) * 2.00 + (31_000 / 1e6) * 8.00
        self.assertAlmostEqual(result["cost_usd"], expected, places=4)
        self.assertEqual(result["unpriced_models"], [])

    def test_each_model_is_priced_at_its_own_rate(self):
        cheap = self._estimate(["gpt-4.1-nano"])["cost_usd"]
        dear = self._estimate(["gpt-6-astra"])["cost_usd"]
        self.assertGreater(dear, cheap * 50)

    def test_a_mixed_run_adds_the_models_together(self):
        both = self._estimate(["gpt-4.1", "gpt-4.1-nano"])
        alone = self._estimate(["gpt-4.1"])["cost_usd"]
        nano = self._estimate(["gpt-4.1-nano"])["cost_usd"]
        self.assertAlmostEqual(both["cost_usd"], alone + nano, places=4)

    def test_repeat_runs_multiply_the_cost(self):
        one = self._estimate(["gpt-4.1"], runs_per_model=1)["cost_usd"]
        three = self._estimate(["gpt-4.1"], runs_per_model=3)["cost_usd"]
        self.assertAlmostEqual(three, one * 3, places=4)

    def test_an_unpriced_model_is_named_rather_than_counted_as_free(self):
        result = self._estimate(["gpt-4.1", "model-nobody-has-priced"])
        self.assertEqual(result["unpriced_models"], ["model-nobody-has-priced"])
        # The total covers only the model we can actually price.
        self.assertAlmostEqual(result["cost_usd"], self._estimate(["gpt-4.1"])["cost_usd"], places=4)

    def test_no_priced_model_gives_no_cost_at_all(self):
        result = self._estimate(["mystery-model"])
        self.assertIsNone(result["cost_usd"], "an unknown model must not be quoted as $0.00")

    def test_the_date_of_the_rates_is_always_reported(self):
        self.assertEqual(self._estimate(["gpt-4.1"])["prices_updated"], prices.PRICES_UPDATED)

    def test_every_model_offered_in_the_interface_is_either_priced_or_known_absent(self):
        """A model the interface offers should normally have a rate on file.

        This is a reminder to price new models when they are added, not a hard
        rule: the exceptions are listed so that adding one is a deliberate act.
        """
        from app.services.providers import PROVIDER_REGISTRY

        unpriced = set(PROVIDER_REGISTRY) - set(prices.PRICES)
        self.assertEqual(
            unpriced,
            {"claude-opus-5", "claude-fable-5", "gemini-3.7-flash", "gemini-3.5-flash",
             "gemini-3-flash-preview", "grok-4.5", "grok-4.3"},
            "a model was added or removed without revisiting app/prices.py",
        )

    def test_no_price_is_zero_or_negative(self):
        for model, (rate_in, rate_out) in prices.PRICES.items():
            self.assertGreater(rate_in, 0, model)
            self.assertGreater(rate_out, 0, model)


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
