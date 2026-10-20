import asyncio
import io
import json
import math
import uuid
import os
import shutil
import tempfile
import time
import re
import zipfile
from dataclasses import dataclass
from typing import Any, Literal

import pandas as pd
from urllib.parse import unquote

from fastapi import APIRouter, UploadFile, File, HTTPException, WebSocket, WebSocketDisconnect, Request, Depends
from fastapi.responses import StreamingResponse, Response, JSONResponse, FileResponse
from pydantic import BaseModel, Field

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.database import get_db
from app.ratelimit import limiter
from app.streaming import with_keepalive
from app.usage import RunTracker, track_package_download
from app import estimate as estimate_mod
from app import jobs
from app.services.script_generator import generate_coding_script
from app.services.coding_runner import (
    DETAIL_EPISODE_INDEX_COLUMN,
    aggregate_output_labels,
    aggregate_results,
    expanded_codebook_specs,
    run_coding,
)
# The estimate must measure the prompt the run will actually send, not a copy of it.
from app.services.coding_runner import _build_prompt as build_coding_prompt
from app.services.result_exporter import (
    build_result_frames,
    dataframe_to_csv,
    expanded_codebook_labels,
    prepare_coding_dataset,
    validate_sender_configuration,
)
from app.services.agreement import (
    agreement_report_frame,
    build_inter_coder_agreement,
)

router = APIRouter()

# In-memory store for uploaded files (file_id → {path, filename, created})
# This is only a cache. New uploads are also recorded in a deterministic temp
# directory so another worker (or a restarted process sharing the same temp
# filesystem) can recover the mapping safely.
_uploaded_files: dict[str, dict] = {}

# Temp files live under the system temp dir with these prefixes.
_TEMP_PREFIXES = ("llm_upload_", "llm_coding_")
_TEMP_TTL_SECONDS = 24 * 60 * 60  # delete working files after 24 hours
_UPLOAD_MAX_FUTURE_SKEW_SECONDS = 5 * 60
_UPLOAD_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_UPLOAD_METADATA_FILENAME = ".chat-upload.json"


@dataclass(frozen=True)
class UploadResolutionError(Exception):
    """A stable, user-actionable upload lookup failure."""

    status_code: int
    code: str
    detail: str

    def __str__(self) -> str:
        return self.detail


def _select_source_rows(df: "pd.DataFrame", source_rows: Any) -> "pd.DataFrame":
    """Slice a dataset to a subset of source rows selected in Step 1.

    ``source_rows`` is a list of 0-based row positions into the uploaded dataset.
    Positions are de-duplicated and sorted ascending so the original row order —
    and therefore episode grouping — is preserved. Out-of-range positions are
    ignored; an empty or non-list selection is rejected.
    """
    if not isinstance(source_rows, list):
        raise ValueError("Row selection must be a list of row positions.")
    valid = sorted({
        int(i)
        for i in source_rows
        if isinstance(i, int) and not isinstance(i, bool) and 0 <= int(i) < len(df)
    })
    if not valid:
        raise ValueError("The selected rows are outside the dataset. Please adjust the row selection.")
    return df.iloc[valid].reset_index(drop=True)


def _upload_dir_for_id(file_id: str) -> str | None:
    """Return the deterministic upload directory for a well-formed ID."""
    if not isinstance(file_id, str) or not _UPLOAD_ID_RE.fullmatch(file_id):
        return None
    return os.path.join(tempfile.gettempdir(), f"llm_upload_{file_id}")


def _upload_error_response(
    exc: UploadResolutionError,
    *,
    include_ok: bool = False,
) -> JSONResponse:
    # Preserve the established string-valued ``detail`` while adding a stable
    # machine-readable code for clients that can offer automatic recovery.
    content = {"detail": exc.detail, "code": exc.code}
    if include_ok:
        content["ok"] = False
    return JSONResponse(
        status_code=exc.status_code,
        content=content,
        headers={
            "Cache-Control": "no-store",
            "X-CAT-Error-Code": exc.code,
        },
    )


def _store_uploaded_file(content: bytes, filename: str, ext: str) -> tuple[str, dict]:
    """Persist a new upload with recoverable metadata and return its cache entry."""
    file_id = uuid.uuid4().hex
    tmp_dir = _upload_dir_for_id(file_id)
    if tmp_dir is None:  # uuid4().hex is always valid; guard future changes.
        raise RuntimeError("Could not allocate an upload identifier")

    safe_name = os.path.basename((filename or "upload").replace("\\", "/")) or "upload"
    stored_filename = f"dataset.{ext}"
    tmp_path = os.path.join(tmp_dir, stored_filename)
    created = time.time()

    os.mkdir(tmp_dir, 0o700)
    try:
        with open(tmp_path, "xb") as f:
            f.write(content)

        metadata = {
            "version": 1,
            "file_id": file_id,
            "filename": safe_name,
            "stored_filename": stored_filename,
            "created": created,
        }
        metadata_tmp = os.path.join(tmp_dir, _UPLOAD_METADATA_FILENAME + ".tmp")
        metadata_path = os.path.join(tmp_dir, _UPLOAD_METADATA_FILENAME)
        with open(metadata_tmp, "x", encoding="utf-8") as f:
            json.dump(metadata, f, ensure_ascii=False)
        os.replace(metadata_tmp, metadata_path)
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise

    info = {"path": os.path.realpath(tmp_path), "filename": safe_name, "created": created}
    _uploaded_files[file_id] = info
    return file_id, info


def _resolve_legacy_cached_upload(file_id: str, now: float) -> dict | None:
    """Validate a pre-migration cache entry created by the older random-dir code."""
    info = _uploaded_files.get(file_id)
    if not info:
        return None
    created = info.get("created")
    path = info.get("path")
    try:
        created = float(created)
    except (TypeError, ValueError):
        created = 0.0
    cached_dir = _temp_dir_for(path) if path else None
    deterministic_dir = _upload_dir_for_id(file_id)
    if (
        cached_dir
        and deterministic_dir
        and os.path.realpath(cached_dir) == os.path.realpath(deterministic_dir)
    ):
        # A new-format upload without its metadata is not a legacy upload. Do
        # not let a stale per-process cache bypass metadata validation.
        _uploaded_files.pop(file_id, None)
        return None
    if not math.isfinite(created) or created > now + _UPLOAD_MAX_FUTURE_SKEW_SECONDS:
        _cleanup_file_id(file_id)
        raise UploadResolutionError(
            410, "UPLOAD_GONE", "Uploaded dataset metadata is unavailable. Please re-upload it."
        )
    if now - created >= _TEMP_TTL_SECONDS:
        _cleanup_file_id(file_id)
        raise UploadResolutionError(
            410, "UPLOAD_EXPIRED", "Upload expired after 24 hours. Please re-upload the dataset."
        )
    if not path or _temp_dir_for(path) is None or not os.path.isfile(path):
        _uploaded_files.pop(file_id, None)
        raise UploadResolutionError(
            410, "UPLOAD_GONE", "Uploaded dataset is no longer available. Please re-upload it."
        )
    return {"path": path, "filename": info.get("filename") or "upload", "created": created}


