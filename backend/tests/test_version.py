import unittest

from fastapi.testclient import TestClient

from app import __version__
from app.main import app


class VersionTests(unittest.TestCase):
    def test_api_and_health_endpoint_report_release_version(self):
        self.assertEqual(__version__, "1.4.6")
        self.assertEqual(app.version, __version__)

        client = TestClient(app)
        try:
            response = client.get("/")
        finally:
            client.close()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["version"], __version__)


if __name__ == "__main__":
    unittest.main()
