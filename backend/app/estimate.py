"""What a coding run will cost in time, tokens and money, before it is started.

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

from app import prices

logger = logging.getLogger(__name__)

# Roughly four characters per token for English prose with the tokenizers these
# providers use. Good to within about 20%, which is the right order of accuracy
# for a figure shown as "approximate".
_CHARS_PER_TOKEN = 4.0

# A reply is a small JSON object: a little structural overhead plus a short
# value per coded variable.
_OUTPUT_TOKENS_BASE = 15
_OUTPUT_TOKENS_PER_VARIABLE = 8

# Seconds for one unit of work — one episode on one pass, across however many
# models are coding it concurrently. Used only until this deployment has timed
# runs of its own. Deliberately on the slow side: an estimate that runs under is
# more useful than one that runs over.
_FALLBACK_SECONDS_PER_UNIT = 2.5

# Timings older than this say little about how the providers behave today.
_HISTORY_LIMIT = 40


async def seconds_per_unit(db, models: list[str]) -> tuple[float, bool]:
    """Measured seconds per unit of work for these models, and whether measured.

    A unit is one episode on one pass. ``total_episodes`` on a job counts units,
    not calls, which is the right basis now that the models in a run code each
    episode concurrently: adding a model does not lengthen a unit.

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
        return _FALLBACK_SECONDS_PER_UNIT, False

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
        return _FALLBACK_SECONDS_PER_UNIT, False
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
    models: list[str],
    runs_per_model: int,
    prompt: str,
    variable_count: int,
    seconds_each: float,
    measured: bool,
) -> dict[str, Any]:
    """Assemble the figures the confirmation dialog shows.

    Cost is priced per model, because the models in one run can differ in price
    by a factor of a hundred. A model with no published rate on file is left out
    of the total and named instead, so the figure is never quietly short.
    """
    runs = max(1, runs_per_model)
    slots = [m for m in models] or [""]
    # A unit of work is one episode on one pass. Every model codes it at the
    # same time, so adding a model adds calls and cost but little wall-clock —
    # which is why time is priced per unit and money per call.
    work_units = max(0, episodes) * runs
    calls = work_units * len(slots)
    per_input, per_output = estimate_tokens(prompt, variable_count)

    priced: list[dict[str, Any]] = []
    unpriced: list[str] = []
    for model in slots:
        cost = prices.cost_for(model, per_input * work_units, per_output * work_units)
        if cost is None:
            unpriced.append(model)
        else:
            priced.append({"model": model, "cost_usd": round(cost, 4)})

    return {
        "episodes": episodes,
        "models": len(slots),
        "runs_per_model": runs,
        # Episodes times models times runs: every paid call the run will make.
        "calls": calls,
        "input_tokens": per_input * calls,
        "output_tokens": per_output * calls,
        "tokens_per_call": per_input + per_output,
        # Units, not calls: the models in a run work concurrently.
        "seconds": round(work_units * seconds_each),
        # False means the timing is a default rather than this deployment's own
        # history, which the dialog should say plainly.
        "timing_from_history": measured,
        # None rather than 0 when nothing could be priced: the dialog must not
        # show "$0.00" for a run that will certainly be billed.
        "cost_usd": round(sum(p["cost_usd"] for p in priced), 4) if priced else None,
        "cost_by_model": priced,
        # Named so the dialog can say whose share is missing from the total.
        "unpriced_models": [m for m in unpriced if m],
        "prices_updated": prices.PRICES_UPDATED,
    }