def resolve_uploaded_file(file_id: str, *, now: float | None = None) -> dict:
    """Resolve and validate an upload from shared temp metadata.

    New uploads live in ``<tmp>/llm_upload_<file_id>`` with a small metadata
    record. This makes the opaque ID recoverable after a process restart and
    across workers that share the same temp filesystem, without extending the
    24-hour data-retention window.
    """
    upload_dir = _upload_dir_for_id(file_id)
    if upload_dir is None:
        raise UploadResolutionError(
            404,
            "UPLOAD_NOT_FOUND",
            "Upload not found. Please re-upload the dataset.",
        )

    current_time = time.time() if now is None else now
    metadata_path = os.path.join(upload_dir, _UPLOAD_METADATA_FILENAME)

    if (
        not os.path.isdir(upload_dir)
        or os.path.islink(upload_dir)
        or not os.path.isfile(metadata_path)
        or os.path.islink(metadata_path)
    ):
        legacy = _resolve_legacy_cached_upload(file_id, current_time)
        if legacy is not None:
            return legacy
        if os.path.isdir(upload_dir) and not os.path.islink(upload_dir):
            _remove_temp_dir(upload_dir)
        # A syntactically valid ID may have existed in a previous process or on
        # an ephemeral filesystem. Treat it as gone rather than malformed.
        raise UploadResolutionError(
            410, "UPLOAD_GONE", "Uploaded dataset is no longer available. Please re-upload it."
        )

    try:
        with open(metadata_path, encoding="utf-8") as f:
            metadata = json.load(f)
        if metadata.get("file_id") != file_id:
            raise ValueError("metadata ID mismatch")
        created = float(metadata["created"])
        if (
            not math.isfinite(created)
            or created > current_time + _UPLOAD_MAX_FUTURE_SKEW_SECONDS
        ):
            raise ValueError("invalid upload creation time")
        stored_filename = str(metadata["stored_filename"])
        display_filename = str(metadata.get("filename") or "upload")
        if (
            os.path.basename(stored_filename) != stored_filename
            or stored_filename == _UPLOAD_METADATA_FILENAME
        ):
            raise ValueError("unsafe stored filename")
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        _uploaded_files.pop(file_id, None)
        _remove_temp_dir(upload_dir)
        raise UploadResolutionError(
            410, "UPLOAD_GONE", "Uploaded dataset metadata is unavailable. Please re-upload it."
        )

    if current_time - created >= _TEMP_TTL_SECONDS:
        _uploaded_files.pop(file_id, None)
        _remove_temp_dir(upload_dir)
        raise UploadResolutionError(
            410, "UPLOAD_EXPIRED", "Upload expired after 24 hours. Please re-upload the dataset."
        )

    upload_dir_real = os.path.realpath(upload_dir)
    file_path = os.path.realpath(os.path.join(upload_dir, stored_filename))
    if (
        not file_path.startswith(upload_dir_real + os.sep)
        or not os.path.isfile(file_path)
    ):
        _uploaded_files.pop(file_id, None)
        _remove_temp_dir(upload_dir)
        raise UploadResolutionError(
            410, "UPLOAD_GONE", "Uploaded dataset is no longer available. Please re-upload it."
        )

    info = {"path": file_path, "filename": display_filename, "created": created}
    _uploaded_files[file_id] = info
    return info


def _temp_dir_for(path: str) -> str | None:
    """Return the top-level CAT temp dir a path belongs to, or None if it isn't one.

    Guards the cleanup endpoint so it can only ever delete our own temp dirs,
    never an arbitrary path.
    """
    if not path:
        return None
    real = os.path.realpath(path)
    tmp_root = os.path.realpath(tempfile.gettempdir())
    if real != tmp_root and not real.startswith(tmp_root + os.sep):
        return None
    rel = os.path.relpath(real, tmp_root)
    top = rel.split(os.sep)[0]
    if top and any(top.startswith(p) for p in _TEMP_PREFIXES):
        return os.path.join(tmp_root, top)
    return None


def _remove_temp_dir(path: str) -> None:
    d = _temp_dir_for(path)
    if d and os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)


def _resolve_coding_result_path(path: str) -> str:
    """Resolve only CAT's canonical server-side detailed-results artifact."""

    real = os.path.realpath(path)
    result_dir = _temp_dir_for(real)
    expected_file = (
        os.path.realpath(os.path.join(result_dir, "coded_results.csv"))
        if result_dir
        else None
    )
    if (
        not result_dir
        or not os.path.basename(result_dir).startswith("llm_coding_")
        or real != expected_file
    ):
        raise HTTPException(403, "Invalid path")
    if not os.path.isfile(real):
        raise HTTPException(404, "File not found")
    return real


def _validate_selective_rerun_artifact(path: str) -> str:
    """Ensure an earlier detailed artifact can support episode replacement."""

    real = _resolve_coding_result_path(path)
    try:
        columns = pd.read_csv(real, nrows=0).columns
    except Exception as exc:
        raise ValueError("The previous detailed-results artifact could not be read.") from exc
    if DETAIL_EPISODE_INDEX_COLUMN not in columns:
        raise ValueError(
            "The previous detailed-results artifact cannot be updated by episode. "
            "Re-run all episodes once to create a replaceable detailed archive."
        )
    return real


def _merge_selective_rerun_artifact(
    previous_path: str,
    replacement_path: str,
    episode_indices: list[int],
) -> str:
    """Replace affected episode records while retaining every unaffected call."""

    previous_real = _validate_selective_rerun_artifact(previous_path)
    replacement_real = _resolve_coding_result_path(replacement_path)
    previous = pd.read_csv(previous_real)
    replacement = pd.read_csv(replacement_real)
    if DETAIL_EPISODE_INDEX_COLUMN not in replacement.columns:
        raise ValueError("The selective-rerun artifact is missing episode indices.")

    affected = {int(index) for index in episode_indices}
    previous_indices = pd.to_numeric(
        previous[DETAIL_EPISODE_INDEX_COLUMN], errors="raise"
    ).astype(int)
    replacement_indices = pd.to_numeric(
        replacement[DETAIL_EPISODE_INDEX_COLUMN], errors="raise"
    ).astype(int)
    unexpected = set(replacement_indices.tolist()) - affected
    if unexpected:
        raise ValueError("The selective-rerun artifact contains unexpected episodes.")

    retained = previous.loc[~previous_indices.isin(affected)].copy()
    merged = pd.concat([retained, replacement], ignore_index=True, sort=False)
    if not merged.empty:
        merged[DETAIL_EPISODE_INDEX_COLUMN] = pd.to_numeric(
            merged[DETAIL_EPISODE_INDEX_COLUMN], errors="raise"
        ).astype(int)
        merged = merged.sort_values(
            DETAIL_EPISODE_INDEX_COLUMN,
            kind="stable",
        ).reset_index(drop=True)

    temporary_path = replacement_real + ".merging"
    merged.to_csv(temporary_path, index=False)
    os.replace(temporary_path, replacement_real)
    if previous_real != replacement_real:
        _remove_temp_dir(previous_real)
    return replacement_real


def _cleanup_file_id(file_id: str) -> None:
    info = _uploaded_files.pop(file_id, None)
    if info and info.get("path"):
        _remove_temp_dir(info["path"])
    # The deterministic directory is sufficient for cleanup even when this
    # process has no cache entry (for example after a restart or on a worker
    # that did not receive the upload request).
    upload_dir = _upload_dir_for_id(file_id)
    if upload_dir:
        _remove_temp_dir(upload_dir)


