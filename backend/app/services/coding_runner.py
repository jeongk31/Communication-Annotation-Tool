"""Runs LLM-based coding row by row with multi-model voting support."""

import asyncio
import json
import re
from collections import Counter
from statistics import mean as stat_mean, median as stat_median
from typing import Any, AsyncGenerator

import pandas as pd

from app.services.providers.base import LLMProvider


# Stored only in the server-side detailed-results artifact. It lets a selective
# rerun replace every call-level record for the affected episode without relying
# on potentially non-unique source columns.
DETAIL_EPISODE_INDEX_COLUMN = "__chat_episode_index"


# Provider → base_url (None = default for the SDK)
PROVIDER_BASE_URLS = {
    "openai": None,
    "anthropic": None,
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "deepseek": "https://api.deepseek.com",
    "xai": "https://api.x.ai/v1",
}


def _get_provider_instance(provider_name: str, model_id: str, api_key: str) -> LLMProvider:
    """Get an LLM provider instance for the given provider and model."""
    if provider_name not in PROVIDER_BASE_URLS:
        raise ValueError(f"Unknown provider: {provider_name}")

    if provider_name == "anthropic":
        from app.services.providers.anthropic_provider import AnthropicProvider
        return AnthropicProvider(api_key=api_key, model=model_id)

    if provider_name == "gemini":
        from app.services.providers.gemini_provider import GeminiProvider
        return GeminiProvider(api_key=api_key, model=model_id)

    # OpenAI-compatible: openai, deepseek, and xAI
    base_url = PROVIDER_BASE_URLS.get(provider_name)
    from app.services.providers.openai_provider import OpenAICompatibleProvider
    return OpenAICompatibleProvider(api_key=api_key, model=model_id, base_url=base_url)


def _expanded_keys(codebook: list[dict[str, Any]], participants: list[str] | None) -> list[str]:
    """Output keys: window variables stay as-is; sender variables expand to "Var [P]"."""
    participants = participants or []
    keys: list[str] = []
    for var in codebook:
        label = str(var.get("label") or "").strip()
        if not label:
            continue
        if var.get("level") == "sender" and participants:
            for p in participants:
                keys.append(f"{label}_{p}")
        else:
            keys.append(label)
    if len(keys) != len(set(keys)):
        raise ValueError("Codebook output labels must be unique.")
    return keys


def expanded_codebook_specs(
    codebook: list[dict[str, Any]], participants: list[str] | None
) -> list[dict[str, Any]]:
    """Expand sender-level variables while retaining aggregation metadata."""
    participants = participants or []
    specs: list[dict[str, Any]] = []
    for variable in codebook:
        label = str(variable.get("label") or "").strip()
        if not label:
            continue
        keys = (
            [f"{label}_{participant}" for participant in participants]
            if variable.get("level") == "sender" and participants
            else [label]
        )
        values = [
            str(item.get("value") or "").strip()
            for item in (variable.get("values") or [])
            if str(item.get("value") or "").strip()
        ]
        for key in keys:
            specs.append(
                {
                    "key": key,
                    "type": str(variable.get("type") or "text").lower(),
                    "aggregation": str(variable.get("aggregation") or "mode").lower(),
                    "values": values,
                }
            )
    return specs


def categorical_output_key(label: str, value: str) -> str:
    """Return a stable, readable one-hot column name for a categorical value."""
    suffix = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value).strip()).strip("._-") or "blank"
    return f"{label}_{suffix}"


def aggregate_output_labels(
    codebook: list[dict[str, Any]], participants: list[str] | None
) -> list[str]:
    """Columns produced by aggregation; text is intentionally call-level only."""
    labels: list[str] = []
    for spec in expanded_codebook_specs(codebook, participants):
        if spec["type"] == "text":
            continue
        if spec["type"] == "categorical":
            labels.extend(categorical_output_key(spec["key"], value) for value in spec["values"])
        else:
            labels.append(spec["key"])
    if len(labels) != len(set(labels)):
        duplicates = sorted({label for label in labels if labels.count(label) > 1})
        raise ValueError(
            "Categorical values create duplicate aggregate columns: " + ", ".join(duplicates)
        )
    return labels


