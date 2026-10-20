"""Server-side usage tracking for coding runs and package downloads.

The browser also reports analytics, but that path is best-effort and consent-gated:
a visitor who declines the analytics prompt, closes the tab mid-run, or sits behind
a filtering proxy produces no event at all. The admin dashboard therefore cannot use
it to answer "how many coding runs happened, and how many succeeded".

These helpers record the same lifecycle from the backend, where the outcome is known
with certainty (the server sees the run finish, fail, or be cut off). They record
operational metadata only: no IP address, no approximate location, no browser
identifier or user agent, no API keys, and no dataset content. Events carry
``source="server"`` so the dashboard can tell them apart from browser-reported ones
and merge the two by ``run_id`` instead of double-counting a run.

Writes are fire-and-forget: telemetry must never add latency to a coding run, fail a
request, or be lost because the client disconnected mid-stream.
"""

import asyncio
import logging
import re
import time
import uuid

logger = logging.getLogger(__name__)

# Fire-and-forget tasks are kept referenced until they finish; asyncio only holds a
# weak reference, so an un-stored task can be garbage-collected before it runs.
_pending: set[asyncio.Task] = set()

_MAX_ERROR_SAMPLES = 10
_ERROR_SAMPLE_CHARS = 300

# Provider errors quote the key that was rejected — OpenAI echoes a partly masked
# key, and a short or malformed key comes back in full. CAT promises never to store
# API keys, so scrub anything key-shaped before an error sample is persisted.
_KEY_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_*\-]{2,}", re.I),          # OpenAI / Anthropic style
    re.compile(r"\bAIza[A-Za-z0-9_\-]{4,}"),                # Google
    re.compile(r"\b(?:Bearer|api[_-]?key)\s*[:=]?\s*\S+", re.I),
)


def scrub_secrets(text: str) -> str:
    """Remove anything key-shaped from a message before it is stored or shown."""
    for pattern in _KEY_PATTERNS:
        text = pattern.sub("[redacted]", text)
    return text


def _spawn(coro) -> None:
    try:
        task = asyncio.create_task(coro)
    except RuntimeError:  # no running loop (e.g. called from a sync test)
        coro.close()
        return
    _pending.add(task)
    task.add_done_callback(_pending.discard)


async def _write(**fields) -> None:
    """Persist one UsageEvent. Never raises: telemetry is not worth a 500."""
    from app.models.database import AsyncSessionLocal, UsageEvent

    try:
        async with AsyncSessionLocal() as db:
            db.add(UsageEvent(source="server", **fields))
            await db.commit()
    except Exception:
        logger.warning("usage tracking failed for event %r", fields.get("event"), exc_info=True)


def _int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _run_config_fields(config: dict) -> dict:
    """Pull the dashboard's run metadata out of a run-stream config.

    Mirrors what the browser reports for a "run" event, minus anything that
    identifies the visitor. API keys live in ``model_slots`` and are never read here.
    """
    slots = config.get("model_slots") if isinstance(config.get("model_slots"), list) else []
    providers, models = [], []
    for slot in slots:
        if isinstance(slot, dict):
            providers.append(str(slot.get("provider", ""))[:40])
            models.append(str(slot.get("model", ""))[:80])
    codebook = config.get("codebook") if isinstance(config.get("codebook"), list) else []
    labelled = [e for e in codebook if isinstance(e, dict) and str(e.get("label", "")).strip()]
    return {
        "providers": providers[:20],
        "models": models[:20],
        "num_models": len(slots),
        "runs_per_model": _int(config.get("runs_per_model"), 1),
        "aggregation": "per-variable",
        "num_variables": len(labelled),
        "per_sender": any(str(e.get("level", "")) == "sender" for e in labelled),
    }


class RunTracker:
    """Records one in-interface coding run: its start and its true outcome."""

    def __init__(self, config: dict, session_id: str = ""):
        # Reuse the browser's run id when it sends one, so the server event and the
        # (consent-gated) browser event describe one run rather than two.
        client_run_id = str(config.get("client_run_id") or "")[:64]
        self.run_id = client_run_id or uuid.uuid4().hex
        self.session_id = str(session_id or "")[:64]
        self._fields = _run_config_fields(config)
        self._started_at = 0.0
        self.completed = False
        self.stopped = False
        self.episodes_coded = 0
        self.total_episodes = 0
        self.error_count = 0
        self.error_samples: list[str] = []

    @property
    def started(self) -> bool:
        return bool(self._started_at)

    def start(self) -> None:
        self._started_at = time.monotonic()
        _spawn(_write(
            event="run",
            status="started",
            run_id=self.run_id,
            session_id=self.session_id,
            **self._fields,
        ))

    def observe(self, update: dict) -> None:
        """Watch the stream's own progress events; no extra work for the run."""
        kind = update.get("type")
        if kind == "error":
            self.note_error(update.get("message", ""))
        elif kind == "complete":
            self.completed = True
            # Usage counts every coding — an episode coded by two models over three
            # runs is six — not the distinct episodes in the dataset.
            self.episodes_coded = _int(update.get("codings", update.get("coded_rows")))
            self.total_episodes = _int(update.get("total_rows"))

    def note_error(self, message) -> None:
        self.error_count += 1
        if len(self.error_samples) < _MAX_ERROR_SAMPLES:
            self.error_samples.append(scrub_secrets(str(message))[:_ERROR_SAMPLE_CHARS])

    def finish(self) -> None:
        # "completed" has to mean the run produced coded episodes. A run whose every
        # provider call failed still reaches the end of the stream, and counting that
        # as a success is exactly what made the dashboard untrustworthy.
        if self.stopped and not self.completed:
            status = "stopped"
        elif self.completed and (self.episodes_coded > 0 or not self.error_count):
            status = "completed"
        else:
            status = "failed"
        duration_ms = int((time.monotonic() - self._started_at) * 1000) if self._started_at else 0
        _spawn(_write(
            event="run_complete",
            status=status,
            run_id=self.run_id,
            session_id=self.session_id,
            episodes_coded=self.episodes_coded,
            num_episodes=self.total_episodes,
            error_count=self.error_count,
            error_sample=self.error_samples,
            duration_ms=duration_ms,
            **self._fields,
        ))


def track_package_download(req) -> None:
    """Count one generated-script package download (the offline path)."""
    slots = req.model_slots if isinstance(getattr(req, "model_slots", None), list) else []
    providers = [str(s.get("provider", ""))[:40] for s in slots if isinstance(s, dict)]
    models = [str(s.get("model", ""))[:80] for s in slots if isinstance(s, dict)]
    if not providers:
        providers = [str(getattr(req, "provider", ""))[:40]]
        models = [str(getattr(req, "model", ""))[:80]]
    labelled = [e for e in (getattr(req, "codebook", None) or []) if str(getattr(e, "label", "")).strip()]
    _spawn(_write(
        event="package_download",
        status="downloaded",
        run_id=uuid.uuid4().hex,
        providers=providers[:20],
        models=models[:20],
        num_models=len(slots) or 1,
        num_variables=len(labelled),
        num_rows=len(req.source_rows) if getattr(req, "source_rows", None) else 0,
        per_sender=any(str(getattr(e, "level", "")) == "sender" for e in labelled),
    ))