def sweep_temp_files(
    max_age_seconds: int = _TEMP_TTL_SECONDS,
    protected: set[str] | None = None,
) -> None:
    """Delete CAT temp dirs older than the TTL (24h backstop) and prune the store.

    ``protected`` holds directories a server-side run link still points at. Those
    links outlive the upload TTL, so without this the sweeper would delete the
    results from under a link that is still valid.
    """
    protected = protected or set()
    now = time.time()
    expired_ids = [
        file_id
        for file_id, info in _uploaded_files.items()
        if now - info.get("created", 0) >= max_age_seconds
    ]
    for fid in expired_ids:
        _cleanup_file_id(fid)
    tmp_root = tempfile.gettempdir()
    try:
        for name in os.listdir(tmp_root):
            if not any(name.startswith(p) for p in _TEMP_PREFIXES):
                continue
            full = os.path.join(tmp_root, name)
            if os.path.realpath(full) in protected:
                continue
            try:
                if os.path.isdir(full) and now - os.path.getmtime(full) >= max_age_seconds:
                    shutil.rmtree(full, ignore_errors=True)
            except OSError:
                continue
    except OSError:
        pass


def _group_units(
    df: pd.DataFrame,
    message_column: str,
    identifier_columns: list[str],
    identity_column: str | None,
    order_column: str | None,
    order_direction: str,
    context_columns: list[str] | None = None,
) -> pd.DataFrame:
    """
    Collapse rows that share the same identifier combination into one unit.

    Messages within a unit are concatenated (one per line). When a sender-identity
    column is present each message is tagged: "[identity] message". Rows are ordered
    by ``order_column`` (asc/desc) before joining; otherwise original file order is kept.
    Sender and order columns retain newline-aligned sequences; other columns
    keep the first value seen in the unit.
    """
    return prepare_coding_dataset(
        df,
        message_column=message_column,
        identifier_columns=identifier_columns,
        identity_column=identity_column,
        order_column=order_column,
        order_direction=order_direction,
        context_columns=context_columns,
    ).episodes


# ── File upload + column discovery ─────────────────────────────────────────────

@router.post("/coding/upload")
@limiter.limit("30/minute")
async def upload_coding_file(request: Request, file: UploadFile | None = File(default=None)):
    """Upload a CSV/Excel file, save temporarily, return columns + preview.

    Two request shapes are accepted:

    * ``multipart/form-data`` with a ``file`` part (the ordinary browser upload); and
    * a raw request body carrying the file bytes, with the original name in the
      ``X-CAT-Filename`` header. Clients use this when they gzip the body to get past
      the upstream firewall's text scanner (``GzipRequestMiddleware`` has already
      decompressed it by the time this handler runs).
    """
    max_bytes = settings.max_upload_mb * 1024 * 1024

    if file is not None and file.filename:
        filename = file.filename
        # Read in bounded chunks so an oversized upload can't exhaust memory.
        buf = bytearray()
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            buf.extend(chunk)
            if len(buf) > max_bytes:
                raise HTTPException(413, f"File too large (max {settings.max_upload_mb} MB).")
        content = bytes(buf)
    else:
        # Raw-body mode. The body is already fully in memory and bounded by the
        # decompression cap in GzipRequestMiddleware; enforce the upload limit too.
        raw_name = request.headers.get("X-CAT-Filename", "")
        filename = unquote(raw_name) if raw_name else ""
        if not filename:
            raise HTTPException(400, "No file provided")
        content = await request.body()
        if len(content) > max_bytes:
            raise HTTPException(413, f"File too large (max {settings.max_upload_mb} MB).")

    ext = filename.rsplit(".", 1)[-1].lower()
    if ext not in ("csv", "xlsx", "xls"):
        raise HTTPException(400, f"Unsupported file type: .{ext}")

    try:
        if ext == "csv":
            df = pd.read_csv(io.BytesIO(content))
        else:
            df = pd.read_excel(io.BytesIO(content))
    except Exception:
        raise HTTPException(
            400,
            "Could not read the file. Make sure it is a valid CSV or Excel file.",
        )

    # Save the upload and its minimal metadata under an opaque deterministic
    # directory. The mapping remains recoverable by another process that shares
    # this temp filesystem, while the original contents still expire after 24h.
    try:
        file_id, _ = _store_uploaded_file(content, filename, ext)
    except OSError:
        raise HTTPException(
            500,
            "Could not store the uploaded dataset. Please try again.",
        )

    all_rows = df.where(df.notna(), None).to_dict(orient="records")
    # Convert numpy types and sanitize remaining NaN/inf
    for row in all_rows:
        for k, v in row.items():
            if hasattr(v, 'item'):
                row[k] = v.item()
            elif isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                row[k] = None

    return {
        "file_id": file_id,
        "file_name": filename,
        "columns": list(df.columns),
        "row_count": len(df),
        "preview": all_rows,
    }


@router.get("/coding/upload-status/{file_id}")
@limiter.limit("120/minute")
async def upload_status(request: Request, file_id: str):
    """Report whether an opaque upload ID still resolves on this backend."""
    try:
        info = resolve_uploaded_file(file_id)
    except UploadResolutionError as exc:
        return _upload_error_response(exc, include_ok=True)

    return JSONResponse(
        content={
            "ok": True,
            "file_id": file_id,
            "file_name": info["filename"],
            "expires_at": info["created"] + _TEMP_TTL_SECONDS,
        },
        headers={"Cache-Control": "no-store"},
    )


# ── Script generation ─────────────────────────────────────────────────────────

class CodedValue(BaseModel):
    value: str = ""
    definition: str = ""
    examples: str = ""
    context: str = ""


class CodebookEntry(BaseModel):
    label: str
    type: str
    level: str = "episode"  # "episode" (one value per episode) or "sender" (one per participant)
    aggregation: str = "mode"  # "mode" (majority vote) or "mean" (numeric average)
    definition: str = ""
    examples: str = ""
    context: str = ""
    values: list[CodedValue] = []


class ContextItem(BaseModel):
    column: str
    description: str = ""


class GenerateScriptRequest(BaseModel):
    file_name: str
    message_column: str
    experiment_instructions: str
    coding_instructions: str = ""
    codebook: list[CodebookEntry]
    provider: str
    model: str = ""
    # Generated artifacts never embed credentials; their script obtains the key
    # from CAT_API_KEY or prompts at runtime.
    api_key: str = ""
    participants: list[str] = []
    context: list[ContextItem] = []
    identifier_columns: list[str] = []
    identity_column: str | None = None
    order_column: str | None = None
    order_direction: str = "asc"
    empty_message_handling: str = "ignore"
    # Accepted so the field isn't silently dropped; the standalone script uses the
    # first selected provider/model for one call per episode.
    model_slots: list[dict] = []


class GeneratePackageRequest(GenerateScriptRequest):
    file_id: str
    # Optional Step 1 source-row subset (0-based positions into the uploaded file).
    source_rows: list[int] | None = None