def _codebook_block(codebook: list[dict[str, Any]], participants: list[str]) -> str:
    """Render the codebook: each variable with its definition + optional examples/context,
    and a definition for every coded value."""
    out = ""
    for var in codebook:
        label = str(var.get("label") or "").strip()
        header = f"### {label} (type: {var.get('type', 'text')}"
        if var.get("level") == "sender" and participants:
            header += f"; coded separately per participant: {', '.join(participants)}"
        header += ")"
        out += header + "\n"
        if (var.get("definition") or "").strip():
            out += f"Definition: {var['definition'].strip()}\n"
        if (var.get("examples") or "").strip():
            out += f"Examples: {var['examples'].strip()}\n"
        if (var.get("context") or "").strip():
            out += f"Notes: {var['context'].strip()}\n"
        values = var.get("values") or []
        printable = [v for v in values if str(v.get("value", "")).strip()]
        if printable:
            out += "Coded values:\n"
            for v in printable:
                line = f"  - {v['value']}"
                if (v.get("definition") or "").strip():
                    line += f": {v['definition'].strip()}"
                if (v.get("examples") or "").strip():
                    line += f" (e.g., {v['examples'].strip()})"
                if (v.get("context") or "").strip():
                    line += f" — {v['context'].strip()}"
                out += line + "\n"
        out += "\n"
    return out


def _build_prompt(
    message_text: str,
    experiment_instructions: str,
    coding_instructions: str,
    codebook: list[dict[str, Any]],
    participants: list[str] | None = None,
    context_block: str = "",
) -> str:
    """Construct the full coding prompt for one row."""
    participants = participants or []
    context_section = f"\n## Context\n{context_block}" if context_block.strip() else ""
    codebook_block = _codebook_block(codebook, participants)

    keys = _expanded_keys(codebook, participants)
    sender_note = ""
    if any(var.get("level") == "sender" for var in codebook) and participants:
        sender_note = (
            "\n- For per-sender variables, output one value per participant using keys of the form "
            f'"Variable_Participant" (e.g. {keys[-1] if keys else "var_P"}; participants: {", ".join(participants)}). '
            "Each participant's messages are tagged with [participant] in the text above."
        )

    coding_section = f"\n## Coding Instructions\n{coding_instructions}\n" if coding_instructions.strip() else ""

    return f"""You are coding one row of data. One row = one episode of observation.

## Experiment Instructions
{experiment_instructions}
{coding_section}
## Codebook
{codebook_block}{context_section}
## Message to Code
{message_text}

## Output Requirements
- Return ONLY valid JSON
- Keys must exactly match: {keys}
- Each value must conform to the type and allowed values specified above{sender_note}
- Do not include any commentary, explanation, or markdown formatting
"""


def _parse_llm_json(text: str) -> dict | None:
    """Try to parse JSON from LLM response, handling markdown fences."""
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

    return None


def _first_not_none(*values: Any) -> Any:
    """Return the first explicitly supplied value, preserving valid zeroes."""
    return next((value for value in values if value is not None), None)


def _aggregate_numeric(values: list[float], aggregation: str) -> float | None:
    """Aggregate numeric values, using the median whenever a mode is not unique."""
    if not values:
        return None
    if aggregation == "mean":
        return stat_mean(values)
    counts = Counter(values)
    highest = max(counts.values())
    winners = [value for value, count in counts.items() if count == highest]
    return winners[0] if len(winners) == 1 else stat_median(values)


def aggregate_results(
    all_coded: list[dict[str, Any]],
    codebook: list[dict[str, Any]],
    participants: list[str] | None,
    fallback: str = "mode",
) -> dict[str, Any]:
    """Aggregate non-text variables and one-hot encode categorical outputs."""
    result: dict[str, Any] = {}
    for spec in expanded_codebook_specs(codebook, participants):
        label = spec["key"]
        variable_type = spec["type"]
        aggregation = spec["aggregation"] if spec["aggregation"] in {"mode", "mean"} else fallback
        values: list[Any] = []
        for item in all_coded:
            if "_error" in item:
                continue
            value = item.get(label)
            if value is None:
                continue
            try:
                if pd.isna(value):
                    continue
            except (TypeError, ValueError):
                pass
            values.append(value)

        if variable_type == "text":
            continue

        if variable_type == "categorical":
            permitted = spec["values"]
            valid = [str(value) for value in values if str(value) in permitted]
            for permitted_value in permitted:
                output_key = categorical_output_key(label, permitted_value)
                indicators = [1.0 if value == permitted_value else 0.0 for value in valid]
                result[output_key] = _aggregate_numeric(indicators, aggregation)
            continue

        try:
            numeric_values = [float(value) for value in values]
        except (TypeError, ValueError):
            numeric_values = []
        result[label] = _aggregate_numeric(numeric_values, aggregation)

    return result


def _aggregate_results(
    all_coded: list[dict[str, Any]],
    labels: list[str],
    aggregations: dict[str, str],
    fallback: str = "mode",
) -> dict[str, Any]:
    """Backward-compatible primitive used by older generated scripts."""
    result: dict[str, Any] = {}
    for label in labels:
        values = [item.get(label) for item in all_coded if item.get(label) is not None and "_error" not in item]
        try:
            numeric_values = [float(value) for value in values]
        except (TypeError, ValueError):
            numeric_values = []
        if numeric_values and len(numeric_values) == len(values):
            result[label] = _aggregate_numeric(
                numeric_values,
                aggregations.get(label, fallback),
            )
            continue
        counts = Counter(str(value) for value in values)
        result[label] = counts.most_common(1)[0][0] if counts else None
    return result


