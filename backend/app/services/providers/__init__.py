from app.services.providers.base import LLMProvider
from app.services.providers.openai_provider import OpenAICompatibleProvider
from app.services.providers.anthropic_provider import AnthropicProvider
from app.services.providers.gemini_provider import GeminiProvider


# Maps user-facing model ID -> (provider_class, api_model_name, base_url or None)
PROVIDER_REGISTRY: dict[str, tuple[type[LLMProvider], str, str | None]] = {
    # OpenAI
    "gpt-6.2-astra":    (OpenAICompatibleProvider, "gpt-6.2-astra", None),
    "gpt-6.2-sol":      (OpenAICompatibleProvider, "gpt-6.2-sol", None),
    "gpt-6-astra":      (OpenAICompatibleProvider, "gpt-6-astra", None),
    "gpt-6.1-sol":      (OpenAICompatibleProvider, "gpt-6.1-sol", None),
    "gpt-6.1-terra":    (OpenAICompatibleProvider, "gpt-6.1-terra", None),
    "gpt-6-luna":       (OpenAICompatibleProvider, "gpt-6-luna", None),
    "gpt-5.6-sol":      (OpenAICompatibleProvider, "gpt-5.6-sol", None),
    "gpt-5.6-terra":    (OpenAICompatibleProvider, "gpt-5.6-terra", None),
    "gpt-5.6-luna":     (OpenAICompatibleProvider, "gpt-5.6-luna", None),
    "gpt-4.1":          (OpenAICompatibleProvider, "gpt-4.1", None),
    "gpt-4.1-mini":     (OpenAICompatibleProvider, "gpt-4.1-mini", None),
    # Anthropic
    "claude-fable-5-2": (AnthropicProvider, "claude-fable-5-2", None),
    "claude-fable-5-1": (AnthropicProvider, "claude-fable-5-1", None),
    "claude-fable-5":   (AnthropicProvider, "claude-fable-5", None),
    "claude-opus-5-5":  (AnthropicProvider, "claude-opus-5-5", None),
    "claude-opus-5":    (AnthropicProvider, "claude-opus-5", None),
    "claude-sonnet-5-5": (AnthropicProvider, "claude-sonnet-5-5", None),
    "claude-sonnet-5":  (AnthropicProvider, "claude-sonnet-5", None),
    "claude-haiku-5-5": (AnthropicProvider, "claude-haiku-5-5", None),
    "claude-haiku-4-5-20251001": (AnthropicProvider, "claude-haiku-4-5-20251001", None),
    # Google
    "gemini-4-carbon":       (GeminiProvider, "gemini-4-carbon", None),
    "gemini-4-neon":         (GeminiProvider, "gemini-4-neon", None),
    "gemini-4-argon":        (GeminiProvider, "gemini-4-argon", None),
    "gemini-4-hydrogen":     (GeminiProvider, "gemini-4-hydrogen", None),
    "gemini-3.8-flash":      (GeminiProvider, "gemini-3.8-flash", None),
    "gemini-3.6-flash":      (GeminiProvider, "gemini-3.6-flash", None),
    "gemini-3.5-flash-lite": (GeminiProvider, "gemini-3.5-flash-lite", None),
    "gemini-3.1-flash-lite": (GeminiProvider, "gemini-3.1-flash-lite", None),
    "gemini-3.1-pro-preview": (GeminiProvider, "gemini-3.1-pro-preview", None),
    "gemini-3-flash-preview": (GeminiProvider, "gemini-3-flash-preview", None),
    "gemini-2.5-flash-lite": (GeminiProvider, "gemini-2.5-flash-lite", None),
    # DeepSeek — OpenAI-compatible
    "deepseek-v4-pro":  (OpenAICompatibleProvider, "deepseek-v4-pro", "https://api.deepseek.com"),
    "deepseek-flash":   (OpenAICompatibleProvider, "deepseek-flash", "https://api.deepseek.com"),
    # xAI (Grok) — OpenAI-compatible
    "grok-4.7":         (OpenAICompatibleProvider, "grok-4.7", "https://api.x.ai/v1"),
    "grok-4.6":         (OpenAICompatibleProvider, "grok-4.6", "https://api.x.ai/v1"),
    "grok-4.5":         (OpenAICompatibleProvider, "grok-4.5", "https://api.x.ai/v1"),
    "grok-4.3":         (OpenAICompatibleProvider, "grok-4.3", "https://api.x.ai/v1"),
}


def get_provider(model_id: str, api_key: str) -> LLMProvider:
    if model_id not in PROVIDER_REGISTRY:
        raise ValueError(f"Unknown model '{model_id}'. Available: {', '.join(sorted(PROVIDER_REGISTRY))}")

    provider_cls, api_model_name, base_url = PROVIDER_REGISTRY[model_id]
    return provider_cls(api_key=api_key, model=api_model_name, base_url=base_url)
