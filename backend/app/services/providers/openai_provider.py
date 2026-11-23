import base64
import time

from openai import AsyncOpenAI

from app.services.providers.base import LLMProvider


class OpenAICompatibleProvider(LLMProvider):
    """Works with OpenAI, xAI, and DeepSeek through OpenAI-compatible APIs."""

    _PROVIDER_CONTROLLED_SAMPLING_MODELS = {
        "gpt-6.2-astra",
        "gpt-6.2-sol",
        "gpt-6-astra",
        "gpt-6.1-sol",
        "gpt-6.1-terra",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "deepseek-v4-pro",
        "deepseek-flash",
    }
    _MAX_COMPLETION_TOKEN_MODELS = {
        "gpt-6.2-astra", "gpt-6.2-sol", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna",
        "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    }

    async def complete(self, prompt: str, system_prompt: str = "", params: dict | None = None) -> dict:
        params = params or {}
        client = AsyncOpenAI(api_key=self.api_key, base_url=self.base_url)

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        request_params = {"model": self.model, "messages": messages}
        if self.model not in self._PROVIDER_CONTROLLED_SAMPLING_MODELS:
            request_params["temperature"] = params.get("temperature", 0.7)
            request_params["top_p"] = params.get("top_p", 1.0)

        token_parameter = (
            "max_completion_tokens" if self.model in self._MAX_COMPLETION_TOKEN_MODELS else "max_tokens"
        )
        request_params[token_parameter] = params.get("max_tokens", 2048)

        start = time.time()
        response = await client.chat.completions.create(**request_params)

        return {
            "response": response.choices[0].message.content or "",
            "tokens_used": response.usage.total_tokens if response.usage else 0,
            "latency_ms": self._timed(start),
        }

    async def complete_with_pdf(
        self, prompt: str, pdf_bytes: bytes, system_prompt: str = "", params: dict | None = None
    ) -> dict:
        params = params or {}
        client = AsyncOpenAI(api_key=self.api_key, base_url=self.base_url)
        b64 = base64.standard_b64encode(pdf_bytes).decode("utf-8")

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({
            "role": "user",
            "content": [
                {
                    "type": "file",
                    "file": {"filename": "instructions.pdf", "file_data": f"data:application/pdf;base64,{b64}"},
                },
                {"type": "text", "text": prompt},
            ],
        })

        request_params = {"model": self.model, "messages": messages}
        token_parameter = (
            "max_completion_tokens" if self.model in self._MAX_COMPLETION_TOKEN_MODELS else "max_tokens"
        )
        request_params[token_parameter] = params.get("max_tokens", 8192)

        start = time.time()
        response = await client.chat.completions.create(**request_params)

        return {
            "response": response.choices[0].message.content or "",
            "tokens_used": response.usage.total_tokens if response.usage else 0,
            "latency_ms": self._timed(start),
        }
