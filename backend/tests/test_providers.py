import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pandas as pd

from app.services.coding_runner import _get_provider_instance, run_coding
from app.services.providers.anthropic_provider import AnthropicProvider
from app.services.providers.openai_provider import OpenAICompatibleProvider
from app.services.providers import PROVIDER_REGISTRY, get_provider


class ProviderSelectionTests(unittest.TestCase):
    def test_xai_uses_openai_compatible_provider_and_official_endpoint(self):
        provider = _get_provider_instance("xai", "grok-4.5", "test-key")

        self.assertIsInstance(provider, OpenAICompatibleProvider)
        self.assertEqual(provider.model, "grok-4.5")
        self.assertEqual(provider.base_url, "https://api.x.ai/v1")

    def test_anthropic_uses_native_provider(self):
        provider = _get_provider_instance("anthropic", "claude-sonnet-5", "test-key")

        self.assertIsInstance(provider, AnthropicProvider)
        self.assertEqual(provider.model, "claude-sonnet-5")

    def test_auxiliary_provider_registry_matches_public_catalog(self):
        expected_models = {
            "gpt-6.2-astra", "gpt-6.2-sol", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra",
            "gpt-6-luna",
            "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
            "gpt-4.1", "gpt-4.1-mini",
            "gemini-4-carbon", "gemini-4-neon", "gemini-4-argon", "gemini-4-hydrogen",
            "gemini-3.8-flash", "gemini-3.6-flash",
            "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
            "gemini-3.1-pro-preview", "gemini-3-flash-preview",
            "gemini-2.5-flash-lite",
            "deepseek-v4-pro", "deepseek-flash",
            "claude-fable-5-2", "claude-fable-5-1", "claude-fable-5",
            "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-sonnet-5",
            "claude-haiku-5-5",
            "claude-haiku-4-5-20251001", "grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3",
        }
        self.assertEqual(set(PROVIDER_REGISTRY), expected_models)

        claude = get_provider("claude-sonnet-5", "test-key")
        grok = get_provider("grok-4.3", "test-key")

        self.assertIsInstance(claude, AnthropicProvider)
        self.assertIsInstance(grok, OpenAICompatibleProvider)
        self.assertEqual(grok.base_url, "https://api.x.ai/v1")


class AnthropicParameterTests(unittest.IsolatedAsyncioTestCase):
    async def test_claude_5_models_omit_provider_controlled_sampling_parameters(self):
        create = AsyncMock(return_value=SimpleNamespace(
            content=[SimpleNamespace(type="text", text='{"ok": true}')],
            usage=SimpleNamespace(input_tokens=1, output_tokens=2),
        ))
        fake_client = SimpleNamespace(messages=SimpleNamespace(create=create))

        with patch("app.services.providers.anthropic_provider.anthropic.AsyncAnthropic", return_value=fake_client):
            for model in ("claude-fable-5-2", "claude-fable-5", "claude-opus-5-5", "claude-opus-5",
                          "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5"):
                with self.subTest(model=model):
                    create.reset_mock()
                    provider = AnthropicProvider("test-key", model)
                    await provider.complete(
                        "prompt", params={"temperature": 0.2, "top_p": 0.8, "max_tokens": 50}
                    )

                    request = create.await_args.kwargs
                    self.assertNotIn("temperature", request)
                    self.assertNotIn("top_p", request)
                    self.assertEqual(request["max_tokens"], 50)

    async def test_haiku_45_sends_only_one_sampling_parameter(self):
        create = AsyncMock(return_value=SimpleNamespace(
            content=[SimpleNamespace(type="text", text='{"ok": true}')],
            usage=SimpleNamespace(input_tokens=1, output_tokens=2),
        ))
        fake_client = SimpleNamespace(messages=SimpleNamespace(create=create))

        with patch("app.services.providers.anthropic_provider.anthropic.AsyncAnthropic", return_value=fake_client):
            provider = AnthropicProvider("test-key", "claude-haiku-4-5-20251001")
            await provider.complete("prompt", params={"temperature": 0.2, "top_p": 0.8})

        request = create.await_args.kwargs
        self.assertEqual(request["temperature"], 0.2)
        self.assertNotIn("top_p", request)

    async def test_pdf_response_uses_text_block_when_thinking_block_comes_first(self):
        create = AsyncMock(return_value=SimpleNamespace(
            content=[
                SimpleNamespace(type="thinking", thinking="internal"),
                SimpleNamespace(type="text", text="converted instructions"),
            ],
            usage=SimpleNamespace(input_tokens=1, output_tokens=2),
        ))
        fake_client = SimpleNamespace(messages=SimpleNamespace(create=create))

        with patch("app.services.providers.anthropic_provider.anthropic.AsyncAnthropic", return_value=fake_client):
            provider = AnthropicProvider("test-key", "claude-sonnet-5")
            result = await provider.complete_with_pdf("prompt", b"%PDF")

        self.assertEqual(result["response"], "converted instructions")


class OpenAICompatibleParameterTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _fake_client(create):
        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))

    @staticmethod
    def _response():
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": true}'))],
            usage=SimpleNamespace(total_tokens=3),
        )

    async def test_gpt_41_preserves_explicit_zero_sampling_values(self):
        create = AsyncMock(return_value=self._response())
        with patch(
            "app.services.providers.openai_provider.AsyncOpenAI",
            return_value=self._fake_client(create),
        ):
            provider = OpenAICompatibleProvider("test-key", "gpt-4.1")
            await provider.complete(
                "prompt", params={"temperature": 0, "top_p": 0, "max_tokens": 50}
            )

        request = create.await_args.kwargs
        self.assertEqual(request["temperature"], 0)
        self.assertEqual(request["top_p"], 0)
        self.assertEqual(request["max_tokens"], 50)

    async def test_gpt_56_omits_sampling_and_uses_completion_token_parameter(self):
        create = AsyncMock(return_value=self._response())
        with patch(
            "app.services.providers.openai_provider.AsyncOpenAI",
            return_value=self._fake_client(create),
        ):
            provider = OpenAICompatibleProvider("test-key", "gpt-5.6-sol")
            await provider.complete(
                "prompt", params={"temperature": 0.2, "top_p": 0.8, "max_tokens": 50}
            )

        request = create.await_args.kwargs
        self.assertNotIn("temperature", request)
        self.assertNotIn("top_p", request)
        self.assertNotIn("max_tokens", request)
        self.assertEqual(request["max_completion_tokens"], 50)

    async def test_deepseek_v4_omits_sampling_and_uses_max_tokens(self):
        create = AsyncMock(return_value=self._response())
        with patch(
            "app.services.providers.openai_provider.AsyncOpenAI",
            return_value=self._fake_client(create),
        ):
            provider = OpenAICompatibleProvider(
                "test-key", "deepseek-flash", base_url="https://api.deepseek.com"
            )
            await provider.complete(
                "prompt", params={"temperature": 0.2, "top_p": 0.8, "max_tokens": 50}
            )

        request = create.await_args.kwargs
        self.assertNotIn("temperature", request)
        self.assertNotIn("top_p", request)
        self.assertEqual(request["max_tokens"], 50)


class CodingRunnerParameterTests(unittest.IsolatedAsyncioTestCase):
    async def _run_with_slot(self, slot):
        provider = SimpleNamespace(complete=AsyncMock(return_value={"response": '{"flag": 1}'}))
        with patch("app.services.coding_runner._get_provider_instance", return_value=provider):
            updates = [
                update
                async for update in run_coding(
                    df=pd.DataFrame([{"message": "hello"}]),
                    message_column="message",
                    experiment_instructions="",
                    coding_instructions="",
                    codebook=[{"label": "flag", "type": "binary", "aggregation": "mode"}],
                    model_slots=[{
                        "provider": "openai",
                        "model": "test-model",
                        "api_key": "test-key",
                        **slot,
                    }],
                    max_retries=1,
                )
            ]
        self.assertTrue(any(update.get("type") == "complete" for update in updates))
        return provider.complete.await_args.kwargs["params"]

    async def test_explicit_zero_sampling_values_reach_provider(self):
        params = await self._run_with_slot({
            "temperature": 0,
            "top_p": 0,
            "max_tokens": 64,
            "generation_config": {"temperature": 0.7, "topP": 0.8, "maxOutputTokens": 128},
        })

        self.assertEqual(params, {"temperature": 0, "top_p": 0, "max_tokens": 64})

    async def test_omitted_sampling_values_use_provider_defaults(self):
        params = await self._run_with_slot({})

        self.assertEqual(params, {"temperature": 0.1, "top_p": 1.0, "max_tokens": 2048})


class CodingRunnerAggregationTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_calls_stream_wide_nontext_aggregates_without_text(self):
        provider = SimpleNamespace(complete=AsyncMock(side_effect=[
            {"response": '{"option": "a", "score": 1, "note": "first"}'},
            {"response": '{"option": "b", "score": 2, "note": "second"}'},
        ]))
        codebook = [
            {
                "label": "option",
                "type": "categorical",
                "aggregation": "mode",
                "values": [{"value": "a"}, {"value": "b"}],
            },
            {"label": "score", "type": "numeric", "aggregation": "mode"},
            {"label": "note", "type": "text", "aggregation": "mode"},
        ]

        with patch("app.services.coding_runner._get_provider_instance", return_value=provider):
            updates = [
                update
                async for update in run_coding(
                    df=pd.DataFrame([{"message": "hello"}]),
                    message_column="message",
                    experiment_instructions="",
                    coding_instructions="",
                    codebook=codebook,
                    model_slots=[{"provider": "openai", "model": "test-model", "api_key": "test-key"}],
                    runs_per_model=2,
                    max_retries=1,
                )
            ]

        row = next(update for update in updates if update.get("type") == "row")
        self.assertEqual(row["coded"]["option_a"], 0.5)
        self.assertEqual(row["coded"]["option_b"], 0.5)
        self.assertEqual(row["coded"]["score"], 1.5)
        self.assertNotIn("note", row["coded"])

    async def test_single_call_streams_original_values_including_text(self):
        provider = SimpleNamespace(complete=AsyncMock(return_value={
            "response": '{"option": "a", "score": 1, "note": "unchanged"}'
        }))
        codebook = [
            {
                "label": "option",
                "type": "categorical",
                "aggregation": "mode",
                "values": [{"value": "a"}, {"value": "b"}],
            },
            {"label": "score", "type": "numeric", "aggregation": "mode"},
            {"label": "note", "type": "text", "aggregation": "mode"},
        ]

        with patch("app.services.coding_runner._get_provider_instance", return_value=provider):
            updates = [
                update
                async for update in run_coding(
                    df=pd.DataFrame([{"message": "hello"}]),
                    message_column="message",
                    experiment_instructions="",
                    coding_instructions="",
                    codebook=codebook,
                    model_slots=[{"provider": "openai", "model": "test-model", "api_key": "test-key"}],
                    runs_per_model=1,
                    max_retries=1,
                )
            ]

        row = next(update for update in updates if update.get("type") == "row")
        self.assertEqual(
            row["coded"],
            {"option": "a", "score": 1, "note": "unchanged"},
        )


if __name__ == "__main__":
    unittest.main()
