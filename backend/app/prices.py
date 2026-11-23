"""Published per-token prices, used only to estimate what a run will cost.

These are list prices in US dollars per million tokens, taken from each
provider's own pricing page on the date below. They change, so the figure is
always shown alongside that date and described as approximate — and a model with
no entry here produces no cost at all rather than a guessed one.

**When updating:** change PRICES_UPDATED in the same edit, or the interface will
quote a new price under an old date.
"""

from __future__ import annotations

import datetime as _dt

# The date these were last checked against the providers' pricing pages.
PRICES_UPDATED = "2026-11-23"

# model id -> (input $/1M tokens, output $/1M tokens)
#
# Standard (not batch / cached / priority) rates for an ordinary prompt: below
# each provider's long-context threshold, which CAT's prompts stay well under.
#
# Models absent from this table are not priced rather than estimated: a wrong
# number about somebody's own API bill is worse than no number.
PRICES: dict[str, tuple[float, float]] = {
    # OpenAI — developers.openai.com/api/docs/pricing. Prompts over 272K tokens
    # cost more.
    "gpt-6.2-astra": (8.00, 40.00),
    "gpt-6.2-sol": (2.00, 10.00),
    "gpt-6-astra": (10.00, 50.00),
    "gpt-6.1-sol": (2.00, 10.00),
    "gpt-6.1-terra": (1.00, 5.00),
    "gpt-6-luna": (0.10, 0.50),
    # GPT-5.6 Sol is on promotional pricing until 30 November 2026; the page
    # does not say what it becomes afterwards, so recheck it then.
    "gpt-5.6-sol": (4.00, 20.00),
    "gpt-5.6-terra": (2.00, 12.00),
    "gpt-5.6-luna": (0.20, 1.20),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4.1-mini": (0.40, 1.60),
    # Anthropic — platform.claude.com/docs/en/about-claude/pricing. Every model
    # here has its own row on that page; don't carry a rate across versions.
    "claude-fable-5-2": (8.00, 40.00),
    "claude-fable-5-1": (10.00, 50.00),
    "claude-fable-5": (10.00, 50.00),
    "claude-opus-5-5": (4.00, 20.00),
    "claude-opus-5": (5.00, 25.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-sonnet-5": (2.00, 10.00),
    # Haiku 5.5: rate for prompts up to 100K tokens; longer prompts cost 5x.
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-haiku-4-5-20251001": (1.00, 5.00),
    # Google — aistudio.google.com/docs/pricing. Introductory rates that end on a
    # published date are in PRICE_CHANGES below.
    "gemini-4-carbon": (2.00, 10.00),
    "gemini-4-neon": (3.00, 15.00),
    "gemini-4-hydrogen": (1.50, 7.50),
    "gemini-4-argon": (2.00, 10.00),
    "gemini-3.8-flash": (0.75, 3.75),
    "gemini-3.6-flash": (0.75, 3.75),
    "gemini-3.5-flash-lite": (0.30, 2.50),
    "gemini-3.1-flash-lite": (0.25, 1.50),
    "gemini-3.1-pro-preview": (2.00, 12.00),
    "gemini-3-flash-preview": (0.50, 3.00),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    # DeepSeek — api-docs.deepseek.com/quick_start/pricing. Off-peak rates; peak
    # hours (weekday 01:00-04:00 and 06:00-10:00 UTC) cost double.
    "deepseek-v4-pro": (0.66, 1.98),
    "deepseek-flash": (0.15, 0.60),
    # xAI — docs.x.ai/docs/pricing. Rates below a 200K-token prompt.
    "grok-4.7": (2.00, 6.00),
    "grok-4.6": (2.00, 6.00),
    "grok-4.5": (2.00, 6.00),
    "grok-4.3": (1.25, 2.50),
}

# Published rate changes: model id -> [(first day the rate applies, rate), ...],
# oldest first. A provider that announces "$X through <date>, then $Y" gets $X
# in PRICES and $Y here, so the quote turns over on the right day by itself.
PRICE_CHANGES: dict[str, list[tuple[str, tuple[float, float]]]] = {
    "gemini-4-carbon": [("2026-12-01", (4.00, 20.00))],
    "gemini-4-argon": [("2026-12-01", (4.00, 20.00))],
    "gemini-3.8-flash": [("2027-01-01", (1.50, 7.50))],
    "gemini-3.6-flash": [("2027-01-01", (1.50, 7.50))],
}


def price_for(model: str, today: _dt.date | None = None) -> tuple[float, float] | None:
    model = (model or "").strip()
    rate = PRICES.get(model)
    if rate is None:
        return None
    today = today or _dt.datetime.now(_dt.timezone.utc).date()
    for starts, later_rate in PRICE_CHANGES.get(model, []):
        if today >= _dt.date.fromisoformat(starts):
            rate = later_rate
    return rate


def cost_for(model: str, input_tokens: int, output_tokens: int) -> float | None:
    """Dollars for one model's share of a run, or None if it has no listed price."""
    rate = price_for(model)
    if rate is None:
        return None
    rate_in, rate_out = rate
    return (input_tokens / 1_000_000) * rate_in + (output_tokens / 1_000_000) * rate_out