async def _code_with_model(
    p_info: dict[str, Any],
    *,
    prompt: str,
    row_idx: int,
    pass_num: int,
    passes: int,
    max_retries: int,
) -> tuple[str, dict | None, list[str]]:
    """One model's coding of one episode, retries included.

    Returns the coder label, the parsed coding (None if every attempt failed)
    and any messages to surface as errors. Problems come back as values rather
    than exceptions so that one model failing never cancels the others coding
    the same episode — each model's result stands on its own.
    """
    coder_label = f"{p_info['label']}__run{pass_num}" if passes > 1 else p_info["label"]
    slot_params = p_info.get("params", {})
    errors: list[str] = []
    parsed = None

    for attempt in range(1, max_retries + 1):
        try:
            result = await p_info["instance"].complete(
                prompt,
                system_prompt="You are a precise data coder. Return only valid JSON.",
                params={
                    "temperature": slot_params.get("temperature", 0.1),
                    "top_p":       slot_params.get("top_p", 1.0),
                    "max_tokens":  slot_params.get("max_tokens", 2048),
                },
            )
            parsed = _parse_llm_json(result["response"])
            if parsed:
                break
            if attempt == max_retries:
                errors.append(
                    f"Row {row_idx + 1} [{coder_label}]: JSON parse failed after {max_retries} retries"
                )
        except Exception as e:
            if attempt == max_retries:
                errors.append(f"Row {row_idx + 1} [{coder_label}]: {e}")

    return coder_label, parsed, errors


