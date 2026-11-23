import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routes import instructions


class InstructionPdfModelTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(instructions.router, prefix="/api")
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()

    def test_pdf_catalog_contains_only_current_supported_models(self):
        self.assertEqual(
            instructions.PDF_CAPABLE_MODELS,
            {
                "openai": {
                    "gpt-6.2-astra",
                    "gpt-6.2-sol",
                    "gpt-6-astra",
                    "gpt-6.1-sol",
                    "gpt-6.1-terra",
                    "gpt-6-luna",
                    "gpt-5.6-sol",
                    "gpt-5.6-terra",
                    "gpt-5.6-luna",
                    "gpt-4.1",
                },
                "gemini": {
                    "gemini-4-carbon",
                    "gemini-4-neon",
                    "gemini-4-argon",
                    "gemini-4-hydrogen",
                    "gemini-3.8-flash",
                    "gemini-3.6-flash",
                    "gemini-3.5-flash-lite",
                    "gemini-3.1-flash-lite",
                    "gemini-3.1-pro-preview",
                    "gemini-3-flash-preview",
                    "gemini-2.5-flash-lite",
                },
                "anthropic": {
                    "claude-fable-5-2",
                    "claude-fable-5-1",
                    "claude-fable-5",
                    "claude-opus-5-5",
                    "claude-opus-5",
                    "claude-sonnet-5-5",
                    "claude-sonnet-5",
                    "claude-haiku-5-5",
                    "claude-haiku-4-5-20251001",
                },
            },
        )

    def test_stale_pdf_model_is_rejected_before_provider_call(self):
        with patch.object(instructions, "_get_provider_instance") as get_provider:
            response = self.client.post(
                "/api/instructions/convert-pdf",
                data={"provider": "openai", "model": "gpt-4o", "api_key": "test-key"},
                files={"file": ("instructions.pdf", b"%PDF", "application/pdf")},
            )

        self.assertEqual(response.status_code, 400)
        self.assertIn("not available for PDF conversion", response.json()["detail"])
        get_provider.assert_not_called()

    def test_current_pdf_model_is_accepted(self):
        provider = SimpleNamespace(
            complete_with_pdf=AsyncMock(
                return_value={"response": "Converted instructions", "tokens_used": 3}
            )
        )
        with patch.object(instructions, "_get_provider_instance", return_value=provider):
            response = self.client.post(
                "/api/instructions/convert-pdf",
                data={"provider": "gemini", "model": "gemini-3.8-flash", "api_key": "test-key"},
                files={"file": ("instructions.pdf", b"%PDF", "application/pdf")},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"text": "Converted instructions", "tokens_used": 3})


if __name__ == "__main__":
    unittest.main()