@router.post("/coding/generate-script")
@limiter.limit("30/minute")
async def generate_script(request: Request, req: GenerateScriptRequest):
    """Validate config and generate a ready-to-run Python coding script."""

    _validate_config(req)

    codebook_dicts = [entry.model_dump() for entry in req.codebook]

    script_text = generate_coding_script(
        file_name=req.file_name,
        message_column=req.message_column,
        experiment_instructions=req.experiment_instructions,
        coding_instructions=req.coding_instructions,
        codebook=codebook_dicts,
        provider=req.provider,
        model=req.model,
        api_key=req.api_key,
        participants=req.participants,
        context=[c.model_dump() for c in req.context],
        identifier_columns=req.identifier_columns,
        identity_column=req.identity_column,
        order_column=req.order_column,
        order_direction=req.order_direction,
        empty_message_handling=req.empty_message_handling,
    )

    base_name = req.file_name.rsplit(".", 1)[0] if "." in req.file_name else req.file_name
    filename = f"code_{base_name}.py"

    return {
        "script": script_text,
        "filename": filename,
    }


def _package_requirements(provider: str) -> str:
    packages = ["pandas==2.3.3"]
    if provider == "anthropic":
        packages.append("anthropic==0.86.0")
    elif provider == "gemini":
        packages.append("google-genai==1.68.0")
    else:
        packages.append("openai==2.29.0")
    return "\n".join(packages) + "\n"


@router.post("/coding/generate-package")
@limiter.limit("30/minute")
async def generate_package(request: Request, req: GeneratePackageRequest):
    """Download a runnable ZIP with source rows, episodes, lineage, and setup files."""
    _validate_config(req)

    try:
        file_info = resolve_uploaded_file(req.file_id)
    except UploadResolutionError as exc:
        return _upload_error_response(exc)

    file_path = file_info["path"]
    try:
        if file_path.rsplit(".", 1)[-1].lower() == "csv":
            df = pd.read_csv(file_path)
        else:
            df = pd.read_excel(file_path)
    except Exception:
        raise HTTPException(400, "Could not read the uploaded dataset.")

    if req.source_rows is not None:
        try:
            df = _select_source_rows(df, req.source_rows)
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    if req.message_column not in df.columns:
        raise HTTPException(400, f"Column '{req.message_column}' not found in the dataset.")

    codebook_dicts = [entry.model_dump() for entry in req.codebook]
    try:
        validate_sender_configuration(
            df,
            identity_column=req.identity_column,
            participants=req.participants,
            codebook=codebook_dicts,
        )
        prepared = prepare_coding_dataset(
            df,
            message_column=req.message_column,
            identifier_columns=req.identifier_columns,
            identity_column=req.identity_column,
            order_column=req.order_column,
            order_direction=req.order_direction,
            context_columns=[item.column for item in req.context],
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    original_stem = req.file_name.rsplit(".", 1)[0] if "." in req.file_name else req.file_name
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.basename(original_stem)).strip("._") or "dataset"
    source_filename = "source_rows.csv"
    episode_filename = "episodes.csv"
    row_map_filename = "row_map.csv"
    script_filename = f"code_{safe_stem}.py"

    row_map = pd.DataFrame(
        {
            "source_row": list(range(1, len(df) + 1)),
            "episode": [index + 1 for index in prepared.source_episode_indices],
        }
    )
    compact_columns: list[str] = []
    for column in [
        *req.identifier_columns,
        req.message_column,
        req.identity_column,
        req.order_column,
        *(item.column for item in req.context),
    ]:
        if column and column in prepared.episodes.columns and column not in compact_columns:
            compact_columns.append(column)
    source_csv = dataframe_to_csv(df)
    episode_csv = dataframe_to_csv(prepared.episodes)
    row_map_csv = dataframe_to_csv(row_map)

    # The package contains the exact grouped episode table and a positional map
    # back to every source row. The script codes episodes.csv directly and
    # expands those values without regrouping.
    script_text = generate_coding_script(
        file_name=episode_filename,
        message_column=req.message_column,
        experiment_instructions=req.experiment_instructions,
        coding_instructions=req.coding_instructions,
        codebook=codebook_dicts,
        provider=req.provider,
        model=req.model,
        api_key=req.api_key,
        participants=req.participants,
        context=[c.model_dump() for c in req.context],
        identifier_columns=[],
        identity_column=req.identity_column,
        order_column=None,
        order_direction="asc",
        empty_message_handling=req.empty_message_handling,
        package_source_file=source_filename,
        package_episode_file=episode_filename,
        package_row_map_file=row_map_filename,
        compact_columns=compact_columns,
        result_stem=safe_stem,
    )

    readme = f"""# CAT coding package

This package contains the coding configuration generated in CAT and three CSV
files that preserve the loaded source rows, the exact preprocessed episodes,
and their positional row-to-episode mapping.

## Files

- `{script_filename}` — generated Python coding script
- `{source_filename}` — parsed source rows
- `{episode_filename}` — exact preprocessed episodes coded by the script
- `{row_map_filename}` — one-based source-row to episode mapping
- `requirements.txt` — Python dependencies

## Run

1. Open a terminal in this folder.
2. Install the dependencies:

   `python3 -m pip install -r requirements.txt`

3. Run the coding script:

   `python3 {script_filename}`

The script defaults to `{episode_filename}` and reads all three CSV files from
the same folder. It writes the primary result `{safe_stem}_coded.csv`. This CSV
has the same source rows and original
columns as the input, with the coding columns appended. Rows belonging to the
same episode receive the same episode-level coding values.

To also create the compact one-row-per-episode CSV, run:

   `python3 {script_filename} --also-save-episodes`

This additionally writes `{safe_stem}_coded_episodes.csv`.

For package generation, CAT does not save an API key or the configured tuning
settings. The generated script records the first provider and model selected in
CAT and makes one call per episode. To change model parameters or create a
repeated- or multi-model workflow, edit the generated Python script. The
browser's `Run Coding` workflow uses all configured models and runs.

The generated script does not contain your API key. When it starts, it reads the
`CAT_API_KEY` environment variable or securely prompts you to enter the key.
"""

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(script_filename, script_text)
        zf.writestr(source_filename, source_csv)
        zf.writestr(episode_filename, episode_csv)
        zf.writestr(row_map_filename, row_map_csv)
        zf.writestr("README.md", readme)
        zf.writestr("requirements.txt", _package_requirements(req.provider))

    # Count the offline path separately from in-interface runs.
    track_package_download(req)

    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="cat_{safe_stem}_package.zip"'},
    )


