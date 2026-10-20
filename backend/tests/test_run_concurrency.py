import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd

os.environ.setdefault("DATABASE_URL", "postgresql://test:test@127.0.0.1:5432/test")

from app.services.coding_runner import run_coding

CODEBOOK = [{"label": "flag", "type": "binary", "aggregation": "mode"}]


def _frame(episodes: int) -> pd.DataFrame:
    return pd.DataFrame([{"message": f"episode {i} text"} for i in range(episodes)])


def _slots(models: int) -> list[dict[str, str]]:
    return [
        {"provider": "openai", "model": f"test-model-{i}", "api_key": "k"}
        for i in range(models)
    ]


async def _run(df, slots, runs, instances, max_retries=1):
    """Drive run_coding with the given fake providers and collect its updates."""
    by_model = {slot["model"]: inst for slot, inst in zip(slots, instances)}
    with patch(
        "app.services.coding_runner._get_provider_instance",
        side_effect=lambda provider, model, key: by_model[model],
    ):
        return [
            update
            async for update in run_coding(
                df=df,
                message_column="message",
                experiment_instructions="",
                coding_instructions="",
                codebook=CODEBOOK,
                model_slots=slots,
                runs_per_model=runs,
                max_retries=max_retries,
            )
        ]


class ConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    """Different models code an episode at once; one model's repeats do not.

    Coding is almost entirely waiting on someone else's API, so asking three
    providers one after another wastes most of the run. Repeats of a single
    model stay sequential: they are independent measurements of the same
    episode, and firing them together would both correlate them and pile onto
    one provider's rate limit.
    """

    def _counting_provider(self, state, label, delay=0):
        """A provider that records how many calls are in flight alongside it."""
        async def complete(prompt, system_prompt="", params=None):
            state["live"] += 1
            state["peak"] = max(state["peak"], state["live"])
            state["order"].append(label)
            try:
                # Yield control so a genuinely concurrent sibling can be seen.
                await asyncio.sleep(delay)
                return {"response": '{"flag": 1}'}
            finally:
                state["live"] -= 1
        return SimpleNamespace(complete=complete)

    async def test_two_models_code_the_same_episode_at_the_same_time(self):
        """Proven with a barrier: sequential execution could never get past it.

        Each model waits until both have arrived, so this test deadlocks (and
        times out) if the calls are made one after the other.
        """
        barrier = asyncio.Barrier(2)

        def provider():
            async def complete(prompt, system_prompt="", params=None):
                await barrier.wait()
                return {"response": '{"flag": 1}'}
            return SimpleNamespace(complete=complete)

        slots = _slots(2)
        updates = await asyncio.wait_for(
            _run(_frame(2), slots, runs=1, instances=[provider(), provider()]),
            timeout=5,
        )
        self.assertEqual(next(u for u in updates if u["type"] == "complete")["coded_rows"], 2)

    async def test_repeated_runs_of_one_model_never_overlap(self):
        state = {"live": 0, "peak": 0, "order": []}
        slots = _slots(1)
        await _run(_frame(3), slots, runs=4, instances=[self._counting_provider(state, "m0")])

        self.assertEqual(state["peak"], 1, "a model must not be asked twice at once")
        self.assertEqual(len(state["order"]), 12)

    async def test_concurrency_is_bounded_by_the_number_of_models(self):
        """Passes stay sequential, so 2 models over 3 runs is 2 at a time, not 6."""
        state = {"live": 0, "peak": 0, "order": []}
        slots = _slots(2)
        instances = [self._counting_provider(state, f"m{i}") for i in range(2)]
        await _run(_frame(3), slots, runs=3, instances=instances)

        self.assertEqual(state["peak"], 2)
        self.assertEqual(len(state["order"]), 18)  # 3 episodes x 2 models x 3 runs

    async def test_a_slow_model_does_not_hold_back_a_fast_one(self):
        state = {"live": 0, "peak": 0, "order": []}
        slots = _slots(2)
        instances = [
            self._counting_provider(state, "slow", delay=0.05),
            self._counting_provider(state, "fast", delay=0),
        ]
        await _run(_frame(1), slots, runs=1, instances=instances)

        self.assertEqual(state["peak"], 2, "the fast model should start before the slow one finishes")

    async def test_one_model_failing_does_not_cancel_the_others(self):
        """A provider outage must cost its own column, not the whole run."""
        async def broken(prompt, system_prompt="", params=None):
            raise RuntimeError("provider is down")

        async def working(prompt, system_prompt="", params=None):
            return {"response": '{"flag": 1}'}

        slots = _slots(2)
        updates = await _run(
            _frame(2), slots, runs=1,
            instances=[SimpleNamespace(complete=broken), SimpleNamespace(complete=working)],
        )

        errors = [u for u in updates if u["type"] == "error"]
        self.assertEqual(len(errors), 2, "the failing model should report once per episode")
        self.assertTrue(all("provider is down" in u["message"] for u in errors))
        # The working model still coded every episode.
        complete = next(u for u in updates if u["type"] == "complete")
        self.assertEqual(complete["coded_rows"], 2)

    async def test_results_are_recorded_in_slot_order_not_answer_order(self):
        """The artifact must not depend on which provider happened to be quicker."""
        def provider(value, delay):
            async def complete(prompt, system_prompt="", params=None):
                await asyncio.sleep(delay)
                return {"response": '{"flag": %d}' % value}
            return SimpleNamespace(complete=complete)

        slots = _slots(2)
        # The second slot answers first; the record should still lead with slot one.
        updates = await _run(_frame(1), slots, runs=1,
                             instances=[provider(1, 0.05), provider(0, 0)])

        rows = [u for u in updates if u["type"] == "row"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["coded"]["_votes"], 2)


if __name__ == "__main__":
    unittest.main()
