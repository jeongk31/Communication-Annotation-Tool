import base64
import time

import anthropic

from app.services.providers.base import LLMProvider


class AnthropicProvider(LLMProvider):
    """Anthropic Claude API provider."""

    _PROVIDER_CONTROLLED_SAMPLING_MODELS = {
        "claude-fable-5-2",
        "claude-fable-5-1",
        "claude-fable-5",
        "claude-opus-5-5",
        "claude-opus-5",
        "claude-sonnet-5-5",
        "claude-sonnet-5",
        "claude-haiku-5-5",
    }

    async def complete(self, prompt: str, system_prompt: str = "", params: dict | None = None) -> dict:
        params = params or {}
        client = anthropic.AsyncAnthropic(api_key=self.api_key)

        request_params = {
            "model": self.model,
            "max_tokens": params.get("max_tokens", 2048),
            "system": system_prompt or "You are a helpful assistant.",
            "messages": [{"role": "user", "content": prompt}],
        }
        if self.model not in self._PROVIDER_CONTROLLED_SAMPLING_MODELS:
            if params.get("temperature") is not None:
                request_params["temperature"] = params["temperature"]
            elif params.get("top_p") is not None:
                request_params["top_p"] = params["top_p"]

        start = time.time()
        response = await client.messages.create(**request_params)

        response_text = "".join(
            block.text for block in response.content if getattr(block, "type", None) == "text"
        )

        return {
            "response": response_text,
            "tokens_used": (response.usage.input_tokens + response.usage.output_tokens) if response.usage else 0,
            "latency_ms": self._timed(start),
        }

    async def complete_with_pdf(
        self, prompt: str, pdf_bytes: bytes, system_prompt: str = "", params: dict | None = None
    ) -> dict:
        params = params or {}
        client = anthropic.AsyncAnthropic(api_key=self.api_key)
        b64 = base64.standard_b64encode(pdf_bytes).decode("utf-8")

        start = time.time()
        response = await client.messages.create(
            model=self.model,
            max_tokens=params.get("max_tokens", 8192),
            system=system_prompt or "You are a helpful assistant.",
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {"type": "base64", "media_type": "application/pdf", "data": b64},
                    },
                    {"type": "text", "text": prompt},
                ],
            }],
        )

        response_text = "".join(
            block.text for block in response.content if getattr(block, "type", None) == "text"
        )

        return {
            "response": response_text,
            "tokens_used": (response.usage.input_tokens + response.usage.output_tokens) if response.usage else 0,
            "latency_ms": self._timed(start),
        }