async def run_coding(
    *,
    df: pd.DataFrame,
    message_column: str,
    experiment_instructions: str,
    coding_instructions: str,
    codebook: list[dict[str, Any]],
    participants: list[str] | None = None,
    context: list[dict[str, str]] | None = None,
    model_slots: list[dict[str, str]] | None = None,
    runs_per_model: int = 1,
    aggregation: str = "mode",
    # Legacy single-model params (used if model_slots not provided)
    provider_name: str = "",
    empty_message_handling: str = "ignore", 
    model_id: str = "",
    api_key: str = "",
    max_retries: int = 3,
    episode_indices: list[int] | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    """
    Code each row and yield progress messages.

    Supports multiple models × runs_per_model with voting aggregation.
    """
    # Build provider instances
    if model_slots and len(model_slots) > 0:
        providers = []
        for slot in model_slots:
            p = _get_provider_instance(slot["provider"], slot["model"], slot["api_key"])

            gen_cfg = slot.get("generation_config") or {}
            params = {
                "temperature": _first_not_none(slot.get("temperature"), gen_cfg.get("temperature")),
                "top_p": _first_not_none(slot.get("top_p"), gen_cfg.get("topP")),
                "max_tokens": _first_not_none(
                    slot.get("max_tokens"),
                    slot.get("max_completion_tokens"),
                    gen_cfg.get("maxOutputTokens"),
                ),
            }
            # Strip Nones so defaults in complete() kick in for unset params
            params = {k: v for k, v in params.items() if v is not None}

            providers.append({
                "instance": p,
                "label": f"{slot['provider']}/{slot['model']}",
                "params": params,
            })
    else:
        providers = [{"instance": _get_provider_instance(provider_name, model_id, api_key), "label": f"{provider_name}/{model_id}"}]

    labels = _expanded_keys(codebook, participants)
    null_result = {label: None for label in labels}
    total = len(df)
    if episode_indices is None:
        episode_indices = list(range(total))
    if len(episode_indices) != total:
        raise ValueError("episode_indices must contain one index for every coding row")
    total_calls = len(providers) * runs_per_model
    use_voting = total_calls > 1
    coded_count = 0
    # Every successful model answer: episodes x models x passes. coded_count is the
    # number of distinct episodes that ended up with a result, which stays at 3 for
    # three episodes however many models and repeats coded them.
    codings = 0
    all_results = []

    # Repeated runs go round-robin: every episode once, then every episode again,
    # rather than hammering one episode N times before moving on. Asking the same
    # model the same question back-to-back invites correlated answers, and the
    # point of repeated runs is independent measurements. It also means a partial
    # run holds one complete pass over the data rather than a finished prefix.
    passes = max(1, runs_per_model)
    work_units = total * passes
    calls_by_episode: dict[int, list[dict[str, Any]]] = {i: [] for i in range(total)}
    done = 0

    for pass_num in range(1, passes + 1):
        final_pass = pass_num == passes
        for row_idx in range(total):
            row = df.iloc[row_idx]
            message = str(row[message_column]) if pd.notna(row[message_column]) else ""
            original = {col: (None if pd.isna(row[col]) else row[col]) for col in df.columns}

            # Convert numpy types
            for k, v in original.items():
                if hasattr(v, 'item'):
                    original[k] = v.item()
            detail_original = {
                **original,
                DETAIL_EPISODE_INDEX_COLUMN: int(episode_indices[row_idx]),
            }

            done += 1
            percent = round((done / work_units) * 100, 1)

            if not message.strip():
                if empty_message_handling == "ignore":
                    yield {"type": "progress", "current": done, "total": work_units, "percent": percent}
                    continue
                elif empty_message_handling == "code":
                    pass
                else:
                    # Recorded once, on the last pass, not once per pass.
                    coded = {**null_result, "_error": "empty_message"}
                    yield {"type": "progress", "current": done, "total": work_units, "percent": percent}
                    if final_pass:
                        all_results.append({**detail_original, **coded})
                        yield {"type": "row", "index": row_idx, "original": original, "coded": coded}
                    continue

            # Build context block from this unit's context columns
            context_block = ""
            for spec in (context or []):
                col = spec.get("column")
                if not col or col not in original:
                    continue
                val = original.get(col)
                if val is None or str(val).strip() == "":
                    continue
                desc = (spec.get("description") or "").strip()
                context_block += f"- {col}: {val}" + (f"  ({desc})" if desc else "") + "\n"

            prompt = _build_prompt(message, experiment_instructions, coding_instructions, codebook, participants, context_block)

            # Every model codes this episode at the same time; repeated runs of
            # one model stay sequential, because a pass is the outer loop. Models
            # are normally different providers, so this overlaps independent rate
            # limits rather than contending for one, and an episode costs about
            # as long as its slowest model instead of all of them added up.
            outcomes = await asyncio.gather(*(
                _code_with_model(
                    p_info,
                    prompt=prompt,
                    row_idx=row_idx,
                    pass_num=pass_num,
                    passes=passes,
                    max_retries=max_retries,
                )
                for p_info in providers
            ))

            # gather returns results in the order its arguments were given, so
            # the record stays in slot order however the calls interleaved. The
            # output must not depend on which provider happened to answer first.
            for coder_label, parsed, errors in outcomes:
                for error_message in errors:
                    yield {"type": "error", "index": row_idx, "message": error_message}
                if parsed:
                    codings += 1
                    calls_by_episode[row_idx].append(parsed)
                    all_results.append({**detail_original, "coder": coder_label, **parsed})
                else:
                    all_results.append({**detail_original, "coder": coder_label, **null_result, "_error": "api_failed"})

            yield {"type": "progress", "current": done, "total": work_units, "percent": percent}

            # An episode is only aggregated once every pass has contributed to it.
            if final_pass:
                call_results = calls_by_episode[row_idx]
                if call_results:
                    if use_voting:
                        coded = aggregate_results(call_results, codebook, participants, aggregation)
                        coded["_votes"] = len(call_results)
                        coded["_total_calls"] = total_calls
                    else:
                        coded = call_results[0]
                    coded_count += 1

                    if use_voting:
                        all_results.append({**detail_original, "coder": "__aggregated (per-variable)", **{k: v for k, v in coded.items() if not k.startswith("_")}})
                else:
                    coded = {**null_result, "_error": "all_calls_failed"}

                yield {"type": "row", "index": row_idx, "original": original, "coded": coded}

    # Save results
    # Reorder columns: original cols, coder, codebook labels, then any extra
    orig_cols = list(df.columns)
    ordered_cols = orig_cols + [DETAIL_EPISODE_INDEX_COLUMN, "coder"] + labels
    # Keep headers even when every episode was intentionally skipped. This
    # produces a valid empty CSV instead of a zero-byte artifact.
    # Rows are produced pass by pass, so sort by episode to keep the artifact laid
    # out the way it always has been: each episode's calls together, in order.
    if all_results:
        all_results.sort(key=lambda r: r.get(DETAIL_EPISODE_INDEX_COLUMN, 0))
    result_df = pd.DataFrame(all_results, columns=ordered_cols if not all_results else None)
    extra_cols = [c for c in result_df.columns if c not in ordered_cols]
    result_df = result_df[[c for c in ordered_cols + extra_cols if c in result_df.columns]]

    import tempfile, os
    output_dir = tempfile.mkdtemp(prefix="llm_coding_")
    output_path = os.path.join(output_dir, "coded_results.csv")
    result_df.to_csv(output_path, index=False)

    yield {
        "type": "complete",
        "total_rows": total,
        "coded_rows": coded_count,
        "codings": codings,
        "file_path": output_path,
    }
