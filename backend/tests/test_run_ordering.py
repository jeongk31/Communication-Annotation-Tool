import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd

os.environ.setdefault("DATABASE_URL", "postgresql://test:test@127.0.0.1:5432/test")

from app.services.coding_runner import run_coding

CODEBOOK = [{"label": "flag", "type": "binary", "aggregation": "mode"}]


class RunOrderingTests(unittest.IsolatedAsyncioTestCase):
    """Repeated runs sweep the whole dataset each time.

    Coding one episode N times in a row asks the same model the same question
    back-to-back, which is the least independent way to take repeated
    measurements. Going round the dataset instead separates the repeats, and
    leaves a partial run holding one complete pass rather than a finished prefix.
    """

    async def _collect(self, episodes: int, runs: int, models: int = 1):
        """Run with recording providers; return the call order and the updates."""
        order: list[tuple[str, str]] = []

        def make(label):
            async def complete(prompt, system_prompt="", params=None):
                # The message text identifies the episode in the prompt.
                episode = next(
                    (f"e{i}" for i in range(episodes) if f"episode {i} text" in prompt), "?"
                )
                order.append((episode, label))
                return {"response": '{"flag": 1}'}
            return SimpleNamespace(complete=complete)

        instances = [make(f"m{i}") for i in range(models)]
        slots = [
            {"provider": "openai", "model": f"test-model-{i}", "api_key": "k"}
            for i in range(models)
        ]

        with patch(
            "app.services.coding_runner._get_provider_instance",
            side_effect=lambda provider, model, key: instances[slots.index(
                next(s for s in slots if s["model"] == model)
            )],
        ):
            updates = [
                update
                async for update in run_coding(
                    df=pd.DataFrame([{"message": f"episode {i} text"} for i in range(episodes)]),
                    message_column="message",
                    experiment_instructions="",
                    coding_instructions="",
                    codebook=CODEBOOK,
                    model_slots=slots,
                    runs_per_model=runs,
                    max_retries=1,
                )
            ]
        return order, updates

    async def test_repeats_sweep_the_dataset_instead_of_repeating_one_episode(self):
        order, _ = await self._collect(episodes=5, runs=3)
        episodes = [episode for episode, _ in order]

        self.assertEqual(
            episodes,
            ["e0", "e1", "e2", "e3", "e4"] * 3,
            "expected three sweeps of the dataset, not each episode three times",
        )

    async def test_a_single_run_is_unchanged(self):
        order, _ = await self._collect(episodes=4, runs=1)
        self.assertEqual([episode for episode, _ in order], ["e0", "e1", "e2", "e3"])

    async def test_every_model_still_codes_every_episode_in_each_pass(self):
        order, _ = await self._collect(episodes=3, runs=2, models=2)
        # Both models are asked within the same pass over an episode, and the
        # whole dataset is swept twice.
        self.assertEqual(
            order,
            [("e0", "m0"), ("e0", "m1"), ("e1", "m0"), ("e1", "m1"), ("e2", "m0"), ("e2", "m1")] * 2,
        )

    async def test_progress_counts_every_pass_not_just_the_episodes(self):
        _, updates = await self._collect(episodes=5, runs=3)
        progress = [u for u in updates if u.get("type") == "progress"]

        # 5 episodes coded 3 times is 15 units of work, and the bar should say so.
        self.assertEqual(progress[-1]["total"], 15)
        self.assertEqual(progress[-1]["current"], 15)
        self.assertEqual(progress[-1]["percent"], 100.0)
        self.assertEqual([p["current"] for p in progress], list(range(1, 16)))

    async def test_each_episode_is_reported_once_with_every_run_aggregated(self):
        _, updates = await self._collect(episodes=5, runs=3)
        rows = [u for u in updates if u.get("type") == "row"]

        # One result per episode, not one per pass.
        self.assertEqual(len(rows), 5)
        self.assertEqual([r["index"] for r in rows], [0, 1, 2, 3, 4])
        # Every pass contributed to the aggregate.
        self.assertTrue(all(r["coded"].get("_votes") == 3 for r in rows))

    async def test_the_run_still_completes_with_one_result_per_episode(self):
        _, updates = await self._collect(episodes=5, runs=3)
        complete = next(u for u in updates if u.get("type") == "complete")

        self.assertEqual(complete["total_rows"], 5)
        self.assertEqual(complete["coded_rows"], 5)


if __name__ == "__main__":
    unittest.main()

    async def test_usage_counts_every_model_and_run(self):
        _, updates = await self._collect(episodes=3, runs=3, models=2)
        complete = updates[-1]
        self.assertEqual(complete["coded_rows"], 3)
        self.assertEqual(complete["codings"], 18)

    async def test_usage_counts_repeated_runs_of_one_model(self):
        _, updates = await self._collect(episodes=3, runs=5)
        self.assertEqual(updates[-1]["codings"], 15)