async def _coding_updates(config: dict, file_info: dict | None = None):
    """Yield coding progress events for HTTP streaming and legacy WebSockets."""
    file_id = config.get("file_id")
    if file_info is None:
        try:
            file_info = resolve_uploaded_file(file_id)
        except UploadResolutionError as exc:
            yield {"type": "error", "code": exc.code, "message": exc.detail}
            return
    file_path = file_info["path"]

    ext = file_path.rsplit(".", 1)[-1].lower()
    if ext == "csv":
        df = pd.read_csv(file_path)
    else:
        df = pd.read_excel(file_path)

    # Apply an optional source-row subset (e.g. code only a 50-row test slice)
    # before any grouping, so episodes and their indices match the client preview.
    source_rows = config.get("source_rows")
    if source_rows is not None:
        try:
            df = _select_source_rows(df, source_rows)
        except ValueError as exc:
            yield {"type": "error", "message": str(exc)}
            return

    message_column = config.get("message_column", "")
    if message_column not in df.columns:
        yield {"type": "error", "message": f"Column '{message_column}' not found in file."}
        return

    codebook = config.get("codebook", [])
    participants = config.get("participants", []) or []
    context = config.get("context", []) or []
    model_slots = config.get("model_slots", [])
    runs_per_model = config.get("runs_per_model", 1)
    aggregation = config.get("aggregation", "mode")
    row_indices = config.get("row_indices")
    previous_result_path = config.get("previous_result_path")

    if not model_slots:
        provider = config.get("provider", "")
        model_id = config.get("model", "")
        api_key = config.get("api_key", "")
        if provider and api_key:
            model_slots = [{"provider": provider, "model": model_id, "api_key": api_key}]

    if not codebook or not model_slots:
        yield {"type": "error", "message": "Missing required config fields."}
        return

    try:
        validate_sender_configuration(
            df,
            identity_column=config.get("identity_column"),
            participants=participants,
            codebook=codebook,
        )
        df = _group_units(
            df,
            message_column=message_column,
            identifier_columns=config.get("identifier_columns") or [],
            identity_column=config.get("identity_column"),
            order_column=config.get("order_column"),
            order_direction=config.get("order_direction", "asc"),
            context_columns=[item.get("column") for item in context if item.get("column")],
        )
    except ValueError as exc:
        yield {"type": "error", "message": str(exc)}
        return

    try:
        expanded_codebook_labels(codebook, participants)
        if len(model_slots) * runs_per_model > 1:
            aggregate_output_labels(codebook, participants)
    except ValueError as exc:
        # Reject ambiguous JSON/output keys before making any paid model calls.
        yield {"type": "error", "message": str(exc)}
        return

    if row_indices is not None:
        valid_indices = [i for i in row_indices if 0 <= i < len(df)]
        if len(valid_indices) != len(set(valid_indices)):
            yield {"type": "error", "message": "Selective rerun episode indices must be unique."}
            return
        if not previous_result_path:
            yield {
                "type": "error",
                "message": "The previous detailed-results artifact is required for a selective rerun.",
            }
            return
        try:
            previous_result_path = _validate_selective_rerun_artifact(previous_result_path)
        except (HTTPException, ValueError) as exc:
            yield {"type": "error", "message": getattr(exc, "detail", str(exc))}
            return
        df = df.iloc[valid_indices].reset_index(drop=True)
    else:
        valid_indices = None

    async for update in run_coding(
        df=df,
        message_column=message_column,
        experiment_instructions=config.get("experiment_instructions", ""),
        coding_instructions=config.get("coding_instructions", ""),
        codebook=codebook,
        participants=participants,
        context=context,
        model_slots=model_slots,
        runs_per_model=runs_per_model,
        empty_message_handling=config.get("empty_message_handling", ""),
        aggregation=aggregation,
        episode_indices=valid_indices,
    ):
        if valid_indices is not None and "index" in update:
            idx = update["index"]
            if 0 <= idx < len(valid_indices):
                update["index"] = valid_indices[idx]
        if valid_indices is not None and update.get("type") == "complete":
            try:
                update["file_path"] = _merge_selective_rerun_artifact(
                    previous_result_path,
                    update["file_path"],
                    valid_indices,
                )
            except (HTTPException, ValueError, OSError, pd.errors.ParserError) as exc:
                _remove_temp_dir(update.get("file_path", ""))
                yield {
                    "type": "error",
                    "message": "The selective rerun completed, but its detailed records "
                    f"could not replace the previous episode records: {getattr(exc, 'detail', str(exc))}",
                }
                return
        yield update


async def _coding_ndjson(config: dict, file_info: dict | None = None, tracker: "RunTracker | None" = None):
    try:
        yield json.dumps({"type": "started"}) + "\n"
        async for update in with_keepalive(_coding_updates(config, file_info)):
            if tracker is not None:
                tracker.observe(update)
            yield json.dumps(update, ensure_ascii=False, default=str) + "\n"
    except Exception as exc:
        if tracker is not None:
            tracker.note_error(str(exc))
        yield json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False) + "\n"


async def _tracked_coding_ndjson(config: dict, file_info: dict | None, tracker: "RunTracker"):
    """Stream the run and record its real outcome, including a client disconnect.

    The browser also reports run outcomes, but only with analytics consent and only
    if it survives the run; this is the authoritative record for the dashboard.
    """
    tracker.start()
    try:
        async for chunk in _coding_ndjson(config, file_info, tracker=tracker):
            yield chunk
    except (asyncio.CancelledError, GeneratorExit):
        # The client went away — Stop was pressed, the tab closed, or the network
        # dropped. Record it as stopped rather than silently losing the run.
        tracker.stopped = True
        raise
    finally:
        # finish() only schedules the write, so it is safe while being cancelled.
        tracker.finish()


