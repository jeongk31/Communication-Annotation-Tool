"""Published per-token prices, used only to estimate what a run will cost.

These are list prices in US dollars per million tokens, taken from each
provider's own pricing page on the date below. They change, so the figure is
always shown alongside that date and described as approximate — and a model with
no entry here produces no cost at all rather than a guessed one.

**When updating:** change PRICES_UPDATED in the same edit, or the interface will
quote a new price under an old date.
"""

from __future__ import annotations

# The date these were last checked against the providers' pricing pages.
PRICES_UPDATED = "2026-10-13"

# model id -> (input $/1M tokens, output $/1M tokens)
#
# Models absent from this table are not priced rather than estimated: a wrong
# number about somebody's own API bill is worse than no number.
PRICES: dict[str, tuple[float, float]] = {
    # OpenAI — developers.openai.com/api/docs/pricing
    "gpt-6-astra": (10.00, 50.00),
    "gpt-6.1-sol": (2.00, 10.00),
    "gpt-6-luna": (0.10, 0.50),
    "gpt-5.6-sol": (4.00, 20.00),
    "gpt-5.6-terra": (2.00, 12.00),
    "gpt-5.6-luna": (0.20, 1.20),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1-nano": (0.10, 0.40),
    # Anthropic. claude-opus-5 and claude-fable-5 are deliberately absent: the
    # rates published are for later revisions of those models, and guessing
    # across a version boundary is how a quote goes wrong.
    "claude-fable-5-1": (10.00, 50.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-haiku-4-5-20251001": (1.00, 5.00),
    # Google — ai.google.dev/gemini-api/docs/pricing. The 3.8/3.6 Flash rates are
    # promotional until 31 December 2026, after which they roughly double.
    "gemini-3.8-flash": (0.75, 3.75),
    "gemini-3.6-flash": (0.75, 3.75),
    "gemini-3.5-flash-lite": (0.30, 2.50),
    "gemini-3.1-flash-lite": (0.25, 1.50),
    "gemini-3.1-pro-preview": (2.00, 12.00),
    "gemini-2.5-pro": (1.25, 10.00),
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    # DeepSeek — off-peak rates; peak hours are roughly double.
    "deepseek-v4-pro": (0.66, 1.98),
    "deepseek-v4-flash": (0.15, 0.60),
    # xAI — docs.x.ai. Rates below a 200K-token prompt.
    "grok-4.7": (2.00, 6.00),
    "grok-4.6": (2.00, 6.00),
}


def price_for(model: str) -> tuple[float, float] | None:
    return PRICES.get((model or "").strip())


def cost_for(model: str, input_tokens: int, output_tokens: int) -> float | None:
    """Dollars for one model's share of a run, or None if it has no listed price."""
    rate = price_for(model)
    if rate is None:
        return None
    rate_in, rate_out = rate
    return (input_tokens / 1_000_000) * rate_in + (output_tokens / 1_000_000) * rate_out
