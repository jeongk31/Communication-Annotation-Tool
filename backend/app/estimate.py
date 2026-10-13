"""What a coding run will cost in time and tokens, before it is started.

A run is a sequence of paid calls that can take an hour, and until now the only
way to find out how long it would take or how much it would consume was to run
it. This estimates both from the work actually configured.

Deliberately makes no model call. The prompt is built exactly as the run will
build it, from the first real episode, so the token figure reflects the
researcher's own instructions, codebook and data rather than a guess at them.
Everything here is approximate and labelled as such in the interface.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from sqlalchemy import select

logger = logging.getLogger(__name__)

# Roughly four characters per token for English prose with the tokenizers these
# providers use. Good to within about 20%, which is the right order of accuracy
# for a figure shown as "approximate".
_CHARS_PER_TOKEN = 4.0

# A reply is a small JSON object: a little structural overhead plus a short
# value per coded variable.
_OUTPUT_TOKENS_BASE = 15
_OUTPUT_TOKENS_PER_VARIABLE = 8

# Used only until this deployment has timed runs of its own. Deliberately on the
# slow side: an estimate that runs under is more useful than one that runs over.
_FALLBACK_SECONDS_PER_CALL = 2.5

# Timings older than this say little about how the providers behave today.
_HISTORY_LIMIT = 40


async def seconds_per_call(db, models: list[str]) -> tuple[float, bool]:
    """Measured seconds per call for these models, and whether it is measured.

    Taken from this deployment's own completed runs rather than any published
    figure, so it reflects the real providers, prompts and network.
    """
    from app.models.database import CodingJob

    try:
        rows = (await db.execute(
            select(CodingJob.started_at, CodingJob.finished_at, CodingJob.total_episodes, CodingJob.models)
            .where(
                CodingJob.status == "completed",
                CodingJob.started_at.isnot(None),
                CodingJob.finished_at.isnot(None),
                CodingJob.total_episodes > 0,
            )
            .order_by(CodingJob.finished_at.desc())
            .limit(_HISTORY_LIMIT)
        )).all()
    except Exception:
        logger.warning("could not read run history for the estimate", exc_info=True)
        return _FALLBACK_SECONDS_PER_CALL, False

    wanted = {m for m in models if m}
    samples: list[float] = []
    for started, finished, units, job_models in rows:
        if not units or not isinstance(started, datetime) or not isinstance(finished, datetime):
            continue
        # Prefer runs that used one of the same models; fall back to all of them.
        if wanted and job_models and not (wanted & set(job_models)):
            continue
        elapsed = (finished - started).total_seconds()
        if elapsed > 0:
            samples.append(elapsed / units)

    if not samples:
        return _FALLBACK_SECONDS_PER_CALL, False
    samples.sort()
    return samples[len(samples) // 2], True  # median: one slow run should not dominate


def estimate_tokens(prompt: str, variable_count: int) -> tuple[int, int]:
    """Input and output tokens for a single call, from the real prompt."""
    input_tokens = max(1, round(len(prompt) / _CHARS_PER_TOKEN))
    output_tokens = _OUTPUT_TOKENS_BASE + _OUTPUT_TOKENS_PER_VARIABLE * max(0, variable_count)
    return input_tokens, output_tokens


def build_estimate(
    *,
    episodes: int,
    models: int,
    runs_per_model: int,
    prompt: str,
    variable_count: int,
    seconds_each: float,
    measured: bool,
) -> dict[str, Any]:
    """Assemble the figures the confirmation dialog shows."""
    runs = max(1, runs_per_model)
    calls = max(0, episodes) * max(1, models) * runs
    per_input, per_output = estimate_tokens(prompt, variable_count)
    return {
        "episodes": episodes,
        "models": models,
        "runs_per_model": runs,
        # Episodes times models times runs: every paid call the run will make.
        "calls": calls,
        "input_tokens": per_input * calls,
        "output_tokens": per_output * calls,
        "tokens_per_call": per_input + per_output,
        "seconds": round(calls * seconds_each),
        # False means the timing is a default rather than this deployment's own
        # history, which the dialog should say plainly.
        "timing_from_history": measured,
    }