@router.post("/coding/run-stream")
@limiter.limit("10/minute")
async def run_coding_stream(request: Request, config: dict):
    """Run coding over streaming HTTP for proxies that do not support WebSockets."""
    # Resolve before constructing StreamingResponse. Otherwise HTTP headers are
    # already committed as 200 before the generator discovers a stale file ID.
    try:
        file_info = resolve_uploaded_file(config.get("file_id"))
    except UploadResolutionError as exc:
        return _upload_error_response(exc)

    tracker = RunTracker(config)
    return StreamingResponse(
        _tracked_coding_ndjson(config, file_info, tracker),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


class EstimateRequest(BaseModel):
    """The same configuration a run is started with."""
    config: dict


@router.post("/coding/estimate")
@limiter.limit("60/minute")
async def estimate_run(request: Request, req: EstimateRequest, db: AsyncSession = Depends(get_db)):
    """How long a run will take and roughly how many tokens it will use.

    Makes no model call: the prompt is built exactly as the run will build it,
    from the first real episode, so the figures reflect this researcher's own
    instructions, codebook and data.
    """
    config = req.config or {}
    try:
        file_info = resolve_uploaded_file(config.get("file_id"))
    except UploadResolutionError as exc:
        return _upload_error_response(exc)

    file_path = file_info["path"]
    try:
        if file_path.rsplit(".", 1)[-1].lower() == "csv":
            df = pd.read_csv(file_path)
        else:
            df = pd.read_excel(file_path)
    except Exception:
        raise HTTPException(400, "Could not read the uploaded dataset.")

    source_rows = config.get("source_rows")
    if source_rows is not None:
        try:
            df = _select_source_rows(df, source_rows)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    message_column = config.get("message_column", "")
    if message_column not in df.columns:
        raise HTTPException(400, f"Column '{message_column}' not found in file.")

    context = config.get("context", []) or []
    try:
        grouped = _group_units(
            df,
            message_column=message_column,
            identifier_columns=config.get("identifier_columns") or [],
            identity_column=config.get("identity_column"),
            order_column=config.get("order_column"),
            order_direction=config.get("order_direction", "asc"),
            context_columns=[item.get("column") for item in context if item.get("column")],
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    codebook = config.get("codebook", []) or []
    participants = config.get("participants", []) or []
    model_slots = config.get("model_slots", []) or []

    # The prompt the run would send for the first episode, built by the same code.
    first_message = ""
    if len(grouped) > 0 and message_column in grouped.columns:
        value = grouped.iloc[0][message_column]
        first_message = "" if pd.isna(value) else str(value)
    prompt = build_coding_prompt(
        first_message,
        config.get("experiment_instructions", ""),
        config.get("coding_instructions", ""),
        codebook,
        participants,
        "",
    )

    models = [str(slot.get("model", "")) for slot in model_slots if isinstance(slot, dict)]
    seconds_each, measured = await estimate_mod.seconds_per_unit(db, models)
    return estimate_mod.build_estimate(
        episodes=len(grouped),
        models=models,
        runs_per_model=int(config.get("runs_per_model") or 1),
        prompt=prompt,
        variable_count=len([e for e in codebook if str(e.get("label", "")).strip()]),
        seconds_each=seconds_each,
        measured=measured,
    )


@router.get("/coding/capabilities")
@limiter.limit("120/minute")
async def coding_capabilities(request: Request):
    """What this deployment can actually do, so the UI promises nothing it cannot.

    Without a mail relay the server-side run still works and its link still
    works; only the notification is unavailable, and the interface should say so
    rather than ask for an address and then stay silent.
    """
    return {"email_notifications": settings.mail_configured}


class StartJobRequest(BaseModel):
    """A server-side run: the same config as run-stream, plus where to write."""
    config: dict
    email: str = ""


@router.post("/coding/jobs")
@limiter.limit("10/minute")
async def start_coding_job(request: Request, req: StartJobRequest):
    """Start a coding run that keeps going after the browser disconnects.

    Opt-in only. The browser path is untouched: this exists so a dropped
    connection no longer destroys an hour of coding.
    """
    config = req.config or {}
    try:
        file_info = resolve_uploaded_file(config.get("file_id"))
    except UploadResolutionError as exc:
        return _upload_error_response(exc)

    email = (req.email or "").strip()[:200]
    if email and ("@" not in email or " " in email):
        raise HTTPException(400, "Enter a valid email address, or leave it blank.")

    return await jobs.start(config, file_info, email=email)


def _require_run_access(job, request: Request) -> None:
    """A run opens only with both its link and its access key.

    The key arrives in a header rather than the URL on purpose: a URL ends up in
    browser history, in referrers, and in anything the researcher shares a screen
    with, so a token on its own must not be enough to read somebody's results.
    """
    supplied = request.headers.get("x-cat-run-key", "")
    if not jobs.access_key_matches(job, supplied):
        raise HTTPException(
            401,
            "This run needs its access key — the one emailed with the link.",
            headers={"X-CAT-Key-Required": "1"},
        )


@router.get("/coding/jobs/{token}")
@limiter.limit("240/minute")
async def coding_job_status(request: Request, token: str, db: AsyncSession = Depends(get_db)):
    """Progress for one run. Polled by the run's page."""
    job = await jobs.get_job(db, token)
    if not job:
        raise HTTPException(404, "This run link is not valid, or it has expired.")
    _require_run_access(job, request)
    return jobs.job_payload(job)


@router.post("/coding/jobs/{token}/stop")
@limiter.limit("30/minute")
async def stop_coding_job(request: Request, token: str, db: AsyncSession = Depends(get_db)):
    """Ask a running job to stop at the next episode boundary."""
    job = await jobs.get_job(db, token)
    if not job:
        raise HTTPException(404, "This run link is not valid, or it has expired.")
    _require_run_access(job, request)
    if job.status in ("queued", "running"):
        jobs.request_stop(token)
    return {"ok": True}


@router.get("/coding/jobs/{token}/rows")
@limiter.limit("60/minute")
async def coding_job_rows(request: Request, token: str, db: AsyncSession = Depends(get_db)):
    """The coded rows of a finished run, so its page can show the full results view.

    Served from the file written beside the results, never from the database —
    participant text does not belong there.
    """
    job = await jobs.get_job(db, token)
    if not job:
        raise HTTPException(404, "This run link is not valid, or it has expired.")
    _require_run_access(job, request)
    if job.status != "completed" or not job.result_path:
        return {"rows": [], "config": {}}
    return {
        "rows": jobs.read_rows(job.result_path),
        # Lets the run's own page render the same results view the app shows,
        # which needs the codebook and column mapping to validate and export.
        "config": jobs.read_config(job.result_path),
    }


@router.get("/coding/jobs/{token}/download")
@limiter.limit("60/minute")
async def download_coding_job(request: Request, token: str, db: AsyncSession = Depends(get_db)):
    """The finished results, fetched by token so no server path is exposed."""
    job = await jobs.get_job(db, token)
    if not job:
        raise HTTPException(404, "This run link is not valid, or it has expired.")
    _require_run_access(job, request)
    if job.status != "completed" or not job.result_path:
        raise HTTPException(409, "This run has no results to download.")
    path = _resolve_coding_result_path(job.result_path)
    stem = _safe_result_component((job.file_name or "results").rsplit(".", 1)[0]) or "results"
    return FileResponse(
        path,
        media_type="text/csv",
        filename=f"cat_{stem}_coded.csv",
        headers={"Cache-Control": "no-store"},
    )


# ── Legacy WebSocket: Run coding with live progress ─────────────────────────

@router.websocket("/ws/coding/run")
async def ws_run_coding(ws: WebSocket):
    """
    WebSocket endpoint for running coding with live progress.

    Client sends JSON config, server streams back progress + rows.
    """
    await ws.accept()

    try:
        config = await ws.receive_json()
        async for update in _coding_updates(config):
            await ws.send_json(update)

        await ws.close()

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({"type": "error", "message": str(e)})
            await ws.close()
        except Exception:
            pass


# ── Validate model slots (test API keys) ───────────────────────────────────────

class ValidateSlot(BaseModel):
    provider: str
    model: str
    api_key: str


class ValidateRequest(BaseModel):
    model_slots: list[ValidateSlot]


@router.post("/coding/validate")
@limiter.limit("20/minute")
async def validate_models(request: Request, req: ValidateRequest):
    """Test each model slot with a tiny prompt to verify API key + model work."""
    from app.services.coding_runner import _get_provider_instance

    results = []
    for slot in req.model_slots:
        label = f"{slot.provider}/{slot.model}"
        try:
            provider = _get_provider_instance(slot.provider, slot.model, slot.api_key)
            await provider.complete(
                "Respond with exactly: OK",
                system_prompt="Reply with only the word OK.",
                params={"temperature": 0, "max_tokens": 10},
            )
            results.append({"label": label, "ok": True})
        except Exception as e:
            err_msg = str(e)
            # Trim long error messages
            if len(err_msg) > 200:
                err_msg = err_msg[:200] + "..."
            results.append({"label": label, "ok": False, "error": err_msg})

    all_ok = all(r["ok"] for r in results)
    return {"ok": all_ok, "results": results}


# ── Download coded results ──────────────────────────────────────────────────

class ExportCodedRow(BaseModel):
    index: int
    coded: dict[str, Any]


class ExportResultsRequest(BaseModel):
    file_id: str
    message_column: str
    identifier_columns: list[str] = []
    identity_column: str | None = None
    order_column: str | None = None
    order_direction: str = "asc"
    context: list[ContextItem] = []
    codebook: list[CodebookEntry]
    participants: list[str] = []
    coded_rows: list[ExportCodedRow]
    kind: Literal["primary", "episodes"] = "primary"
    result_path: str | None = None
    model_call_count: int = 1


class InterCoderAgreementRequest(BaseModel):
    result_path: str
    codebook: list[CodebookEntry]
    participants: list[str] = Field(default_factory=list)


@router.post("/coding/inter-coder-agreement")
@limiter.limit("30/minute")
async def inter_coder_agreement(request: Request, req: InterCoderAgreementRequest):
    """Return pairwise agreement for model-level aggregates."""
    detail_path = _resolve_coding_result_path(req.result_path)
    try:
        detail_df = pd.read_csv(detail_path)
        report = build_inter_coder_agreement(
            detail_df,
            codebook=[entry.model_dump() for entry in req.codebook],
            participants=req.participants,
        )
    except (OSError, pd.errors.ParserError) as exc:
        raise HTTPException(400, "Could not read the detailed model and run results.") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return report


def _safe_result_component(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._") or "model"


def _model_name(coder: str) -> str:
    return coder.rsplit("__run", 1)[0] if "__run" in coder else coder


def _run_sort_key(coder: str) -> tuple[int, str]:
    if "__run" in coder:
        suffix = coder.rsplit("__run", 1)[1]
        if suffix.isdigit():
            return int(suffix), coder
    return 1, coder


def _aggregate_detail_rows(
    raw_rows: pd.DataFrame,
    *,
    codebook: list[dict[str, Any]],
    participants: list[str],
) -> pd.DataFrame:
    """Build one aggregate row per episode from raw call-level records."""
    aggregate_labels = aggregate_output_labels(codebook, participants)
    raw_labels = [spec["key"] for spec in expanded_codebook_specs(codebook, participants)]
    excluded = {DETAIL_EPISODE_INDEX_COLUMN, "coder", "_error", *raw_labels, *aggregate_labels}
    metadata_columns = [column for column in raw_rows.columns if column not in excluded]
    records: list[dict[str, Any]] = []
    if DETAIL_EPISODE_INDEX_COLUMN not in raw_rows.columns:
        return pd.DataFrame(columns=[*metadata_columns, *aggregate_labels])
    for _, episode_rows in raw_rows.groupby(DETAIL_EPISODE_INDEX_COLUMN, sort=False, dropna=False):
        original = {
            column: episode_rows.iloc[0][column]
            for column in metadata_columns
        }
        calls = episode_rows.loc[:, [column for column in raw_labels if column in episode_rows.columns]].to_dict("records")
        records.append({**original, **aggregate_results(calls, codebook, participants)})
    return pd.DataFrame(records, columns=[*metadata_columns, *aggregate_labels])


def _text_detail_rows(
    raw_rows: pd.DataFrame,
    *,
    codebook: list[dict[str, Any]],
    participants: list[str],
) -> pd.DataFrame | None:
    """Return raw text outcomes with their model/run and episode context."""
    specs = expanded_codebook_specs(codebook, participants)
    raw_labels = [spec["key"] for spec in specs]
    text_labels = [spec["key"] for spec in specs if spec["type"] == "text"]
    if not text_labels:
        return None
    aggregate_labels = aggregate_output_labels(codebook, participants)
    excluded = {"_error", *raw_labels, *aggregate_labels}
    metadata_columns = [column for column in raw_rows.columns if column not in excluded]
    columns = [*metadata_columns, *[label for label in text_labels if label in raw_rows.columns]]
    return raw_rows.loc[:, columns].drop(columns=[DETAIL_EPISODE_INDEX_COLUMN], errors="ignore")


@router.post("/coding/export-results")
@limiter.limit("30/minute")
async def export_results(request: Request, req: ExportResultsRequest):
    """Build either the source-row or compact episode-level CSV result.

    The browser sends only the latest aggregate value for each coded episode.
    The original dataset is reread from the server-side upload so original rows,
    columns, and ordering do not depend on the preprocessed browser preview.
    """

    if not req.message_column.strip():
        raise HTTPException(400, "Message column is required.")
    if not req.codebook:
        raise HTTPException(400, "Codebook must have at least one entry.")
    if req.model_call_count < 1:
        raise HTTPException(400, "Model call count must be at least one.")

    try:
        file_info = resolve_uploaded_file(req.file_id)
    except UploadResolutionError as exc:
        return _upload_error_response(exc)

    file_path = file_info["path"]
    try:
        if file_path.rsplit(".", 1)[-1].lower() == "csv":
            source_df = pd.read_csv(file_path)
        else:
            source_df = pd.read_excel(file_path)
    except Exception:
        raise HTTPException(400, "Could not read the uploaded dataset.")

    if req.message_column not in source_df.columns:
        raise HTTPException(
            400,
            f"Column '{req.message_column}' not found in the uploaded dataset.",
        )

    try:
        codebook_dicts = [entry.model_dump() for entry in req.codebook]
        validate_sender_configuration(
            source_df,
            identity_column=req.identity_column,
            participants=req.participants,
            codebook=codebook_dicts,
        )
        prepared = prepare_coding_dataset(
            source_df,
            message_column=req.message_column,
            identifier_columns=req.identifier_columns,
            identity_column=req.identity_column,
            order_column=req.order_column,
            order_direction=req.order_direction,
            context_columns=[item.column for item in req.context],
        )
        source_result, episode_result, _ = build_result_frames(
            source_df=source_df,
            prepared=prepared,
            coded_rows=[row.model_dump() for row in req.coded_rows],
            codebook=codebook_dicts,
            participants=req.participants,
            message_column=req.message_column,
            identifier_columns=req.identifier_columns,
            context_columns=[item.column for item in req.context],
            identity_column=req.identity_column,
            order_column=req.order_column,
        )
        if req.model_call_count > 1:
            aggregate_output_labels(codebook_dicts, req.participants)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    original_name = file_info.get("filename") or "dataset"
    original_stem = original_name.rsplit(".", 1)[0] if "." in original_name else original_name
    safe_stem = (
        re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.basename(original_stem)).strip("._")
        or "dataset"
    )

    if req.model_call_count > 1:
        if not req.result_path:
            raise HTTPException(400, "Detailed model and run results are required for an aggregated download.")
        detail_path = _resolve_coding_result_path(req.result_path)
        try:
            detail_df = pd.read_csv(detail_path)
        except Exception as exc:
            raise HTTPException(400, "Could not read the detailed model and run results.") from exc
        if "coder" not in detail_df.columns or DETAIL_EPISODE_INDEX_COLUMN not in detail_df.columns:
            raise HTTPException(400, "Detailed results do not contain the required model/run identifiers.")

        raw_detail = detail_df[~detail_df["coder"].astype(str).str.startswith("__")].copy()
        aggregate_labels = aggregate_output_labels(codebook_dicts, req.participants)
        agreement_report = build_inter_coder_agreement(
            detail_df,
            codebook=codebook_dicts,
            participants=req.participants,
        )
        text_specs = [
            spec for spec in expanded_codebook_specs(codebook_dicts, req.participants)
            if spec["type"] == "text"
        ]

        aggregate_schema = [
            {"label": label, "level": "episode"}
            for label in aggregate_labels
        ]
        if aggregate_schema:
            overall_source, _, _ = build_result_frames(
                source_df=source_df,
                prepared=prepared,
                coded_rows=[row.model_dump() for row in req.coded_rows],
                codebook=aggregate_schema,
                participants=[],
                message_column=req.message_column,
                identifier_columns=req.identifier_columns,
                context_columns=[item.column for item in req.context],
                identity_column=req.identity_column,
                order_column=req.order_column,
            )
        else:
            overall_source = source_df.reset_index(drop=True).copy()

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
            if (
                agreement_report["eligible"] or agreement_report["within_eligible"]
            ) and agreement_report["numeric_variables"]:
                archive.writestr(
                    "inter_coder_agreement.csv",
                    dataframe_to_csv(agreement_report_frame(agreement_report)),
                )
            if aggregate_labels:
                archive.writestr(
                    "overall/aggregated_results.csv",
                    dataframe_to_csv(overall_source),
                )
            if text_specs:
                overall_text = _text_detail_rows(
                    raw_detail,
                    codebook=codebook_dicts,
                    participants=req.participants,
                )
                if overall_text is not None:
                    archive.writestr("overall/text_results.csv", dataframe_to_csv(overall_text))

            raw_detail["__cat_model"] = raw_detail["coder"].astype(str).map(_model_name)
            used_folders: set[str] = set()
            for model_name, model_rows in raw_detail.groupby("__cat_model", sort=False):
                model_rows = model_rows.drop(columns=["__cat_model"])
                base_folder = _safe_result_component(str(model_name))
                folder_name = base_folder
                suffix = 2
                while folder_name in used_folders:
                    folder_name = f"{base_folder}_{suffix}"
                    suffix += 1
                used_folders.add(folder_name)
                folder = f"models/{folder_name}"
                if aggregate_labels:
                    model_aggregate = _aggregate_detail_rows(
                        model_rows,
                        codebook=codebook_dicts,
                        participants=req.participants,
                    )
                    archive.writestr(
                        f"{folder}/aggregated_results.csv",
                        dataframe_to_csv(model_aggregate),
                    )
                if text_specs:
                    model_text = _text_detail_rows(
                        model_rows,
                        codebook=codebook_dicts,
                        participants=req.participants,
                    )
                    if model_text is not None:
                        archive.writestr(
                            f"{folder}/text_results.csv",
                            dataframe_to_csv(model_text),
                        )
                coders = sorted(model_rows["coder"].dropna().astype(str).unique(), key=_run_sort_key)
                for run_number, coder in enumerate(coders, start=1):
                    run_frame = model_rows[model_rows["coder"].astype(str) == coder].drop(
                        columns=["coder", DETAIL_EPISODE_INDEX_COLUMN], errors="ignore"
                    )
                    archive.writestr(
                        f"{folder}/runs/run{run_number}.csv",
                        dataframe_to_csv(run_frame),
                    )

        buf.seek(0)
        return Response(
            content=buf.getvalue(),
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{safe_stem}_coded_results.zip"',
                "Cache-Control": "no-store",
            },
        )

    if req.kind == "episodes":
        content = dataframe_to_csv(episode_result)
        filename = f"{safe_stem}_coded_episodes.csv"
    else:
        content = dataframe_to_csv(source_result)
        filename = f"{safe_stem}_coded.csv"

    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


class CleanupRequest(BaseModel):
    file_id: str | None = None
    path: str | None = None


@router.post("/coding/cleanup")
@limiter.limit("120/minute")
async def cleanup_files(request: Request, req: CleanupRequest):
    """Delete an upload's temp working files and/or a results file (best effort).

    Called by the client on Reset and when a new file replaces the current one, so
    uploaded data doesn't linger on disk. Only CAT temp dirs can be removed.
    """
    if req.file_id:
        _cleanup_file_id(req.file_id)
    if req.path:
        _remove_temp_dir(req.path)
    return {"ok": True}


@router.get("/coding/download")
async def download_results(path: str):
    """Download coded results — single CSV or structured zip.

    Only the canonical result file inside a CAT coding directory may be read;
    unrelated files in the system temporary directory are rejected.
    """
    path = _resolve_coding_result_path(path)

    import re
    import zipfile
    from io import BytesIO
    from starlette.responses import Response

    df = pd.read_csv(path)
    public_df = df.drop(columns=[DETAIL_EPISODE_INDEX_COLUMN], errors="ignore")

    if "coder" not in df.columns:
        return Response(
            content=public_df.to_csv(index=False),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="coded_results.csv"'},
        )

    coders = [e for e in df["coder"].unique() if not str(e).startswith("__")]
    aggregated = [e for e in df["coder"].unique() if str(e).startswith("__")]

    # Single model, single run → plain CSV
    if len(coders) <= 1 and len(aggregated) == 0:
        return Response(
            content=public_df.to_csv(index=False),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="coded_results.csv"'},
        )

    # Multiple → build structured zip
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # Overall aggregate (aggregated rows, or all if no aggregation)
        if aggregated:
            agg_df = public_df[public_df["coder"].isin(aggregated)].drop(columns=["coder"], errors="ignore")
            zf.writestr("aggregate.csv", agg_df.to_csv(index=False))

        # Group coders by model (split on __run suffix)
        model_runs: dict[str, list[str]] = {}
        for enc in coders:
            if "__run" in enc:
                model_name = enc.rsplit("__run", 1)[0]
            else:
                model_name = enc
            model_runs.setdefault(model_name, []).append(enc)

        for model_name, runs in model_runs.items():
            safe_name = re.sub(r'[^\w\-.]', '_', model_name)

            if len(runs) == 1:
                # Single run for this model — just one CSV
                run_df = public_df[public_df["coder"] == runs[0]].drop(columns=["coder"], errors="ignore")
                zf.writestr(f"{safe_name}.csv", run_df.to_csv(index=False))
            else:
                # The runner's overall aggregate already applies each variable's
                # configured mode/mean rule. Keep repeated per-model calls as raw
                # records rather than manufacturing a mode-only model aggregate.
                for i, run_enc in enumerate(sorted(runs)):
                    run_df = public_df[public_df["coder"] == run_enc].drop(columns=["coder"], errors="ignore")
                    zf.writestr(f"{safe_name}/run{i + 1}.csv", run_df.to_csv(index=False))

    buf.seek(0)
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=coded_results.zip"},
    )


# ── Validation helper ─────────────────────────────────────────────────────────

def _validate_config(req: GenerateScriptRequest):
    if not req.codebook or len(req.codebook) == 0:
        raise HTTPException(400, "Codebook must have at least one entry")

    for i, entry in enumerate(req.codebook):
        if not entry.label.strip():
            raise HTTPException(400, f"Codebook entry {i + 1}: label is required")
        if not entry.type.strip():
            raise HTTPException(400, f"Codebook entry {i + 1}: type is required")
        if entry.aggregation not in ("mode", "mean"):
            raise HTTPException(400, f"Codebook entry {i + 1}: aggregation must be mode or mean")
        if entry.level == "sender" and not req.participants:
            raise HTTPException(400, "Per-sender variables require a verified sender list")

    try:
        expanded_codebook_labels(
            [entry.model_dump() for entry in req.codebook],
            req.participants,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    if not req.message_column.strip():
        raise HTTPException(400, "Message column is required")
    if not req.experiment_instructions.strip():
        raise HTTPException(400, "Experiment instructions are required")
    if not req.provider.strip():
        raise HTTPException(400, "Provider is required")
