"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import Instructions, { EXAMPLE_INSTRUCTIONS, ContactForm } from "@/app/tools/HowToPage";
import CatDocumentationPaper from "@/app/tools/CatDocumentationPaper";
import GuidedTour, { TourStep } from "@/app/tools/GuidedTour";
import HelpTip from "@/app/tools/HelpTip";
import PrivacyNotice from "@/app/tools/PrivacyNotice";
import MenuBar from "@/app/tools/MenuBar";
import RunProgress, { rememberRunKey, formatDuration, type JobStatus } from "@/app/tools/RunProgress";
import UsageStatistics from "@/app/tools/UsageStatistics";
import Acknowledgements from "@/app/tools/Acknowledgements";
import { StreamResponseError, streamJsonLines } from "@/lib/streamJsonLines";
import { gzipFileInit, gzipJsonInit, detectFirewallBlock, firewallBlockMessage, firewallErrorFromText } from "@/lib/gzipRequest";
import { RowSelectionMode, parseRowSpec, randomIndices, percentToCount } from "@/lib/rowSelection";
import {
  clearStoredUpload,
  getStoredUpload,
  saveStoredUpload,
  type StoredUploadMetadata,
} from "@/lib/uploadPersistence";

const CODING_TOUR_STEPS: TourStep[] = [
  // ── Section 1: Upload & map dataset ──
  {
    sectionId: "coding-panel-1", panel: 1, section: "Upload & Map Dataset",
    targetId: "tour-episode-preview", title: "Upload Your Dataset", mappingStage: "none",
    body: (<p>We have loaded a sample dataset. Each row represents a message by a sender. Later, we explain how to define communication <strong>episodes</strong>, which are combinations of messages to be coded.</p>),
  },
  // ── Map Columns popup — walk each step/role ──
  {
    sectionId: "tour-map-modal", section: "Map Columns", open: "mapping", mapRole: "message", mappingStage: "message",
    targetId: "tour-role-message", title: "Step 1 · Message",
    body: (<p>This popup opens right after upload. Work down the numbered steps — click a step, then click the columns below to tag them. <strong>Message</strong> (required) is the column that holds the actual message text being coded.</p>),
  },
  {
    sectionId: "tour-map-modal", section: "Map Columns", open: "mapping", mapRole: "identifier", mappingStage: "identifier",
    targetId: "tour-role-identifier", title: "Step 2 · Episode Identifier",
    body: (<p><strong>Episode identifier</strong> (required) defines what counts as one episode. Choose <em>Group rows</em> and tag the column(s) that group messages together (e.g. Session + Round) — or <em>Each row is its own episode</em>. Rows sharing the same values are merged into one episode.</p>),
  },
  {
    sectionId: "tour-map-modal", section: "Map Columns", open: "mapping", mapRole: "identity", mappingStage: "identity",
    targetId: "tour-role-identity", title: "Step 3 · Sender",
    body: (<p><strong>Sender</strong> (optional) identifies who wrote each message. When a codebook variable is set to <em>per sender</em>, CAT automatically detects the distinct names in this column and asks you to verify them; blank sender values must be corrected before coding.</p>),
  },
  {
    sectionId: "tour-map-modal", section: "Map Columns", open: "mapping", mapRole: "order", mappingStage: "order",
    targetId: "tour-role-order", title: "Step 4 · Order",
    body: (<p><strong>Order</strong> (optional) sequences messages within an episode. Tag a timestamp or turn-number column and choose ascending or descending order. If several rows have the same Order value, CAT preserves their order in the uploaded dataset.</p>),
  },
  {
    sectionId: "tour-map-modal", section: "Map Columns", open: "mapping", mapRole: "context", mappingStage: "context",
    targetId: "tour-role-context", title: "Step 5 · Context",
    body: (<p><strong>Context</strong> (optional) tags extra fields the model should know about, such as treatment condition or communication channel. Describe each selected field here. Because each episode receives one value for a Context field, CAT requires that field to match exactly across every source row grouped into the episode.</p>),
  },
  {
    sectionId: "tour-map-modal", section: "Map Columns", open: "mapping", mappingStage: "complete",
    targetId: "tour-map-table", title: "Tagging the Columns",
    body: (<p>With a step active, click a column header (or its cells) to tag it — the column highlights in that step&apos;s color. Click again to untag. Here <strong>Message</strong> is the Message, <strong>Session</strong> + <strong>Round</strong> are the Episode identifier, <strong>Speaker</strong> is the Sender, <strong>Order</strong> is the Order, and <strong>Treatment</strong> is Context.</p>),
  },
  {
    sectionId: "tour-map-modal", section: "Map Columns", open: "mapping", mappingStage: "complete",
    targetId: "tour-map-proceed", title: "Save & Proceed",
    body: (<p>Once the required steps (Message + Episode identifier) are done, click <strong>Save &amp; Proceed</strong>. CAT first checks that every selected Context field is consistent within each episode. Conflicts must be corrected in the source file or unselected before the grouped episode preview is created.</p>),
  },
  // ── Section 2: Codebook ──
  {
    sectionId: "coding-panel-2", panel: 2, section: "Codebook",
    targetId: "tour-empty-handling", title: "Empty Messages",
    body: (<p>Choose what happens to a fully empty episode: <strong>Ignore</strong> skips the model call but keeps its original rows in the primary CSV with blank code cells; <strong>Code as Value</strong> asks the model to apply the codebook to the empty episode.</p>),
  },
  {
    sectionId: "coding-panel-2", panel: 2, section: "Codebook",
    targetId: "tour-codebook", title: "Codebook Variables",
    body: (<p>This summary lists your variables. Click it to open the full editor and define what to code. After saving the codebook, use <strong>Download Codebook</strong> below the summary to export it in a standard format.</p>),
  },
  // ── Codebook editor popup ──
  {
    sectionId: "tour-cb-editor", section: "Codebook Editor", open: "codebook",
    targetId: "tour-cb-card", title: "Variable Card",
    body: (<p>Each variable is a card. Give it a <strong>label</strong>, a <strong>level</strong> (per episode or per sender), and a <strong>category definition</strong> describing what it measures.</p>),
  },
  {
    sectionId: "tour-cb-editor", section: "Codebook Editor", open: "codebook",
    targetId: "tour-cb-type", title: "Variable Type",
    body: (<p>Pick the <strong>type</strong> (hover the <span aria-hidden>?</span> for details): Binary is fixed 0/1, Categorical is your named set, Numeric a number, Text free-form. Per-sender variables expand to one column per detected sender; review and verify the automatically detected list before continuing.</p>),
  },
  {
    sectionId: "tour-cb-editor", section: "Codebook Editor", open: "codebook",
    targetId: "tour-cb-values", title: "Coded Values",
    body: (<p>For Binary/Categorical, define <strong>every coded value</strong> — the value, its definition, and optional examples/context. This is the guidance the model uses to code each episode.</p>),
  },
  {
    sectionId: "tour-cb-editor", section: "Codebook Editor", open: "codebook",
    targetId: "tour-cb-aggregation", title: "Aggregate Repeated Calls",
    body: (<p>Choose mode or mean for numeric and binary outputs. When mode has no unique winner, CAT uses the median; with an even number of responses, this is the average of the two middle values. For aggregation, CAT converts each categorical value into its own binary output column (for example, <code>option_a</code>, <code>option_b</code>, and <code>option_c</code>) and applies the selected rule to each column. CAT does not aggregate free-text variables or include them in the main aggregate file; it exports every text response in a separate text-results CSV.</p>),
  },
  {
    sectionId: "coding-panel-2", panel: 2, section: "Codebook",
    targetId: "tour-codebook-download", title: "Download the Codebook",
    body: (<p>After saving the variables, select a format and download the completed codebook for review, reuse, or project documentation. CAT supports JSON, CSV, text, PDF, Excel, and LaTeX exports.</p>),
  },
  // ── Section 3: Experiment Instructions ──
  {
    sectionId: "coding-panel-3", panel: 3, section: "Experiment Instructions",
    targetId: "tour-experiment-instructions",
    title: "Experiment Instructions",
    body: (<p>Paste the full instructions participants received — tasks, roles, payoffs, and communication rules — so the model has the same context they did.</p>),
  },
  {
    sectionId: "coding-panel-3", panel: 3, section: "Experiment Instructions",
    targetId: "tour-pdf-import", title: "Import Instructions from PDF",
    body: (<p>If the instructions are in a PDF, including figures or tables, import it here. Choose a supported LLM provider and model to convert the document into editable text before using it as experiment context.</p>),
  },
  // ── Section 4: Models & Runs ──
  {
    sectionId: "coding-panel-4", panel: 4, section: "Models & Runs",
    targetId: "tour-model-execution", title: "Browser vs. Downloaded Package",
    body: (<p><strong>Run Coding</strong> uses all configured models and can aggregate their calls. The <strong>downloaded package currently records only the first selected provider and model and uses them for one call per episode</strong>. CAT does not save an API key or the configured tuning settings for package generation; the local script obtains the key at runtime, and experienced users can edit the script to change its parameters.</p>),
  },
  {
    sectionId: "coding-panel-4", panel: 4, section: "Models & Runs",
    targetId: "tour-model-slots", title: "Models & API Keys",
    body: (<p>Add one or more provider and model configurations. An API key is required for each model used by <strong>Run Coding</strong>. It is optional when generating a local package because no key is stored in the download; the script requests it at runtime.</p>),
  },
  {
    sectionId: "coding-panel-4", panel: 4, section: "Models & Runs",
    targetId: "tour-runs", title: "Runs per Model",
    body: (<p>Choose how many independent calls each configured model makes for every episode. The results are then combined using the method selected separately for each codebook variable.</p>),
  },
  // ── Run ──
  {
    sectionId: "coding-run-bar", section: "Run",
    title: "Run or Generate a Package",
    body: (<p><strong>Generate Package</strong> prepares a ZIP containing the script, three CSV files (source rows, exact preprocessed episodes, and their row map), a README, and requirements. <strong>The package uses the first selected provider and model for one call per episode</strong>; repeated- and multi-model execution is available through <strong>Run Coding</strong> in the browser. The API key is not included; the local script reads <code>CAT_API_KEY</code> or prompts securely when it starts.</p>),
  },
  {
    sectionId: "tour-results-panel", targetId: "tour-result-downloads", section: "Results",
    title: "Review and Download Results",
    body: (<p>After browser coding, CAT validates the coded episodes and lets you re-run any that need attention. With two or more models, CAT also aggregates repeated runs within each model and reports pairwise agreement rates and Cohen&apos;s kappa for non-text aggregate outputs. A single download contains the complete results. With one model call, CAT returns the coded source-row CSV as before. With repeated or multi-model coding, CAT returns a ZIP containing overall results, per-LLM results, every original model/run result, and the inter-coder agreement CSV when applicable.</p>),
  },
];


// ── Types ─────────────────────────────────────────────────────────────────────

// One coded value within a variable, with its own definition + optional examples/context.
interface CodedValue {
  value: string;
  definition: string;
  examples: string;   // optional
  context: string;    // optional
}
interface CodebookEntry {
  label: string;
  type: string;
  level: "episode" | "sender";   // episode = one value per episode; sender = one value per participant
  aggregation: "mode" | "mean"; // how repeated model calls are combined for this variable
  definition: string;           // definition of the variable/category itself
  values: CodedValue[];         // one definition per possible coded value
}

const CODEBOOK_EXPORT_COLUMNS = [
  "label", "type", "level", "aggregation", "definition",
  "value", "value_definition", "examples", "context",
] as const;

interface ExpandedVar { key: string; type: string; coded_values: string; }

const codedValuesOf = (e: CodebookEntry) =>
  e.values.map((v) => v.value.trim()).filter(Boolean).join(",");

// Sender-level variables expand into one output key per participant: "Var [P]".
function expandCodebook(codebook: CodebookEntry[], participants: string[]): ExpandedVar[] {
  const out: ExpandedVar[] = [];
  for (const e of codebook) {
    const label = e.label.trim();
    if (!label) continue;
    const cv = codedValuesOf(e);
    if (e.level === "sender" && participants.length > 0) {
      for (const p of participants) out.push({ key: `${label}_${p}`, type: e.type, coded_values: cv });
    } else {
      out.push({ key: label, type: e.type, coded_values: cv });
    }
  }
  return out;
}

const aggregateValueSuffix = (value: string) =>
  value.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || "blank";

function expandAggregateResults(codebook: CodebookEntry[], participants: string[]): ExpandedVar[] {
  const out: ExpandedVar[] = [];
  for (const entry of codebook) {
    const label = entry.label.trim();
    if (!label || entry.type === "text") continue;
    const bases = entry.level === "sender" && participants.length > 0
      ? participants.map((participant) => `${label}_${participant}`)
      : [label];
    for (const base of bases) {
      if (entry.type === "categorical") {
        for (const value of entry.values.map((item) => item.value.trim()).filter(Boolean)) {
          out.push({ key: `${base}_${aggregateValueSuffix(value)}`, type: "numeric", coded_values: "" });
        }
      } else {
        out.push({ key: base, type: "numeric", coded_values: "" });
      }
    }
  }
  return out;
}

function duplicateExpandedKeys(variables: ExpandedVar[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const variable of variables) {
    if (seen.has(variable.key)) duplicates.add(variable.key);
    seen.add(variable.key);
  }
  return [...duplicates];
}

interface UploadResult {
  file_id: string;
  file_name: string;
  columns: string[];
  row_count: number;
  preview: Record<string, unknown>[];
}

type UploadAvailability = "none" | "restoring" | "ready" | "reupload-required";

class UploadUnavailableError extends Error {
  readonly code: string;

  constructor(message = "The uploaded dataset is no longer available on the server.", code = "UPLOAD_GONE") {
    super(message);
    this.name = "UploadUnavailableError";
    this.code = code;
  }
}

const isRestorableUploadCode = (code: unknown): code is "UPLOAD_GONE" | "UPLOAD_EXPIRED" =>
  code === "UPLOAD_GONE" || code === "UPLOAD_EXPIRED";

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("The coding action was stopped.", "AbortError");
};

async function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The coding action was stopped.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

const sameColumns = (left: string[], right: string[]) =>
  left.length === right.length && left.every((column, index) => column === right[index]);

async function parseUploadResponse(response: Response): Promise<UploadResult> {
  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  const raw = await response.text();
  if (!contentType.includes("application/json")) {
    const blocked = detectFirewallBlock(raw);
    if (blocked) throw new Error(firewallBlockMessage(blocked.supportId));
    const html = raw.trim().startsWith("<");
    throw new Error(
      html
        ? `The server returned an HTML page instead of upload data (HTTP ${response.status}).`
        : `The upload response had an unexpected content type (HTTP ${response.status}).`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`The server returned invalid upload data (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const detail = typeof data === "object" && data !== null && "detail" in data
      ? String((data as { detail?: unknown }).detail ?? "")
      : "";
    throw new Error(detail || response.statusText || `Upload failed (${response.status}).`);
  }

  const candidate = data as Partial<UploadResult>;
  const valid =
    typeof candidate.file_id === "string" && candidate.file_id.length > 0 &&
    typeof candidate.file_name === "string" &&
    Array.isArray(candidate.columns) && candidate.columns.every((column) => typeof column === "string") &&
    typeof candidate.row_count === "number" && Number.isFinite(candidate.row_count) && candidate.row_count >= 0 &&
    Array.isArray(candidate.preview) && candidate.preview.every((row) => typeof row === "object" && row !== null && !Array.isArray(row));
  if (!valid) throw new Error("The server returned an incomplete upload response. Please try again.");

  return candidate as UploadResult;
}

function downloadFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get("Content-Disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let name = "";
  if (encoded) {
    try { name = decodeURIComponent(encoded.trim().replace(/^"|"$/g, "")); } catch {}
  }
  if (!name) name = disposition.match(/filename="?([^";]+)"?/i)?.[1]?.trim() || fallback;
  return name.split(/[\\/]/).pop() || fallback;
}

async function parseDownloadArtifact(
  response: Response,
  expected: "csv" | "zip",
  fallbackFilename: string,
): Promise<{ blob: Blob; filename: string }> {
  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  const disposition = response.headers.get("Content-Disposition") || "";
  const expectedType = expected === "csv"
    ? contentType.includes("text/csv") || /\.csv(?:[";]|$)/i.test(disposition)
    : contentType.includes("application/zip") || contentType.includes("x-zip-compressed") || /\.zip(?:[";]|$)/i.test(disposition);
  const genericBinary = contentType.includes("application/octet-stream");

  if (response.ok && (expectedType || genericBinary)) {
    return { blob: await response.blob(), filename: downloadFilename(response, fallbackFilename) };
  }

  const raw = await response.text();
  const firewall = firewallErrorFromText(raw);
  if (firewall) throw firewall;
  let detail = "";
  let responseCode: string | null = null;
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as { detail?: unknown; code?: unknown };
      detail = typeof parsed.detail === "string" ? parsed.detail : "";
      responseCode = typeof parsed.code === "string" ? parsed.code : null;
    } catch {}
  }
  const errorCode = response.headers.get("X-CAT-Error-Code") || responseCode;
  if (isRestorableUploadCode(errorCode)) {
    throw new UploadUnavailableError(detail || "The uploaded dataset must be restored.", errorCode);
  }
  if (!detail && raw.trim().startsWith("<")) {
    const title = raw.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
    detail = `The server returned an HTML error page instead of the requested download (HTTP ${response.status}${title ? `: ${title}` : ""}).`;
  }
  if (!detail && response.ok) {
    detail = `The server returned an unexpected file type instead of a ${expected === "csv" ? "CSV dataset" : "ZIP archive"}.`;
  }
  throw new Error(detail || response.statusText || `Download failed (HTTP ${response.status}).`);
}

// Column-mapping picker
type ColRole = "message" | "identifier" | "identity" | "order" | "context";
const ROLE_META: Record<ColRole, { label: string; short: string; color: string; bg: string; hint: string }> = {
  message:    { label: "Message",         short: "MSG", color: "#2563eb", bg: "#dbeafe", hint: "Click the column that contains the message text." },
  identifier: { label: "Episode identifier", short: "ID", color: "#16a34a", bg: "#dcfce7", hint: "Click the column(s) that define one episode — e.g. session + round. Rows sharing the same combination are merged into one episode." },
  identity:   { label: "Sender",          short: "WHO", color: "#d97706", bg: "#fef3c7", hint: "Optional — click the column that says who sent each message. CAT will detect its distinct sender names automatically." },
  order:      { label: "Order",           short: "ORD", color: "#7c3aed", bg: "#ede9fe", hint: "Optional — click the column that orders messages within an episode. Ties keep the uploaded row order." },
  context:    { label: "Context",         short: "CTX", color: "#db2777", bg: "#fce7f3", hint: "Optional — click extra columns the model should know about. Each selected value must match exactly within an episode." },
};
const ROLE_ORDER: ColRole[] = ["message", "identifier", "identity", "order", "context"];



// Frontend mirror of the backend's _group_units: collapse rows sharing an
// identifier combination into one unit, tagging messages by sender and ordering
// them. Returns the original rows unchanged when no identifiers are chosen.
function isMissingPreprocessValue(value: unknown): boolean {
  return value == null || (typeof value === "number" && Number.isNaN(value));
}

// JSON arrays preserve both component boundaries and scalar types, unlike a
// display delimiter.  In particular, a missing identifier remains distinct
// from an intentional empty string, matching pandas groupby(dropna=False).
function preprocessGroupKey(row: Record<string, unknown>, idCols: string[]): string {
  return JSON.stringify(idCols.map((column) => {
    const value = row[column];
    if (isMissingPreprocessValue(value)) return ["missing"];
    if (typeof value === "number") return ["number", Object.is(value, -0) ? 0 : value];
    if (typeof value === "boolean") return ["boolean", value];
    if (typeof value === "string") return ["string", value];
    return [typeof value, value];
  }));
}

function preprocessValueKey(value: unknown): string {
  if (isMissingPreprocessValue(value)) return JSON.stringify(["missing"]);
  if (typeof value === "number") return JSON.stringify(["number", Object.is(value, -0) ? 0 : value]);
  if (typeof value === "boolean") return JSON.stringify(["boolean", value]);
  if (typeof value === "string") return JSON.stringify(["string", value]);
  return JSON.stringify([typeof value, value]);
}

interface ContextConflict {
  column: string;
  conflictingEpisodeCount: number;
  exampleEpisode: string;
  exampleValues: string[];
}

function displayMappingValue(value: unknown): string {
  return isMissingPreprocessValue(value) || (typeof value === "string" && value.trim() === "")
    ? "(blank)"
    : String(value);
}

function findContextConflicts(
  rows: Record<string, unknown>[],
  identifierColumns: string[],
  contextColumns: string[],
  rowsAsUnits: boolean,
): ContextConflict[] {
  if (rowsAsUnits || identifierColumns.length === 0 || contextColumns.length === 0) return [];
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = preprocessGroupKey(row, identifierColumns);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const conflicts: ContextConflict[] = [];
  for (const column of contextColumns) {
    let conflictingEpisodeCount = 0;
    let exampleEpisode = "";
    let exampleValues: string[] = [];
    for (const group of groups.values()) {
      const distinct = new Map<string, unknown>();
      for (const row of group) {
        const value = row[column];
        const key = preprocessValueKey(value);
        if (!distinct.has(key)) distinct.set(key, value);
      }
      if (distinct.size <= 1) continue;
      conflictingEpisodeCount += 1;
      if (!exampleEpisode) {
        exampleEpisode = identifierColumns
          .map((identifier) => `${identifier}=${displayMappingValue(group[0][identifier])}`)
          .join(", ");
        exampleValues = [...distinct.values()].map(displayMappingValue);
      }
    }
    if (conflictingEpisodeCount > 0) {
      conflicts.push({ column, conflictingEpisodeCount, exampleEpisode, exampleValues });
    }
  }
  return conflicts;
}

function detectSenders(rows: Record<string, unknown>[], identityColumn: string): { names: string[]; blankRows: number[] } {
  if (!identityColumn) return { names: [], blankRows: [] };
  const names: string[] = [];
  const seen = new Set<string>();
  const blankRows: number[] = [];
  rows.forEach((row, index) => {
    const value = row[identityColumn];
    if (isMissingPreprocessValue(value) || String(value).trim() === "") {
      blankRows.push(index + 1);
      return;
    }
    const name = String(value).trim();
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  });
  return { names, blankRows };
}

// Python compares strings by Unicode code point.  localeCompare can vary with
// the browser locale, so use an explicit code-point comparison for previews.
function comparePreprocessStrings(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const difference = a[i].codePointAt(0)! - b[i].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function buildPreprocessedRows(
  rows: Record<string, unknown>[],
  columns: string[],
  messageColumn: string,
  identifierColumns: string[],
  identityColumn: string,
  orderColumn: string,
  orderDirection: "asc" | "desc",
): Record<string, unknown>[] {
  const idCols = identifierColumns.filter((c) => columns.includes(c));
  if (idCols.length === 0 || !messageColumn) return rows;

  let work = rows.map((r, i) => ({ r, i }));
  if (orderColumn && columns.includes(orderColumn)) {
    const dir = orderDirection === "desc" ? -1 : 1;
    const presentValues = work
      .map(({ r }) => r[orderColumn])
      .filter((value) => !isMissingPreprocessValue(value));
    const valueTypes = new Set(presentValues.map((value) => typeof value));
    const numericOrder = [...valueTypes].every((type) => type === "number" || type === "boolean");
    const stringOrder = valueTypes.size === 0 || (valueTypes.size === 1 && valueTypes.has("string"));

    work = [...work].sort((a, b) => {
      const av = a.r[orderColumn], bv = b.r[orderColumn];
      const aMissing = isMissingPreprocessValue(av);
      const bMissing = isMissingPreprocessValue(bv);
      // pandas sort_values leaves missing values last in both directions.
      if (aMissing || bMissing) {
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
        return a.i - b.i;
      }

      let cmp = 0;
      if (numericOrder) {
        cmp = Number(av) - Number(bv);
      } else if (stringOrder) {
        cmp = comparePreprocessStrings(String(av), String(bv));
      }
      // A genuinely mixed Excel column generally cannot be ordered by pandas.
      // Preserve its source order here instead of inventing a browser-specific
      // ordering; the backend remains authoritative and will report the error.
      return cmp !== 0 ? cmp * dir : a.i - b.i; // stable tiebreak on original order
    });
  }

  const useIdentity = !!identityColumn && columns.includes(identityColumn);
  const groups = new Map<string, Record<string, unknown>[]>();
  const order: string[] = [];
  for (const { r } of work) {
    const key = preprocessGroupKey(r, idCols);
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(r);
  }

  return order.map((key) => {
    const g = groups.get(key)!;
    const parts = g.map((r) => {
      const msg = r[messageColumn] == null ? "" : String(r[messageColumn]);
      const who = r[identityColumn];
      return msg.trim() && useIdentity && who != null && String(who).trim() !== "" ? `[${who}] ${msg}` : msg;
    });
    const episode = { ...g[0], [messageColumn]: parts.join("\n") };
    for (const mappedColumn of [identityColumn, orderColumn]) {
      if (mappedColumn && columns.includes(mappedColumn) && mappedColumn !== messageColumn && !idCols.includes(mappedColumn)) {
        episode[mappedColumn] = g.map((r) => r[mappedColumn] == null ? "" : String(r[mappedColumn])).join("\n");
      }
    }
    return episode;
  });
}

interface GenerateResult {
  script: string;
  filename: string;
}

interface CodedRow {
  index: number;
  original: Record<string, unknown>;
  coded: Record<string, unknown>;
}

type ResultDownloadKind = "results";

interface ResultExportConfig {
  messageColumn: string;
  identifierColumns: string[];
  identityColumn: string;
  orderColumn: string;
  orderDirection: "asc" | "desc";
  context: { column: string; description: string }[];
  codebook: CodebookEntry[];
  participants: string[];
  models: { provider: string; model: string; temperature?: number; topP?: number; maxTokens?: number }[];
  runsPerModel: number;
  rowsAsUnits: boolean;
  episodeCount: number;
  modelCallCount: number;
  fingerprint: string;
}

/** The run configuration CAT keeps beside a server-side run's results. */
interface ServerRunConfig {
  message_column?: string;
  identifier_columns?: string[];
  identity_column?: string | null;
  order_column?: string | null;
  order_direction?: string;
  context?: { column: string; description: string }[];
  codebook?: CodebookEntry[];
  participants?: string[];
  model_slots?: { provider: string; model: string }[];
  runs_per_model?: number;
  rows_as_units?: boolean;
}

/**
 * Rebuild the export configuration from what the server stored with the run.
 *
 * Opened by link, this browser has no setup of its own — the validation,
 * agreement and export machinery all read this, so without it the run's page
 * could only offer a download.
 */
function exportConfigFromServer(config: ServerRunConfig, episodeCount: number): ResultExportConfig {
  const models = (config.model_slots ?? []).map((slot) => ({
    provider: slot.provider,
    model: slot.model,
  }));
  const runsPerModel = config.runs_per_model ?? 1;
  return {
    messageColumn: config.message_column ?? "",
    identifierColumns: config.identifier_columns ?? [],
    identityColumn: config.identity_column ?? "",
    orderColumn: config.order_column ?? "",
    orderDirection: config.order_direction === "desc" ? "desc" : "asc",
    context: config.context ?? [],
    codebook: config.codebook ?? [],
    participants: config.participants ?? [],
    models,
    runsPerModel,
    rowsAsUnits: !!config.rows_as_units,
    episodeCount,
    modelCallCount: models.length * runsPerModel,
    // Only used to notice the setup changing under a finished run, which cannot
    // happen for one restored from a link.
    fingerprint: "",
  };
}

/** What a run will cost in time, tokens and money, shown before it starts. */
interface RunEstimate {
  episodes: number;
  models: number;
  runs_per_model: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  tokens_per_call: number;
  seconds: number;
  timing_from_history: boolean;
  /** null when no selected model has a published rate on file. */
  cost_usd: number | null;
  cost_by_model: { model: string; cost_usd: number }[];
  /** Models left out of the total because CAT has no rate for them. */
  unpriced_models: string[];
  /** ISO date the rates were last checked, shown beside the figure. */
  prices_updated: string;
}

/** "2026-10-13" as "13 October 2026"; the raw string if it is not a date. */
function formatPriceDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

/** Dollars at a readable precision: fractions of a cent round up, not away. */
function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface RunProgress {
  current: number;
  total: number;
  percent: number;
}

interface CodingStreamMessage {
  type: "started" | "keepalive" | "progress" | "row" | "error" | "complete";
  current?: number;
  total?: number;
  percent?: number;
  index?: number;
  original?: Record<string, unknown>;
  coded?: Record<string, unknown>;
  code?: string;
  message?: string;
  total_rows?: number;
  coded_rows?: number;
  /** Successful model answers: episodes x models x runs. */
  codings?: number;
  file_path?: string;
}

interface InterCoderAgreementVariable {
  variable: string;
  agreement_rate: number | null;
  cohens_kappa: number | null;
  gwets_ac1: number | null;
  n: number;
}

interface InterCoderAgreementPair {
  model_a: string;
  model_b: string;
  variables: InterCoderAgreementVariable[];
}

/** One model's repeated runs, averaged over every pair of its runs. */
interface InterCoderAgreementWithinModel {
  model: string;
  run_count: number;
  runs: string[];
  /** How many run pairs were averaged into the rows below. */
  pair_count: number;
  variables: InterCoderAgreementVariable[];
}

interface InterCoderAgreementReport {
  /** True when two or more models ran, so they can be compared with each other. */
  eligible: boolean;
  /** True when at least one model ran more than once. */
  within_eligible: boolean;
  within_models: InterCoderAgreementWithinModel[];
  model_count: number;
  models: string[];
  numeric_variables: string[];
  /** Between-model comparisons, on each model's aggregated values. */
  pairs: InterCoderAgreementPair[];
}

/** The agreement/kappa table shared by both comparisons. */
function AgreementTable({ rows }: { rows: InterCoderAgreementVariable[] }) {
  return (
    <div className="table-wrap agreement-table-wrap">
      <table className="tbl tbl-compact agreement-table">
        <thead><tr><th>Variable</th><th>Agreement</th><th>Cohen&apos;s κ</th><th>AC1</th><th>N</th></tr></thead>
        <tbody>
          {rows.map((metric) => (
            <tr key={metric.variable}>
              <td>{metric.variable}</td>
              <td>{metric.agreement_rate == null ? "—" : `${metric.agreement_rate.toFixed(1)}%`}</td>
              <td>{metric.cohens_kappa == null ? "N/A" : metric.cohens_kappa.toFixed(3)}</td>
              <td>{metric.gwets_ac1 == null ? "N/A" : metric.gwets_ac1.toFixed(3)}</td>
              <td>{metric.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ValidationIssue {
  rowIndex: number;
  variable: string;
  value: unknown;
  expected: string;
  issueType: "out_of_range" | "not_numeric" | "api_error";
}

interface ValidationReport {
  totalRows: number;
  validRows: number;
  errorRows: number;
  outOfRangeRows: number;
  issues: ValidationIssue[];
  problematicIndices: number[];
}

// ── Single-row validation ─────────────────────────────────────────────────────

function checkRow(
  rowIndex: number,
  coded: Record<string, unknown>,
  vars: ExpandedVar[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (coded._error) {
    issues.push({ rowIndex, variable: "_error", value: coded._error, expected: "", issueType: "api_error" });
    return issues;
  }

  for (const entry of vars) {
    const value = coded[entry.key];

    if (entry.coded_values.trim()) {
      const allowed = entry.coded_values.split(",").map((v) => v.trim().toLowerCase());
      const actual = String(value ?? "").trim().toLowerCase();
      if (!allowed.includes(actual)) {
        issues.push({ rowIndex, variable: entry.key, value, expected: entry.coded_values, issueType: "out_of_range" });
      }
    }

    if (entry.type === "numeric" && value != null && value !== "") {
      if (isNaN(Number(value))) {
        issues.push({ rowIndex, variable: entry.key, value, expected: "numeric value", issueType: "not_numeric" });
      }
    }
  }

  return issues;
}

function validateCodedRows(rows: CodedRow[], vars: ExpandedVar[]): ValidationReport {
  const issues: ValidationIssue[] = [];

  for (const row of rows) {
    issues.push(...checkRow(row.index, row.coded, vars));
  }

  const problematicIndices = [...new Set(issues.map((i) => i.rowIndex))];
  const errorRows = new Set(issues.filter((i) => i.issueType === "api_error").map((i) => i.rowIndex)).size;
  const outOfRangeRows = new Set(issues.filter((i) => i.issueType !== "api_error").map((i) => i.rowIndex)).size;

  return {
    totalRows: rows.length,
    validRows: rows.length - problematicIndices.length,
    errorRows,
    outOfRangeRows,
    issues,
    problematicIndices,
  };
}

// ── Providers ─────────────────────────────────────────────────────────────────

const PROVIDERS: { value: string; label: string; models: { value: string; label: string; noTemperature?: boolean; noTopP?: boolean; temperatureMax?: number }[] }[] = [
  {
    value: "openai", label: "OpenAI", models: [
      { value: "gpt-6-astra", label: "GPT-6 Astra", noTemperature: true, noTopP: true },
      { value: "gpt-6.1-sol", label: "GPT-6.1 Sol", noTemperature: true, noTopP: true },
      { value: "gpt-6-luna", label: "GPT-6 Luna", noTemperature: true, noTopP: true },
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", noTemperature: true, noTopP: true },
      { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", noTemperature: true, noTopP: true },
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", noTemperature: true, noTopP: true },
      { value: "gpt-4.1", label: "GPT-4.1" },
      { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
      { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
    ],
  },
  {
    value: "gemini", label: "Google (Gemini)", models: [
      { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
      { value: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
      { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
      { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
      { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
      { value: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
    ],
  },
  {
    value: "deepseek", label: "DeepSeek", models: [
      { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro", noTemperature: true, noTopP: true },
      { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash", noTemperature: true, noTopP: true },
    ],
  },
  {
    value: "anthropic", label: "Anthropic (Claude)", models: [
      { value: "claude-fable-5-1", label: "Claude Fable 5.1", noTemperature: true, noTopP: true },
      { value: "claude-fable-5", label: "Claude Fable 5", noTemperature: true, noTopP: true },
      { value: "claude-opus-5", label: "Claude Opus 5", noTemperature: true, noTopP: true },
      { value: "claude-sonnet-5", label: "Claude Sonnet 5", noTemperature: true, noTopP: true },
      { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", noTopP: true, temperatureMax: 1 },
    ],
  },
  {
    value: "xai", label: "xAI (Grok)", models: [
      { value: "grok-4.7", label: "Grok 4.7" },
      { value: "grok-4.6", label: "Grok 4.6" },
      { value: "grok-4.5", label: "Grok 4.5" },
      { value: "grok-4.3", label: "Grok 4.3" },
    ],
  },
];

// Curated list of providers/models that support native PDF (document + vision)
// processing, used only by the "Import from PDF" converter for Experiment Instructions.
// Keep in sync with PDF_CAPABLE_MODELS in backend/app/routes/instructions.py.
const PDF_MODELS: { provider: string; label: string; models: { value: string; label: string }[] }[] = [
  {
    provider: "openai", label: "OpenAI", models: [
      { value: "gpt-6-astra", label: "GPT-6 Astra" },
      { value: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { value: "gpt-6-luna", label: "GPT-6 Luna" },
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { value: "gpt-4.1", label: "GPT-4.1" },
    ],
  },
  {
    provider: "gemini", label: "Google (Gemini)", models: [
      { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
      { value: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
      { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
      { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
      { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
      { value: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
    ],
  },
  {
    provider: "anthropic", label: "Anthropic (Claude)", models: [
      { value: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { value: "claude-fable-5", label: "Claude Fable 5" },
      { value: "claude-opus-5", label: "Claude Opus 5" },
      { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ],
  },
];

const CODEBOOK_TYPES = [
  { value: "binary", label: "Binary" },
  { value: "categorical", label: "Categorical" },
  { value: "numeric", label: "Numeric" },
  { value: "text", label: "Text" },
];

// Short explanation of each type, shown in the codebook editor's help tooltip.
const TYPE_HELP = (
  <>
    <strong>Binary</strong>: two fixed outcomes, always 0/1 (e.g. absent / present).<br />
    <strong>Categorical</strong>: unordered named categories you define (e.g. P / E / N).<br />
    <strong>Numeric</strong>: a number, no fixed value list (e.g. a count or amount).<br />
    <strong>Text</strong>: free-form text output, no fixed values.
  </>
);

const EMPTY_VALUE: CodedValue = { value: "", definition: "", examples: "", context: "" };
const binaryValues = (): CodedValue[] => [
  { value: "0", definition: "", examples: "", context: "" },
  { value: "1", definition: "", examples: "", context: "" },
];
// Binary variables have fixed 0/1 values; new variables default to binary.
const defaultAggregation = (type: string): "mode" | "mean" => type === "numeric" ? "mean" : "mode";
const newEntry = (): CodebookEntry => ({ label: "", type: "binary", level: "episode", aggregation: "mode", definition: "", values: binaryValues() });
const TYPE_HAS_VALUES = (t: string) => t === "binary" || t === "categorical";

// Watermark applied to every generated PDF.
const PDF_WATERMARK_CSS = `
  .ssel-watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-28deg);
    font-size:26px;font-weight:800;letter-spacing:.04em;color:#5b2d8e;opacity:.06;
    white-space:nowrap;text-align:center;line-height:1.4;z-index:0;pointer-events:none;}
  .ssel-footer{position:fixed;bottom:12px;left:0;right:0;text-align:center;
    font-size:8.5px;color:#a1a1aa;letter-spacing:.03em;pointer-events:none;}
  body>*:not(.ssel-watermark):not(.ssel-footer){position:relative;z-index:1;}
`;
const PDF_WATERMARK_HTML = `
  <div class="ssel-watermark">Social Science Experimental Laboratory<br/>New York University Abu Dhabi</div>
  <div class="ssel-footer">Generated by CAT (Communication Annotation Tool) — Social Science Experimental Laboratory, New York University Abu Dhabi</div>
`;
const htmlEsc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// Sample data used during the guided tour so the popups render populated.
const TOUR_SAMPLE_UPLOAD: UploadResult = {
  file_id: "__tour_sample__",
  file_name: "sample_conversations.csv",
  columns: ["Session", "Round", "Speaker", "Order", "Message", "Treatment"],
  row_count: 6,
  preview: [
    { Session: 1, Round: 1, Speaker: "P", Order: 1, Message: "Let's both choose In.", Treatment: "communication" },
    { Session: 1, Round: 1, Speaker: "V1", Order: 2, Message: "Sounds good, I'm in.", Treatment: "communication" },
    { Session: 1, Round: 1, Speaker: "P", Order: 3, Message: "Great — I'll roll.", Treatment: "communication" },
    { Session: 1, Round: 2, Speaker: "P", Order: 1, Message: "Same plan this round?", Treatment: "communication" },
    { Session: 1, Round: 2, Speaker: "V1", Order: 2, Message: "Yes, let's do it.", Treatment: "communication" },
    { Session: 2, Round: 1, Speaker: "V2", Order: 1, Message: "I'll pass this time.", Treatment: "baseline" },
  ],
};
const TOUR_SAMPLE_INSTRUCTIONS = "Participants communicate before choosing between In and Out. Their payoffs depend on both participants' choices. Messages may contain proposals, promises, or refusals.";
const tourSampleCodebook = (): CodebookEntry[] => [{
  label: "cooperation",
  type: "categorical",
  level: "episode",
  aggregation: "mode",
  definition: "Does the episode reach a cooperative agreement?",
  values: [
    { value: "yes", definition: "Both players agree to cooperate", examples: "“let's both choose In”", context: "Include explicit mutual commitments, even when phrased informally." },
    { value: "no", definition: "No agreement is reached", examples: "", context: "" },
    { value: "mixed", definition: "Partial or ambiguous agreement", examples: "", context: "Use when agreement is conditional or one participant remains ambiguous." },
  ],
}];
const TOUR_SAMPLE_CODED_ROWS: CodedRow[] = [
  {
    index: 0,
    original: { Message: "[P] Let's both choose In.\n[V1] Sounds good, I'm in.\n[P] Great — I'll roll." },
    coded: { cooperation: "yes" },
  },
  {
    index: 1,
    original: { Message: "[P] Same plan this round?\n[V1] Yes, let's do it." },
    coded: { cooperation: "yes" },
  },
  {
    index: 2,
    original: { Message: "[V2] I'll pass this time." },
    coded: { cooperation: "no" },
  },
];
const TOUR_SAMPLE_VALIDATION: ValidationReport = {
  totalRows: 3,
  validRows: 3,
  errorRows: 0,
  outOfRangeRows: 0,
  issues: [],
  problematicIndices: [],
};

// ── ModelSlot type ────────────────────────────────────────────────────────────

interface ModelSlot {
  provider: string;
  model: string;
  apiKey: string;
  showKey?: boolean;
  tuningEnabled?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

type SetupAction = "package" | "run";

interface SetupIssue {
  key: string;
  panel: 1 | 2 | 3 | 4;
  message: string;
  codebookIndex?: number;
  modelIndex?: number;
  field?: "label" | "type" | "provider" | "model" | "apiKey";
}

const EMPTY_SLOT: ModelSlot = {
  provider: "openai",
  model: "gpt-4.1-mini",
  apiKey: "",
  showKey: false,
  tuningEnabled: true,   // tuning is always on (no toggle); params always sent
  temperature: 0.2,
  topP: 1.0,
  maxTokens: 1024,
};

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4.1-mini",
  gemini: "gemini-3.7-flash",
  deepseek: "deepseek-v4-flash",
  anthropic: "claude-sonnet-5",
  xai: "grok-4.5",
};

function normalizeModelSlot(slot: ModelSlot): ModelSlot {
  const providerInfo = PROVIDERS.find((provider) => provider.value === slot.provider);
  if (!providerInfo) return { ...EMPTY_SLOT };

  const modelExists = providerInfo.models.some((model) => model.value === slot.model);
  return {
    ...EMPTY_SLOT,
    ...slot,
    model: modelExists
      ? slot.model
      : (PROVIDER_DEFAULT_MODELS[slot.provider] ?? providerInfo.models[0]?.value ?? ""),
    apiKey: "",
  };
}

function modelIgnoresTemperature(provider: string, model: string): boolean {
  const provInfo = PROVIDERS.find((p) => p.value === provider);
  const modelInfo = provInfo?.models.find((m) => m.value === model);
  return modelInfo?.noTemperature === true;
}

function modelIgnoresTopP(provider: string, model: string): boolean {
  const provInfo = PROVIDERS.find((p) => p.value === provider);
  const modelInfo = provInfo?.models.find((m) => m.value === model);
  return modelInfo?.noTopP === true;
}

function modelTemperatureMax(provider: string, model: string): number {
  const provInfo = PROVIDERS.find((p) => p.value === provider);
  const modelInfo = provInfo?.models.find((m) => m.value === model);
  return modelInfo?.temperatureMax ?? 2;
}

function buildSlotPayload(slot: ModelSlot) {
  const base = {
    provider: slot.provider,
    model: slot.model,
    api_key: slot.apiKey,
  };

  if (!slot.tuningEnabled) return base;

  const noTemp = modelIgnoresTemperature(slot.provider, slot.model);
  const noTopP = modelIgnoresTopP(slot.provider, slot.model);
  const temperature = Math.min(slot.temperature ?? 0.2, modelTemperatureMax(slot.provider, slot.model));

  if (slot.provider === "gemini") {
    return {
      ...base,
      generation_config: {
        ...(noTemp ? {} : { temperature }),
        ...(noTopP ? {} : { topP: slot.topP }),
        maxOutputTokens: slot.maxTokens,
      },
    };
  }

  if (slot.provider === "deepseek") {
    return {
      ...base,
      ...(noTemp ? {} : { temperature }),
      ...(noTopP ? {} : { top_p: slot.topP }),
      max_tokens: slot.maxTokens,
    };
  }

  return {
    ...base,
    ...(noTemp ? {} : { temperature }),
    ...(noTopP ? {} : { top_p: slot.topP }),
    max_completion_tokens: slot.maxTokens,
  };
}


// ── Component ─────────────────────────────────────────────────────────────────

type ActiveTool = "coding" | "instructions" | "documentation" | "versions" | "contact" | "privacy" | "usage" | "acknowledgements" | "run";

const TOOL_PATHS: Record<ActiveTool, string> = {
  coding: "/coding",
  instructions: "/learn-cat",
  documentation: "/documentation",
  versions: "/versions",
  contact: "/contact",
  privacy: "/privacy",
  usage: "/usage",
  acknowledgements: "/acknowledgements",
  // Each server-side run has its own link; this is only the prefix.
  run: "/runs",
};

function toolForPath(pathname: string): ActiveTool {
  if (pathname.startsWith("/learn-cat")) return "instructions";
  if (pathname.startsWith("/documentation")) return "documentation";
  if (pathname.startsWith("/versions")) return "versions";
  if (pathname.startsWith("/contact")) return "contact";
  if (pathname.startsWith("/privacy")) return "privacy";
  if (pathname.startsWith("/usage")) return "usage";
  if (pathname.startsWith("/acknowledgements")) return "acknowledgements";
  if (pathname.startsWith("/runs/")) return "run";
  return "coding";
}

export default function CatApp() {
  const pathname = usePathname();
  const router = useRouter();
  const activeTool = toolForPath(pathname);
  const navigateToTool = useCallback((tool: ActiveTool) => {
    router.push(TOOL_PATHS[tool]);
  }, [router]);
  const [analyticsConsent, setAnalyticsConsent] = useState<"loading" | "undecided" | "accepted" | "rejected">("loading");
  const [tourOpen, setTourOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);

  useEffect(() => {
    if (analyticsConsent !== "accepted" && analyticsConsent !== "rejected") return;
    try {
      if (localStorage.getItem("coding_welcome_dismissed") === "never") return;
    } catch {}
    const t = setTimeout(() => setShowWelcome(true), 600);
    return () => clearTimeout(t);
  }, [analyticsConsent]);

  const dismissWelcome = (mode: "tour" | "later" | "never" | "guide") => {
    if (mode === "never") {
      try { localStorage.setItem("coding_welcome_dismissed", "never"); } catch {}
    }
    setShowWelcome(false);
    if (mode === "tour") { startTour(); }
    else if (mode === "guide") { navigateToTool("instructions"); }
  };

  // Layout mode for the config column: fill (settings take the page),
  // side (settings as a sidebar next to results), hidden (results only).
  const [layoutMode, setLayoutMode] = useState<"fill" | "side" | "hidden">("fill");
  const collapseLayout = () => setLayoutMode((m) => (m === "fill" ? "side" : "hidden"));
  const expandLayout = () => setLayoutMode((m) => (m === "hidden" ? "side" : "fill"));

  // File upload state
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadNotice, setUploadNotice] = useState("");
  const [uploadAvailability, setUploadAvailability] = useState<UploadAvailability>("none");
  const [uploadMeta, setUploadMeta] = useState<StoredUploadMetadata | null>(null);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const liveUploadIdRef = useRef<string | null>(null);
  const restoreStartedRef = useRef(false);
  const restorePromiseRef = useRef<Promise<UploadResult | null> | null>(null);
  const uploadPreflightRef = useRef<{ fileId: string; promise: Promise<UploadResult> } | null>(null);
  const uploadRequestRef = useRef<{ token: number; controller: AbortController } | null>(null);
  const uploadTokenRef = useRef(0);
  const uploadLifecycleRef = useRef(0);
  const codingActionBusyRef = useRef(false);


  // Form state
  const [messageColumn, setMessageColumn] = useState("");

  // Column mapping (full-screen picker)
  const [identifierColumns, setIdentifierColumns] = useState<string[]>([]);
  const [identityColumn, setIdentityColumn] = useState("");
  const [orderColumn, setOrderColumn] = useState("");
  const [orderDirection, setOrderDirection] = useState<"asc" | "desc">("asc");
  const [contextColumns, setContextColumns] = useState<string[]>([]);
  const [contextDescriptions, setContextDescriptions] = useState<Record<string, string>>({});
  const [contextConflictAlert, setContextConflictAlert] = useState<ContextConflict[] | null>(null);
  const [rowsAsUnits, setRowsAsUnits] = useState(false); // identifier = each row is its own unit

  // Step 1 source-row subset (code only part of the uploaded dataset).
  const [rowSelectionMode, setRowSelectionMode] = useState<RowSelectionMode>("all");
  const [rowSelectionCount, setRowSelectionCount] = useState("");
  const [rowSelectionPercent, setRowSelectionPercent] = useState("");
  const [rowSelectionSpec, setRowSelectionSpec] = useState("");
  const [rowSelectionSeed, setRowSelectionSeed] = useState(() => (Math.random() * 2 ** 31) | 0);
  const [columnModalOpen, setColumnModalOpen] = useState(false);
  const [colMapError, setColMapError] = useState("");
  const [mapValidationAttempted, setMapValidationAttempted] = useState(false);
  const [codebookSaveAttempted, setCodebookSaveAttempted] = useState(false);
  const [exportFormat, setExportFormat] = useState<"json" | "csv" | "txt" | "pdf" | "xlsx" | "latex">("csv");
  const [activeRole, setActiveRole] = useState<ColRole>("message");
  // Snapshots for save/discard on the two popups, and a flag guarding first hydration.
  const codebookSnapshotRef = useRef<string | null>(null);
  const mapSnapshotRef = useRef<string | null>(null);
  const hydratedRef = useRef(false);
  const [experimentInstructions, setExperimentInstructions] = useState("");

  // "Import from PDF" converter for the experiment instructions.
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfProvider, setPdfProvider] = useState<string>(PDF_MODELS[0].provider);
  const [pdfModel, setPdfModel] = useState<string>(PDF_MODELS[0].models[0].value);
  const [pdfApiKey, setPdfApiKey] = useState("");
  const [pdfShowKey, setPdfShowKey] = useState(false);
  const [pdfConverting, setPdfConverting] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const [pdfResultText, setPdfResultText] = useState<string | null>(null);
  const [pdfDragOver, setPdfDragOver] = useState(false);
  const [pdfValidationAttempted, setPdfValidationAttempted] = useState(false);
  const pdfFileRef = useRef<HTMLInputElement>(null);

  const choosePdfFile = (file: File | null) => {
    if (file && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setPdfFile(null); setPdfError("Choose a PDF file."); return;
    }
    setPdfFile(file); setPdfError(""); setPdfResultText(null);
  };

  const openPdfModal = () => {
    setPdfFile(null); setPdfError(""); setPdfResultText(null); setPdfConverting(false);
    setPdfValidationAttempted(false);
    setPdfModalOpen(true);
  };
  const closePdfModal = () => { if (!pdfConverting) setPdfModalOpen(false); };

  const convertPdf = async () => {
    setPdfValidationAttempted(true);
    if (!pdfFile || !pdfApiKey.trim()) return;
    setPdfConverting(true); setPdfError(""); setPdfResultText(null);
    try {
      const fd = new FormData();
      fd.append("file", pdfFile);
      fd.append("provider", pdfProvider);
      fd.append("model", pdfModel);
      fd.append("api_key", pdfApiKey);
      const res = await fetch("/api/instructions/convert-pdf", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || "Conversion failed.");
      setPdfResultText(data.text || "");
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : "Conversion failed.");
    } finally {
      setPdfConverting(false);
    }
  };

  const applyPdfText = () => {
    if (pdfResultText != null) setExperimentInstructions(pdfResultText);
    setPdfModalOpen(false);
  };
  const [codebook, setCodebook] = useState<CodebookEntry[]>([newEntry()]);
  const [senderVerificationSignature, setSenderVerificationSignature] = useState("");

  // The uploaded preview holds every source row, so the row subset is resolved
  // here into concrete 0-based indices and applied to everything downstream
  // (sender detection, episode grouping, preview, coding, package). The same
  // index list is sent to the backend, which slices the file before grouping.
  const totalSourceRows = uploadResult?.preview?.length ?? 0;
  const rowSelection = useMemo<{ indices: number[] | null; count: number; error: string | null }>(() => {
    if (!uploadResult || totalSourceRows === 0 || rowSelectionMode === "all") {
      return { indices: null, count: totalSourceRows, error: null };
    }
    if (rowSelectionMode === "count") {
      const n = parseInt(rowSelectionCount, 10);
      if (!rowSelectionCount.trim() || !Number.isFinite(n) || n < 1) {
        return { indices: null, count: 0, error: "Enter how many rows to code (1 or more)." };
      }
      const k = Math.min(n, totalSourceRows);
      return { indices: randomIndices(totalSourceRows, k, rowSelectionSeed), count: k, error: null };
    }
    if (rowSelectionMode === "percent") {
      const p = parseFloat(rowSelectionPercent);
      if (!rowSelectionPercent.trim() || !Number.isFinite(p) || p <= 0 || p > 100) {
        return { indices: null, count: 0, error: "Enter a percentage between 0 and 100." };
      }
      const k = percentToCount(p, totalSourceRows);
      return { indices: randomIndices(totalSourceRows, k, rowSelectionSeed), count: k, error: null };
    }
    const parsed = parseRowSpec(rowSelectionSpec, totalSourceRows);
    if (parsed.error) return { indices: null, count: 0, error: parsed.error };
    return { indices: parsed.indices, count: parsed.indices.length, error: null };
  }, [uploadResult, totalSourceRows, rowSelectionMode, rowSelectionCount, rowSelectionPercent, rowSelectionSpec, rowSelectionSeed]);
  const selectedSourceIndices = rowSelection.indices; // null = all rows
  const effectiveRows = useMemo(
    () => (selectedSourceIndices && uploadResult
      ? selectedSourceIndices.map((i) => uploadResult.preview[i]).filter(Boolean)
      : uploadResult?.preview ?? []),
    [selectedSourceIndices, uploadResult],
  );
  const effectiveRowCount = selectedSourceIndices ? selectedSourceIndices.length : (uploadResult?.row_count ?? 0);

  const detectedSenderInfo = useMemo(
    () => detectSenders(effectiveRows, identityColumn),
    [effectiveRows, identityColumn],
  );
  const participants = detectedSenderInfo.names;
  const currentSenderSignature = useMemo(
    () => JSON.stringify({
      identityColumn,
      participants,
      blankRows: detectedSenderInfo.blankRows,
      rowCount: effectiveRowCount,
    }),
    [identityColumn, participants, detectedSenderInfo.blankRows, effectiveRowCount],
  );
  const hasSenderVar = codebook.some((entry) => entry.level === "sender");
  const senderListVerified = senderVerificationSignature === currentSenderSignature;
  const currentContextConflicts = useMemo(
    () => findContextConflicts(
      effectiveRows,
      identifierColumns,
      contextColumns,
      rowsAsUnits,
    ),
    [effectiveRows, identifierColumns, contextColumns, rowsAsUnits],
  );
  const expandedVars = useMemo(() => expandCodebook(codebook, participants), [codebook, participants]);
  const aggregateVars = useMemo(() => expandAggregateResults(codebook, participants), [codebook, participants]);
  const duplicateCodeLabels = useMemo(() => duplicateExpandedKeys(expandedVars), [expandedVars]);
  const duplicateAggregateLabels = useMemo(() => duplicateExpandedKeys(aggregateVars), [aggregateVars]);

  // Model slots
  const [modelSlots, setModelSlots] = useState<ModelSlot[]>([{ ...EMPTY_SLOT }]);
  const [runsPerModel, setRunsPerModel] = useState(1);

  // Legacy aliases
  const provider = modelSlots[0]?.provider ?? "openai";
  const model = modelSlots[0]?.model ?? "gpt-4.1-mini";

  // Generate state
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [setupIssues, setSetupIssues] = useState<SetupIssue[]>([]);
  const setupValidationSnapshotsRef = useRef<Record<SetupIssue["panel"], string> | null>(null);

  // Run state
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState<RunProgress | null>(null);
  const [codedRows, setCodedRows] = useState<CodedRow[]>([]);
  const [runErrors, setRunErrors] = useState<string[]>([]);
  const [runComplete, setRunComplete] = useState<{ total_rows: number; coded_rows: number; file_path: string } | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<string | null>(null);
  const [runFinishedAt, setRunFinishedAt] = useState<string | null>(null);
  const [runError, setRunError] = useState("");
  // Opt-in: let the run finish on the server and be emailed, so a dropped
  // connection no longer destroys it. Off by default — the browser path is
  // unchanged for everyone who does not ask for this.
  const [runOnServer, setRunOnServer] = useState(false);
  const [resultEmail, setResultEmail] = useState("");
  const [serverRunToken, setServerRunToken] = useState("");
  const [serverRunKey, setServerRunKey] = useState("");
  const [serverRunError, setServerRunError] = useState("");
  const [startingServerRun, setStartingServerRun] = useState(false);
  // A run is a long, paid operation, so it is confirmed against an estimate
  // rather than started straight from the button.
  const [pendingRun, setPendingRun] = useState<null | "browser" | "server">(null);
  const [estimate, setEstimate] = useState<RunEstimate | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [estimateError, setEstimateError] = useState("");
  // Whether this deployment can actually send mail. Until the relay exists the
  // run still works and the link still works, so the option stays — it just does
  // not ask for an address it would never use.
  const [emailNotifications, setEmailNotifications] = useState(false);
  const runAbortRef = useRef<AbortController | null>(null);
  const runActionGenerationRef = useRef(0);
  const runActionRef = useRef<{ token: number; controller: AbortController } | null>(null);
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [resultDownloadKind, setResultDownloadKind] = useState<ResultDownloadKind | null>(null);
  const [resultDownloadError, setResultDownloadError] = useState("");
  const [resultExportConfig, setResultExportConfig] = useState<ResultExportConfig | null>(null);
  const [agreementReport, setAgreementReport] = useState<InterCoderAgreementReport | null>(null);
  const [agreementLoading, setAgreementLoading] = useState(false);
  const [agreementError, setAgreementError] = useState("");
  const [agreementRequestVersion, setAgreementRequestVersion] = useState(0);
  const aggregationActive = (resultExportConfig?.modelCallCount ?? modelSlots.length * runsPerModel) > 1;
  const resultVars = useMemo(() => {
    const resultCodebook = resultExportConfig?.codebook ?? codebook;
    const resultParticipants = resultExportConfig?.participants ?? participants;
    return aggregationActive
      ? expandAggregateResults(resultCodebook, resultParticipants)
      : expandCodebook(resultCodebook, resultParticipants);
  }, [aggregationActive, codebook, participants, resultExportConfig]);
  const codedRowsRef = useRef<CodedRow[]>([]);

  // Console
  const [consoleLogs, setConsoleLogs] = useState<{ time: string; level: "info" | "warn" | "error"; msg: string }[]>([]);
  const consoleRef = useRef<HTMLDivElement>(null);

  const [emptyMessageHandling, setEmptyMessageHandling] = useState<"ignore" | "code">("ignore");
  const [rightView, setRightView] = useState<"script" | "run">("script");
  const [expandedTable, setExpandedTable] = useState<string | null>(null);

  // Toast
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3000);
  };

  // Panel state
  const [openPanels, setOpenPanels] = useState<Set<number>>(new Set([1]));
  const [skipPanelAnim, setSkipPanelAnim] = useState(false);

  const togglePanel = (n: number) => {
    setSkipPanelAnim(false);
    setOpenPanels((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n); else next.add(n);
      return next;
    });
  };

  useEffect(() => { codedRowsRef.current = codedRows; }, [codedRows]);

  // ── Consent-gated usage analytics (never keys or dataset content) ───────────
  // The backend sits behind the Next.js proxy, so it can't see the visitor's real
  // IP. Resolve the client's public IP once (client-side) and send it in the payload.
  const clientIpRef = useRef<string | null>(null);
  const getClientIp = async (): Promise<string> => {
    if (clientIpRef.current !== null) return clientIpRef.current;
    try {
      const r = await fetch("https://api.ipify.org?format=json");
      const j = await r.json();
      clientIpRef.current = typeof j?.ip === "string" ? j.ip : "";
    } catch { clientIpRef.current = ""; }
    return clientIpRef.current ?? "";
  };
  const trackEvent = async (
    event: "visit" | "run" | "run_complete",
    extra: Record<string, unknown> = {},
    choice = analyticsConsent,
  ) => {
    try {
      if (choice === "rejected") {
        if (event === "visit") {
          fetch("/api/analytics/track", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: "visit", consent: "rejected" }),
            keepalive: true,
          }).catch(() => {});
        }
        return;
      }
      if (choice !== "accepted") return;
      let sid = localStorage.getItem("ssel_session_id");
      if (!sid) { sid = (crypto.randomUUID?.() ?? String(Date.now() + Math.random())); localStorage.setItem("ssel_session_id", sid); }
      const client_ip = await getClientIp();
      const body: Record<string, unknown> = { event, consent: "accepted", session_id: sid, client_ip, ...extra };
      if (event === "run") {
        body.providers = modelSlots.map((s) => s.provider);
        body.models = modelSlots.map((s) => s.model);
        body.num_models = modelSlots.length;
        body.runs_per_model = runsPerModel;
        body.aggregation = "per-variable";
        body.num_variables = codebook.filter((e) => e.label.trim()).length;
        body.num_rows = effectiveRowCount;
        body.num_episodes = rowsAsUnits ? effectiveRowCount : preprocessedRows.length;
        body.per_sender = codebook.some((e) => e.level === "sender");
      }
      fetch("/api/analytics/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
    } catch {}
  };

  // A server-side run outlives this tab, so offer it back on return. This is what
  // makes the feature work even when mail is unavailable or never requested.
  const [rememberedRun, setRememberedRun] = useState("");
  useEffect(() => {
    try {
      setRememberedRun(localStorage.getItem("cat_last_server_run") || "");
    } catch { /* private window */ }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch("/api/coding/capabilities", { signal: controller.signal });
        if (!response.ok) return;
        const caps = (await response.json()) as { email_notifications?: boolean };
        setEmailNotifications(!!caps.email_notifications);
      } catch { /* assume no mail; the run and its link work either way */ }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("cat_analytics_consent");
      setAnalyticsConsent(saved === "accepted" || saved === "rejected" ? saved : "undecided");
    } catch {
      setAnalyticsConsent("undecided");
    }
  }, []);

  // Count one visit per browser session only after the visitor makes a choice.
  useEffect(() => {
    if (analyticsConsent !== "accepted" && analyticsConsent !== "rejected") return;
    try { if (sessionStorage.getItem("ssel_visited")) return; sessionStorage.setItem("ssel_visited", "1"); } catch {}
    void trackEvent("visit", {}, analyticsConsent);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyticsConsent]);

  const chooseAnalytics = (choice: "accepted" | "rejected") => {
    try { localStorage.setItem("cat_analytics_consent", choice); } catch {}
    setAnalyticsConsent(choice);
  };

  // ── Persistence: keep the whole coding setup across refreshes ────────────────
  const PERSIST_KEY = "chat_coding_v1";
  // Hydrate once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        const storedMeta = s.uploadMeta && typeof s.uploadMeta === "object"
          ? s.uploadMeta as Partial<StoredUploadMetadata>
          : null;
        const legacyUpload = s.uploadResult && typeof s.uploadResult === "object"
          ? s.uploadResult as Partial<UploadResult>
          : null;
        const restoredMeta: StoredUploadMetadata | null = storedMeta && typeof storedMeta.name === "string"
          ? {
              name: storedMeta.name,
              type: typeof storedMeta.type === "string" ? storedMeta.type : "",
              size: typeof storedMeta.size === "number" ? storedMeta.size : 0,
              lastModified: typeof storedMeta.lastModified === "number" ? storedMeta.lastModified : 0,
              columns: Array.isArray(storedMeta.columns) ? storedMeta.columns.filter((c): c is string => typeof c === "string") : [],
            }
          : legacyUpload && typeof legacyUpload.file_name === "string"
            ? {
                name: legacyUpload.file_name,
                type: "",
                size: 0,
                lastModified: 0,
                columns: Array.isArray(legacyUpload.columns) ? legacyUpload.columns.filter((c): c is string => typeof c === "string") : [],
              }
            : null;
        if (restoredMeta) {
          setUploadMeta(restoredMeta);
          setUploadAvailability("restoring");
        }
        if (typeof s.messageColumn === "string") setMessageColumn(s.messageColumn);
        if (Array.isArray(s.identifierColumns)) setIdentifierColumns(s.identifierColumns);
        if (typeof s.identityColumn === "string") setIdentityColumn(s.identityColumn);
        if (typeof s.orderColumn === "string") setOrderColumn(s.orderColumn);
        if (s.orderDirection === "asc" || s.orderDirection === "desc") setOrderDirection(s.orderDirection);
        if (Array.isArray(s.contextColumns)) setContextColumns(s.contextColumns);
        if (s.contextDescriptions && typeof s.contextDescriptions === "object") setContextDescriptions(s.contextDescriptions);
        if (typeof s.rowsAsUnits === "boolean") setRowsAsUnits(s.rowsAsUnits);
        if (s.emptyMessageHandling === "ignore" || s.emptyMessageHandling === "code") setEmptyMessageHandling(s.emptyMessageHandling);
        if (typeof s.experimentInstructions === "string") setExperimentInstructions(s.experimentInstructions);
        if (Array.isArray(s.codebook) && s.codebook.length) {
          const legacyAggregation = s.aggregation === "mean" ? "mean" : "mode";
          setCodebook(s.codebook.map((entry: CodebookEntry) => ({
            ...entry,
            aggregation: entry.aggregation === "mode" || entry.aggregation === "mean"
              ? entry.aggregation
              : (entry.type === "numeric" ? "mean" : legacyAggregation),
          })));
        }
        if (typeof s.senderVerificationSignature === "string") {
          setSenderVerificationSignature(s.senderVerificationSignature);
        }
        // Never restore a saved API key (and discard any key left by an older build).
        if (Array.isArray(s.modelSlots) && s.modelSlots.length) {
          setModelSlots(s.modelSlots.map((slot: ModelSlot) => normalizeModelSlot(slot)));
        }
        if (typeof s.runsPerModel === "number") setRunsPerModel(s.runsPerModel);
      }
    } catch {}
    hydratedRef.current = true;
    setPersistenceReady(true);
  }, []);
  // Save on any change (skip during the guided tour, which loads sample data).
  useEffect(() => {
    if (!hydratedRef.current || !persistenceReady || tourOpen) return;
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({
        uploadMeta, messageColumn, identifierColumns, identityColumn, orderColumn, orderDirection,
        contextColumns, contextDescriptions, rowsAsUnits, emptyMessageHandling, experimentInstructions,
        codebook, senderVerificationSignature, runsPerModel,
        // Persist model slots WITHOUT the API key — keys are never saved anywhere.
        modelSlots: modelSlots.map((s) => ({ ...s, apiKey: "" })),
      }));
    } catch {}
  }, [persistenceReady, uploadMeta, messageColumn, identifierColumns, identityColumn, orderColumn, orderDirection,
      contextColumns, contextDescriptions, rowsAsUnits, emptyMessageHandling, experimentInstructions,
      codebook, senderVerificationSignature, modelSlots, runsPerModel, tourOpen]);

  // ── Popup save / discard ────────────────────────────────────────────────────
  const mapStateJSON = () => JSON.stringify({
    messageColumn, identifierColumns, identityColumn, orderColumn, orderDirection,
    contextColumns, contextDescriptions, rowsAsUnits,
  });
  // Snapshot each popup's state when it opens.
  useEffect(() => {
    if (columnModalOpen) { mapSnapshotRef.current = mapStateJSON(); setColMapError(""); setMapValidationAttempted(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnModalOpen]);
  useEffect(() => {
    if (expandedTable === "codebook") { codebookSnapshotRef.current = JSON.stringify(codebook); setCodebookSaveAttempted(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedTable]);

  const mapRequirementMsg = () =>
    !messageColumn ? "Tag a Message column before you proceed."
    : (!rowsAsUnits && identifierColumns.length === 0) ? "Choose an identifier — tag column(s) or pick “each row is its own episode”."
    : "";

  const saveAndProceed = () => {
    setMapValidationAttempted(true);
    if (!mappingComplete) { setColMapError(mapRequirementMsg() || "Select all required columns first."); return; }
    const conflicts = currentContextConflicts;
    if (conflicts.length > 0) {
      setContextConflictAlert(conflicts);
      setColMapError("Resolve the inconsistent Context fields before proceeding.");
      return;
    }
    mapSnapshotRef.current = mapStateJSON();
    setColMapError("");
    setColumnModalOpen(false);
    showToast("Column mapping saved");
  };
  const unselectConflictingContext = () => {
    const columns = new Set((contextConflictAlert ?? []).map((conflict) => conflict.column));
    setContextColumns((previous) => previous.filter((column) => !columns.has(column)));
    setContextConflictAlert(null);
    setColMapError("");
    showToast("Inconsistent Context fields unselected");
  };
  const replaceDatasetForContext = () => {
    setContextConflictAlert(null);
    setColumnModalOpen(false);
    window.setTimeout(() => fileRef.current?.click(), 0);
  };
  const closeColumnModal = () => {
    if (mapSnapshotRef.current !== null && mapStateJSON() !== mapSnapshotRef.current) {
      if (!window.confirm("Leave without saving your column mapping? Your changes will be discarded.")) return;
      try {
        const s = JSON.parse(mapSnapshotRef.current);
        setMessageColumn(s.messageColumn); setIdentifierColumns(s.identifierColumns);
        setIdentityColumn(s.identityColumn); setOrderColumn(s.orderColumn); setOrderDirection(s.orderDirection);
        setContextColumns(s.contextColumns); setContextDescriptions(s.contextDescriptions); setRowsAsUnits(s.rowsAsUnits);
      } catch {}
    }
    setColMapError("");
    setColumnModalOpen(false);
  };

  const closeCodebookEditor = () => {
    if (codebookSnapshotRef.current !== null && JSON.stringify(codebook) !== codebookSnapshotRef.current) {
      if (!window.confirm("Leave without saving? Your codebook changes will be discarded.")) return;
      try { setCodebook(JSON.parse(codebookSnapshotRef.current)); } catch {}
    }
    setExpandedTable(null);
  };
  // Close the fullscreen modal, routing the codebook editor through its discard check.
  const closeExpanded = () => {
    if (expandedTable === "codebook") { closeCodebookEditor(); return; }
    setExpandedTable(null);
  };

  useEffect(() => {
    if (runComplete) setRunFinishedAt(new Date().toISOString());
    if (runComplete) {
      const report = validateCodedRows(codedRowsRef.current, resultVars);
      setValidationReport(report);
      if (report.problematicIndices.length === 0) {
        log("info", "Validation passed: all coded episodes are within the expected ranges.");
      } else {
        log("warn", `Validation: ${report.problematicIndices.length} coded episodes with issues (${report.errorRows} errors, ${report.outOfRangeRows} out-of-range).`);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runComplete]);

  useEffect(() => {
    const agreementPossible = !!resultExportConfig
      && (resultExportConfig.models.length >= 2 || resultExportConfig.runsPerModel >= 2);
    if (!runComplete || !agreementPossible) {
      setAgreementReport(null);
      setAgreementLoading(false);
      setAgreementError("");
      return;
    }
    const controller = new AbortController();
    setAgreementLoading(true);
    setAgreementError("");
    (async () => {
      try {
        const init = await gzipJsonInit({
          result_path: runComplete.file_path,
          codebook: resultExportConfig.codebook,
          participants: resultExportConfig.participants,
        });
        const response = await fetch("/api/coding/inter-coder-agreement", {
          method: "POST",
          headers: init.headers,
          signal: controller.signal,
          body: init.body,
        });
        const raw = await response.text();
        const firewall = firewallErrorFromText(raw);
        if (firewall) throw firewall;
        if (!response.ok) {
          let detail = response.statusText;
          try { detail = (JSON.parse(raw) as { detail?: string }).detail || detail; } catch {}
          throw new Error(detail);
        }
        setAgreementReport(JSON.parse(raw) as InterCoderAgreementReport);
      } catch (error: unknown) {
        if (isAbortError(error)) return;
        setAgreementReport(null);
        setAgreementError(error instanceof Error ? error.message : "Could not calculate inter-coder agreement.");
      } finally {
        if (!controller.signal.aborted) setAgreementLoading(false);
      }
    })();
    return () => controller.abort();
  }, [runComplete, resultExportConfig, agreementRequestVersion]);

  // ── File upload ───────────────────────────────────────────────────────────

  // Delete the server's temp working files (uploaded dataset + results) for an
  // upload/result. Called when a file is replaced or on Reset so nothing lingers.
  const serverFilesRef = useRef<{ fileId?: string; resultPath?: string }>({});
  const cleanupServerFiles = useCallback((fileId?: string, path?: string) => {
    if (fileId === "__tour_sample__") fileId = undefined;
    if (!fileId && !path) return;
    try {
      fetch("/api/coding/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId ?? null, path: path ?? null }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }, []);
  useEffect(() => {
    serverFilesRef.current = { fileId: uploadResult?.file_id, resultPath: runComplete?.file_path };
  }, [uploadResult, runComplete]);

  const invalidateRunArtifacts = () => {
    runActionGenerationRef.current += 1;
    runActionRef.current?.controller.abort();
    runActionRef.current = null;
    runAbortRef.current?.abort();
    runAbortRef.current = null;
    codingActionBusyRef.current = false;
    setGenerating(false); setGenerateError(""); setResult(null);
    setRunning(false); setRunProgress(null); setCodedRows([]); setRunErrors([]);
    setRunComplete(null); setRunStartedAt(null); setRunFinishedAt(null); setRunError("");
    setValidationReport(null);
    setAgreementReport(null); setAgreementLoading(false); setAgreementError("");
    setResultDownloadKind(null); setResultDownloadError("");
    setResultExportConfig(null);
    setConsoleLogs([]); setRightView("script");
  };

  const resetMapping = () => {
    setMessageColumn("");
    setIdentifierColumns([]);
    setIdentityColumn("");
    setOrderColumn("");
    setOrderDirection("asc");
    setContextColumns([]);
    setContextDescriptions({});
    setRowsAsUnits(false);
    setActiveRole("message");
  };

  const uploadDataset = async (
    file: File,
    options: {
      source: "manual" | "restore";
      expectedColumns?: string[];
      storedMetadata?: StoredUploadMetadata;
      persistFile?: boolean;
      invalidateArtifacts?: boolean;
      openMapping?: boolean;
      lifecycle?: number;
      signal?: AbortSignal;
    },
  ): Promise<UploadResult | null> => {
    if (tourOpen) return null;
    if ((running || generating || codingActionBusyRef.current) && options.source === "manual") {
      setUploadError("Wait for the current coding action to finish before replacing the dataset.");
      if (fileRef.current) fileRef.current.value = "";
      return null;
    }
    // Keep replacement deterministic: a second picker/drop action cannot race
    // the first response or overwrite the browser copy out of order.
    if (uploadRequestRef.current) {
      if (options.source === "manual") setUploadError("Wait for the current dataset upload to finish.");
      if (fileRef.current) fileRef.current.value = "";
      return null;
    }

    throwIfAborted(options.signal);
    const lifecycle = options.lifecycle ?? uploadLifecycleRef.current;
    const token = ++uploadTokenRef.current;
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    uploadRequestRef.current = { token, controller };
    const isCurrent = () =>
      uploadRequestRef.current?.token === token && uploadLifecycleRef.current === lifecycle;
    const previousFiles = { ...serverFilesRef.current };
    const previousAvailability = uploadAvailability;
    setUploading(true);
    setUploadError("");
    setUploadNotice("");
    const encoded = await gzipFileInit(file);
    try {
      const res = await fetch("/api/coding/upload", {
        method: "POST",
        headers: encoded.headers,
        body: encoded.body,
        signal: controller.signal,
      });
      const data = await parseUploadResponse(res);
      if (!isCurrent()) {
        cleanupServerFiles(data.file_id);
        return null;
      }
      const expectedColumns = options.expectedColumns
        ?? uploadResult?.columns
        ?? uploadMeta?.columns
        ?? [];
      const schemaMatches = expectedColumns.length > 0 && sameColumns(expectedColumns, data.columns);

      let metadata = options.storedMetadata ?? {
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        columns: [...data.columns],
      };
      let storageWarning = "";
      if (options.persistFile !== false) {
        try {
          metadata = await saveStoredUpload(file, data.columns);
        } catch {
          storageWarning = "Dataset uploaded, but this browser could not save a restorable copy. You will need to re-upload it after refreshing.";
        }
      }
      if (!isCurrent()) {
        // Reset may have happened while IndexedDB was writing. Remove both the
        // late browser record and the newly accepted server upload.
        if (options.persistFile !== false) {
          try { await clearStoredUpload(); } catch {}
        }
        cleanupServerFiles(data.file_id);
        return null;
      }

      if (options.invalidateArtifacts !== false) invalidateRunArtifacts();
      if (!schemaMatches) resetMapping();
      if (options.source === "manual") {
        setSenderVerificationSignature("");
        setContextConflictAlert(null);
        // A fresh dataset invalidates any prior row subset (row numbers/counts
        // refer to the old file); start from "all rows".
        setRowSelectionMode("all");
        setRowSelectionCount("");
        setRowSelectionPercent("");
        setRowSelectionSpec("");
      }
      setUploadResult(data);
      setUploadMeta({ ...metadata, columns: [...data.columns] });
      setUploadAvailability("ready");
      liveUploadIdRef.current = data.file_id;
      serverFilesRef.current = {
        fileId: data.file_id,
        resultPath: options.invalidateArtifacts === false ? previousFiles.resultPath : undefined,
      };
      if (options.openMapping ?? options.source === "manual") setColumnModalOpen(true);

      // Replacement is transactional: only after the new upload and browser copy
      // are accepted do we remove the prior server-side upload/result.
      if (previousFiles.fileId && previousFiles.fileId !== data.file_id) {
        cleanupServerFiles(
          previousFiles.fileId,
          options.invalidateArtifacts === false ? undefined : previousFiles.resultPath,
        );
      } else if (options.invalidateArtifacts !== false && previousFiles.resultPath) {
        cleanupServerFiles(undefined, previousFiles.resultPath);
      }

      setUploadError("");
      setUploadNotice(storageWarning);
      showToast(`${options.source === "restore" ? "Restored" : "Uploaded"} ${data.file_name} (${data.row_count} rows)`);
      return data;
    } catch (e: unknown) {
      if (!isCurrent() || isAbortError(e)) return null;
      setUploadNotice("");
      setUploadError(e instanceof Error ? e.message : "Upload failed");
      if (options.source === "restore") {
        setUploadResult(null);
        setUploadAvailability(uploadMeta || options.storedMetadata ? "reupload-required" : "none");
        liveUploadIdRef.current = null;
      } else {
        setUploadAvailability(previousAvailability);
      }
      return null;
    } finally {
      options.signal?.removeEventListener("abort", abortFromCaller);
      if (uploadRequestRef.current?.token === token) {
        uploadRequestRef.current = null;
        setUploading(false);
      }
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const restoreSavedUpload = async (force = false, signal?: AbortSignal): Promise<UploadResult | null> => {
    throwIfAborted(signal);
    if (!force && uploadAvailability === "ready" && uploadResult && liveUploadIdRef.current === uploadResult.file_id) {
      return uploadResult;
    }
    if (restorePromiseRef.current) return waitWithAbort(restorePromiseRef.current, signal);

    const lifecycle = uploadLifecycleRef.current;
    const restorePromise = (async () => {
      setUploadAvailability("restoring");
      try {
        const stored = await getStoredUpload();
        throwIfAborted(signal);
        if (uploadLifecycleRef.current !== lifecycle || tourOpen) return null;
        if (!stored) {
          setUploadResult(null);
          setUploadAvailability(uploadMeta ? "reupload-required" : "none");
          return null;
        }

        // Never restore a different browser-stored file over the project metadata.
        if (uploadMeta) {
          const sameName = stored.metadata.name === uploadMeta.name;
          const sameSize = uploadMeta.size === 0 || stored.metadata.size === uploadMeta.size;
          const sameModified = uploadMeta.lastModified === 0 || stored.metadata.lastModified === uploadMeta.lastModified;
          if (!sameName || !sameSize || !sameModified) {
            setUploadResult(null);
            setUploadAvailability("reupload-required");
            setUploadError("The saved browser file does not match this project. Re-upload the original dataset.");
            return null;
          }
        }

        const restored = await uploadDataset(stored.file, {
          source: "restore",
          expectedColumns: uploadMeta?.columns.length ? uploadMeta.columns : stored.metadata.columns,
          storedMetadata: stored.metadata,
          persistFile: false,
          invalidateArtifacts: false,
          openMapping: false,
          lifecycle,
          signal,
        });
        throwIfAborted(signal);
        return restored;
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (uploadLifecycleRef.current !== lifecycle) return null;
        setUploadResult(null);
        setUploadAvailability(uploadMeta ? "reupload-required" : "none");
        setUploadError(error instanceof Error ? error.message : "Could not restore the saved dataset.");
        return null;
      }
    })();
    restorePromiseRef.current = restorePromise;
    try {
      return await waitWithAbort(restorePromise, signal);
    } finally {
      if (restorePromiseRef.current === restorePromise) restorePromiseRef.current = null;
    }
  };

  const preflightUpload = async (candidate: UploadResult, signal?: AbortSignal): Promise<UploadResult> => {
    throwIfAborted(signal);
    const response = await fetch(`/api/coding/upload-status/${encodeURIComponent(candidate.file_id)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    });
    const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
    const raw = await response.text();
    type UploadStatusResponse = { ok?: unknown; code?: unknown; detail?: unknown; file_id?: unknown };
    let data: UploadStatusResponse | null = null;
    if (contentType.includes("application/json")) {
      try { data = JSON.parse(raw) as UploadStatusResponse; } catch {
        throw new Error(`The server returned invalid upload-status data (HTTP ${response.status}).`);
      }
    }

    const headerCode = response.headers.get("X-CAT-Error-Code");
    const responseCode = headerCode || (typeof data?.code === "string" ? data.code : null);
    const detail = typeof data?.detail === "string" ? data.detail : "";
    if (!response.ok) {
      if (isRestorableUploadCode(responseCode)) {
        throw new UploadUnavailableError(detail || "The uploaded dataset must be restored.", responseCode);
      }
      throw new Error(detail || `Could not verify the uploaded dataset (HTTP ${response.status}).`);
    }
    if (!data || data.ok !== true || data.file_id !== candidate.file_id) {
      throw new Error("The server returned an unexpected upload-status response.");
    }
    return candidate;
  };

  // Every server-dependent action uses this same readiness check. It never trusts
  // a file_id recovered from localStorage: the page must have uploaded the File in
  // this browser session and the backend must confirm that handle is still live.
  const ensureUploadReady = async (signal?: AbortSignal): Promise<UploadResult> => {
    throwIfAborted(signal);
    let candidate = uploadAvailability === "ready"
      && uploadResult
      && liveUploadIdRef.current === uploadResult.file_id
      ? uploadResult
      : await restoreSavedUpload(true, signal);
    throwIfAborted(signal);
    if (!candidate) {
      throw new Error("Re-upload the original dataset before continuing. Your mapping and coding configuration have been kept.");
    }

    if (!signal && uploadPreflightRef.current?.fileId === candidate.file_id) {
      return uploadPreflightRef.current.promise;
    }
    const promise = preflightUpload(candidate, signal);
    uploadPreflightRef.current = { fileId: candidate.file_id, promise };
    try {
      candidate = await promise;
      return candidate;
    } finally {
      if (uploadPreflightRef.current?.promise === promise) uploadPreflightRef.current = null;
    }
  };

  // If (and only if) the server returns CAT's stable stale-upload code, restore
  // the IndexedDB File and retry the requested operation once with its fresh ID.
  const withReadyUpload = async <T,>(
    operation: (activeUpload: UploadResult) => Promise<T>,
    options: { initialUpload?: UploadResult; recovery?: { used: boolean }; signal?: AbortSignal } = {},
  ): Promise<T> => {
    const recovery = options.recovery ?? { used: false };
    let freshUpload: UploadResult | null = options.initialUpload ?? null;
    while (true) {
      try {
        throwIfAborted(options.signal);
        const activeUpload = freshUpload ?? await ensureUploadReady(options.signal);
        throwIfAborted(options.signal);
        freshUpload = null;
        const result = await operation(activeUpload);
        throwIfAborted(options.signal);
        return result;
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (!(error instanceof UploadUnavailableError) || recovery.used) {
          if (error instanceof UploadUnavailableError) {
            liveUploadIdRef.current = null;
            setUploadAvailability("reupload-required");
            setUploadNotice("");
            setUploadError(error.message);
          }
          throw error;
        }
        recovery.used = true;
        liveUploadIdRef.current = null;
        setUploadAvailability("restoring");
        setUploadError("");
        setUploadNotice("");
        freshUpload = await restoreSavedUpload(true, options.signal);
        throwIfAborted(options.signal);
        if (!freshUpload) {
          throw new Error("The saved dataset could not be restored. Re-upload the original file; your mapping and coding configuration have been kept.");
        }
      }
    }
  };

  const handleUpload = async (file: File) => {
    if (tourOpen) return;
    if (uploadRequestRef.current) {
      setUploadError("Wait for the current dataset upload to finish.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    const lifecycle = ++uploadLifecycleRef.current;
    await uploadDataset(file, {
      source: "manual",
      persistFile: true,
      invalidateArtifacts: true,
      openMapping: true,
      lifecycle,
    });
  };

  const handleRetrySavedUpload = async () => {
    if (!uploadMeta || uploading || uploadRequestRef.current || codingActionBusyRef.current || tourOpen) return;
    setUploadError("");
    await restoreSavedUpload(true);
  };

  // A persisted file_id is never treated as live. Re-upload the original File from
  // IndexedDB once after hydration to obtain a new server handle for this page load.
  useEffect(() => {
    if (!persistenceReady || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    // uploadMeta is written synchronously to localStorage with the project. If
    // it is absent (notably just after Reset), never revive an orphaned IDB blob.
    if (!uploadMeta) return;
    void restoreSavedUpload();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistenceReady]);

  const handleStepEnter = useCallback((s: TourStep) => {
    const showingResults = s.section === "Results";
    if (showingResults) {
      setLayoutMode("hidden");
      setRightView("run");
      setRunProgress({ current: 3, total: 3, percent: 100 });
      codedRowsRef.current = TOUR_SAMPLE_CODED_ROWS;
      setCodedRows(TOUR_SAMPLE_CODED_ROWS);
      setRunErrors([]);
      setRunComplete({ total_rows: 3, coded_rows: 3, file_path: "" });
      setValidationReport(TOUR_SAMPLE_VALIDATION);
    } else {
      setLayoutMode("fill");
      setRightView("script");
      setRunProgress(null);
      codedRowsRef.current = [];
      setCodedRows([]);
      setRunErrors([]);
      setRunComplete(null);
      setValidationReport(null);
    }
    if (s.mappingStage) {
      const stages = ["none", "message", "identifier", "identity", "order", "context", "complete"] as const;
      const stage = stages.indexOf(s.mappingStage);
      setMessageColumn(stage >= stages.indexOf("message") ? "Message" : "");
      setIdentifierColumns(stage >= stages.indexOf("identifier") ? ["Session", "Round"] : []);
      setIdentityColumn(stage >= stages.indexOf("identity") ? "Speaker" : "");
      setOrderColumn(stage >= stages.indexOf("order") ? "Order" : "");
      setOrderDirection("asc");
      setContextColumns(stage >= stages.indexOf("context") ? ["Treatment"] : []);
      setContextDescriptions(stage >= stages.indexOf("context")
        ? { Treatment: "Experimental condition assigned to the communication episode." }
        : {});
      setRowsAsUnits(false);
    }
    // Open/close the relevant popup for popup steps; close popups for section steps.
    if (s.open === "mapping") { setExpandedTable(null); setColumnModalOpen(true); }
    else if (s.open === "codebook") { setColumnModalOpen(false); setExpandedTable("codebook"); }
    else { setColumnModalOpen(false); setExpandedTable(null); }
    if (s.mapRole) setActiveRole(s.mapRole as ColRole);
    if (s.panel) setOpenPanels((prev) => new Set(prev).add(s.panel as number));
  }, []);

  // Guided tour: load a sample dataset + codebook so every section and popup renders
  // populated, then restore the user's real state when the tour closes.
  const tourSnap = useRef<Record<string, unknown> | null>(null);
  const startTour = () => {
    if (tourOpen) return;
    if (uploading || running || generating || codingActionBusyRef.current
        || uploadAvailability === "restoring" || uploadRequestRef.current || restorePromiseRef.current) {
      showToast("Wait for dataset restoration to finish, then start the tour.");
      return;
    }
    tourSnap.current = {
      uploadResult, messageColumn, identifierColumns, identityColumn, orderColumn, orderDirection,
      rowsAsUnits, contextColumns, contextDescriptions, emptyMessageHandling, experimentInstructions,
      codebook, senderVerificationSignature, modelSlots: modelSlots.map((slot) => ({ ...slot })), runsPerModel,
      openPanels: [...openPanels],
      layoutMode, activeTool, uploadAvailability, uploadMeta, uploadError, uploadNotice,
      rightView, runProgress, codedRows, runErrors, runComplete, validationReport,
      liveUploadId: liveUploadIdRef.current,
      serverFiles: { ...serverFilesRef.current },
    };
    setUploadResult(TOUR_SAMPLE_UPLOAD);
    setUploadAvailability("ready");
    setUploadError("");
    setUploadNotice("");
    liveUploadIdRef.current = TOUR_SAMPLE_UPLOAD.file_id;
    serverFilesRef.current = { fileId: TOUR_SAMPLE_UPLOAD.file_id };
    setMessageColumn("");
    setIdentifierColumns([]);
    setIdentityColumn("");
    setOrderColumn(""); setOrderDirection("asc");
    setRowsAsUnits(false);
    setContextColumns([]);
    setContextDescriptions({});
    setEmptyMessageHandling("ignore");
    setExperimentInstructions(TOUR_SAMPLE_INSTRUCTIONS);
    setCodebook(tourSampleCodebook());
    setModelSlots([{ ...EMPTY_SLOT, apiKey: "guided-tour-placeholder" }]);
    setRunsPerModel(3);
    setSenderVerificationSignature(JSON.stringify({
      identityColumn: "Speaker",
      participants: ["P", "V1", "V2"],
      blankRows: [],
      rowCount: TOUR_SAMPLE_UPLOAD.row_count,
    }));
    setColumnModalOpen(false); setExpandedTable(null);
    navigateToTool("coding");
    setTourOpen(true);
  };
  const endTour = () => {
    setTourOpen(false);
    setColumnModalOpen(false); setExpandedTable(null);
    const s = tourSnap.current;
    if (s) {
      setUploadResult(s.uploadResult as UploadResult | null);
      setMessageColumn(s.messageColumn as string);
      setIdentifierColumns(s.identifierColumns as string[]);
      setIdentityColumn(s.identityColumn as string);
      setOrderColumn(s.orderColumn as string); setOrderDirection(s.orderDirection as "asc" | "desc");
      setRowsAsUnits(s.rowsAsUnits as boolean);
      setContextColumns(s.contextColumns as string[]); setContextDescriptions(s.contextDescriptions as Record<string, string>);
      setEmptyMessageHandling(s.emptyMessageHandling as "ignore" | "code");
      setExperimentInstructions(s.experimentInstructions as string);
      setCodebook(s.codebook as CodebookEntry[]);
      setSenderVerificationSignature(s.senderVerificationSignature as string);
      setModelSlots(s.modelSlots as ModelSlot[]); setRunsPerModel(s.runsPerModel as number);
      setOpenPanels(new Set(s.openPanels as number[]));
      setLayoutMode(s.layoutMode as "fill" | "side" | "hidden");
      setRightView(s.rightView as "script" | "run");
      setRunProgress(s.runProgress as RunProgress | null);
      const restoredCodedRows = s.codedRows as CodedRow[];
      codedRowsRef.current = restoredCodedRows;
      setCodedRows(restoredCodedRows);
      setRunErrors(s.runErrors as string[]);
      setRunComplete(s.runComplete as { total_rows: number; coded_rows: number; file_path: string } | null);
      setValidationReport(s.validationReport as ValidationReport | null);
      const restoredTool = s.activeTool;
      navigateToTool(
        restoredTool === "instructions" || restoredTool === "documentation" || restoredTool === "versions" || restoredTool === "contact" || restoredTool === "privacy"
          ? restoredTool
          : "coding",
      );
      setUploadAvailability(s.uploadAvailability as UploadAvailability);
      setUploadMeta(s.uploadMeta as StoredUploadMetadata | null);
      setUploadError(s.uploadError as string);
      setUploadNotice(s.uploadNotice as string);
      liveUploadIdRef.current = s.liveUploadId as string | null;
      serverFilesRef.current = s.serverFiles as { fileId?: string; resultPath?: string };
      tourSnap.current = null;
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleUpload(file);
  };

  // ── Column mapping picker ─────────────────────────────────────────────────

  const roleOf = (col: string): ColRole | null =>
    col === messageColumn ? "message"
    : identifierColumns.includes(col) ? "identifier"
    : col === identityColumn ? "identity"
    : col === orderColumn ? "order"
    : contextColumns.includes(col) ? "context"
    : null;

  // Assign the currently active role to a column (one column = one role).
  const clickColumn = (col: string) => {
    const current = roleOf(col);
    // Strip the column out of every role first.
    if (messageColumn === col) setMessageColumn("");
    if (identityColumn === col) setIdentityColumn("");
    if (orderColumn === col) setOrderColumn("");
    setIdentifierColumns((prev) => prev.filter((c) => c !== col));
    setContextColumns((prev) => prev.filter((c) => c !== col));

    // Clicking with the same brush it already has → just clear it (toggle off).
    if (current === activeRole) return;

    if (activeRole === "message") setMessageColumn(col);
    else if (activeRole === "identity") setIdentityColumn(col);
    else if (activeRole === "order") setOrderColumn(col);
    else if (activeRole === "identifier") { setIdentifierColumns((prev) => [...prev, col]); setRowsAsUnits(false); }
    else if (activeRole === "context") setContextColumns((prev) => [...prev, col]);

    // Guide the user along: after tagging a single-select role, jump to the next step.
    const nextStep: Partial<Record<ColRole, ColRole>> = { message: "identifier", identity: "order", order: "context" };
    if (nextStep[activeRole]) setActiveRole(nextStep[activeRole]!);
  };

  // Final preprocessed rows (grouped + tagged), mirroring the backend.
  const preprocessedRows = useMemo(
    () => uploadResult
      ? buildPreprocessedRows(effectiveRows, uploadResult.columns, messageColumn, identifierColumns, identityColumn, orderColumn, orderDirection)
      : [],
    [uploadResult, effectiveRows, messageColumn, identifierColumns, identityColumn, orderColumn, orderDirection],
  );
  const isPreprocessed = !!messageColumn && (rowsAsUnits || identifierColumns.length > 0);

  const downloadPreprocessed = () => {
    if (!uploadResult) return;
    const cols = uploadResult.columns;
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.map(esc).join(",")];
    for (const row of preprocessedRows) lines.push(cols.map((c) => esc(row[c])).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const base = uploadResult.file_name.replace(/\.[^.]+$/, "");
    a.href = url; a.download = `${base}_preprocessed.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Codebook management ───────────────────────────────────────────────────

  const updateCodebook = (idx: number, field: keyof CodebookEntry, value: string) => {
    setCodebookSaveAttempted(false);
    setCodebook((prev) => prev.map((entry, i) => (i === idx ? { ...entry, [field]: value } : entry)));
  };

  // Changing the type adjusts the coded values: binary → fixed 0/1; numeric/text → none.
  const changeType = (idx: number, newType: string) => {
    setCodebookSaveAttempted(false);
    setCodebook((prev) => prev.map((e, i) => {
      if (i !== idx) return e;
      let values = e.values;
      if (newType === "binary") {
        const d = e.values;
        values = [
          { value: "0", definition: d[0]?.definition ?? "", examples: d[0]?.examples ?? "", context: d[0]?.context ?? "" },
          { value: "1", definition: d[1]?.definition ?? "", examples: d[1]?.examples ?? "", context: d[1]?.context ?? "" },
        ];
      } else if (newType === "numeric" || newType === "text") {
        values = [];
      } else {
        values = e.values.length ? e.values : [{ ...EMPTY_VALUE }];
      }
      return { ...e, type: newType, aggregation: defaultAggregation(newType), values };
    }));
  };

  const addCodebookRow = () => {
    setCodebookSaveAttempted(false);
    setCodebook((prev) => [...prev, newEntry()]);
  };

  const removeCodebookRow = (idx: number) => {
    if (codebook.length <= 1) return;
    setCodebookSaveAttempted(false);
    setCodebook((prev) => prev.filter((_, i) => i !== idx));
  };

  // Per-value (coded value) helpers
  const addValueRow = (idx: number) => {
    setCodebookSaveAttempted(false);
    setCodebook((prev) => prev.map((e, i) => (i === idx ? { ...e, values: [...e.values, { ...EMPTY_VALUE }] } : e)));
  };
  const removeValueRow = (idx: number, vIdx: number) => {
    setCodebookSaveAttempted(false);
    setCodebook((prev) => prev.map((e, i) => (i === idx ? { ...e, values: e.values.filter((_, j) => j !== vIdx) } : e)));
  };
  const updateValue = (idx: number, vIdx: number, field: keyof CodedValue, value: string) => {
    setCodebookSaveAttempted(false);
    setCodebook((prev) => prev.map((e, i) => (i === idx
      ? { ...e, values: e.values.map((v, j) => (j === vIdx ? { ...v, [field]: value } : v)) }
      : e)));
  };

  // ── Model slot helpers ────────────────────────────────────────────────────

  const updateSlot = (idx: number, patch: Partial<ModelSlot>) => {
    setModelSlots((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  // ── Script generation ─────────────────────────────────────────────────────

  const senderConfigurationMessage = !identityColumn
    ? "Map a Sender column before using per-sender variables."
    : detectedSenderInfo.blankRows.length > 0
      ? `Fill the blank Sender values in source row${detectedSenderInfo.blankRows.length === 1 ? "" : "s"} ${detectedSenderInfo.blankRows.slice(0, 5).join(", ")}${detectedSenderInfo.blankRows.length > 5 ? "…" : ""}, then re-upload the dataset.`
      : participants.length === 0
        ? "The mapped Sender column does not contain any sender names."
        : !senderListVerified
          ? "Verify the automatically detected sender list before using per-sender variables."
          : "";
  const sendersOk = !hasSenderVar || senderConfigurationMessage === "";

  const collectCodebookIssues = (entries: CodebookEntry[] = codebook): SetupIssue[] => {
    const issues: SetupIssue[] = [];
    if (entries.length === 0) {
      issues.push({ key: "codebook.empty", panel: 2, message: "Add at least one codebook variable." });
      return issues;
    }
    entries.forEach((entry, index) => {
      if (!entry.label.trim()) {
        issues.push({
          key: `codebook.${index}.label`, panel: 2, codebookIndex: index, field: "label",
          message: `Codebook variable ${index + 1} needs a label.`,
        });
      }
      if (!entry.type) {
        issues.push({
          key: `codebook.${index}.type`, panel: 2, codebookIndex: index, field: "type",
          message: `Codebook variable ${index + 1} needs a type.`,
        });
      }
    });
    const entryExpandedVars = expandCodebook(entries, participants);
    const entryAggregateVars = expandAggregateResults(entries, participants);
    const entryDuplicateLabels = duplicateExpandedKeys(entryExpandedVars);
    const entryDuplicateAggregateLabels = duplicateExpandedKeys(entryAggregateVars);
    if (entryDuplicateLabels.length > 0) {
      issues.push({ key: "codebook.duplicates", panel: 2, message: `Output labels must be unique: ${entryDuplicateLabels.join(", ")}.` });
    }
    if (entryDuplicateAggregateLabels.length > 0) {
      issues.push({ key: "codebook.aggregate-duplicates", panel: 2, message: `Categorical values create duplicate aggregate columns: ${entryDuplicateAggregateLabels.join(", ")}.` });
    }
    if (entries.some((entry) => entry.level === "sender") && senderConfigurationMessage) {
      issues.push({ key: "codebook.senders", panel: 2, message: senderConfigurationMessage });
    }
    return issues;
  };

  // Sender verification belongs to the codebook because it is required only
  // when at least one variable is coded per sender.
  const mappingComplete =
    !!messageColumn &&
    (rowsAsUnits || identifierColumns.length > 0);

  const collectSetupIssues = (action: SetupAction): SetupIssue[] => {
    const issues: SetupIssue[] = [];

    if (!uploadResult) {
      issues.push({ key: "upload", panel: 1, message: "Upload a CSV or Excel dataset." });
    } else if (uploading || uploadAvailability === "restoring") {
      issues.push({ key: "upload", panel: 1, message: "Wait for the dataset upload to finish." });
    } else if (uploadAvailability !== "ready" || liveUploadIdRef.current !== uploadResult.file_id) {
      issues.push({ key: "upload", panel: 1, message: "Restore or re-upload the dataset before continuing." });
    }

    if (uploadResult) {
      // A row subset with an invalid entry must never fall back to coding all rows.
      if (rowSelectionMode !== "all" && rowSelection.error) {
        issues.push({ key: "rows", panel: 1, message: rowSelection.error });
      }
      if (!messageColumn) {
        issues.push({ key: "mapping.message", panel: 1, message: "Map the column that contains the message text." });
      }
      if (!rowsAsUnits && identifierColumns.length === 0) {
        issues.push({ key: "mapping.identifier", panel: 1, message: "Map at least one episode identifier, or select “each row is an episode.”" });
      }
      if (currentContextConflicts.length > 0) {
        issues.push({
          key: "mapping.context",
          panel: 1,
          message: `${currentContextConflicts.length} context field${currentContextConflicts.length === 1 ? " has" : "s have"} conflicting values within episodes.`,
        });
      }
    }

    issues.push(...collectCodebookIssues());

    if (!experimentInstructions.trim()) {
      issues.push({ key: "instructions", panel: 3, message: "Describe the experiment context and research task." });
    }

    if (modelSlots.length === 0) {
      issues.push({ key: "models", panel: 4, message: "Add at least one model." });
    } else {
      const slotsToValidate = action === "package" ? modelSlots.slice(0, 1) : modelSlots;
      slotsToValidate.forEach((slot, index) => {
        if (!slot.provider) {
          issues.push({ key: `model.${index}.provider`, panel: 4, modelIndex: index, field: "provider", message: `Model ${index + 1} needs a provider.` });
        }
        if (!slot.model) {
          issues.push({ key: `model.${index}.model`, panel: 4, modelIndex: index, field: "model", message: `Model ${index + 1} needs a model selection.` });
        }
        if (action === "run" && !slot.apiKey.trim()) {
          issues.push({ key: `model.${index}.apiKey`, panel: 4, modelIndex: index, field: "apiKey", message: `Enter an API key for model ${index + 1}.` });
        }
      });
    }

    return issues;
  };

  const visibleCodebookIssues = [
    ...setupIssues.filter((issue) => issue.panel === 2),
    ...(codebookSaveAttempted ? collectCodebookIssues() : []),
  ].filter((issue, index, all) => all.findIndex((candidate) => candidate.key === issue.key) === index);
  const panelHasSetupIssue = (panel: SetupIssue["panel"]) => setupIssues.some((issue) => issue.panel === panel);
  const datasetLoaded = !!uploadResult && uploadAvailability === "ready";
  // The token in /runs/<token>, when someone opens a run link directly.
  const linkedRunToken = pathname.startsWith("/runs/")
    ? decodeURIComponent(pathname.slice("/runs/".length).split("/")[0])
    : "";
  const viewingRunLink = activeTool === "run" && !!linkedRunToken;
  const setupIssueByKey = (key: string) => setupIssues.find((issue) => issue.key === key);
  const codebookEditorIssueByKey = (key: string) => visibleCodebookIssues.find((issue) => issue.key === key);
  const codebookEntryIssues = (index: number) => visibleCodebookIssues.filter((issue) => issue.codebookIndex === index);
  const modelFieldIssue = (index: number, field: SetupIssue["field"]) =>
    setupIssues.find((issue) => issue.modelIndex === index && issue.field === field);

  const revealSetupIssues = (issues: SetupIssue[]) => {
    if (issues.length === 0) return;
    setOpenPanels((previous) => {
      const next = new Set(previous);
      issues.forEach((issue) => next.add(issue.panel));
      return next;
    });
    setLayoutMode((mode) => mode === "hidden" ? "side" : mode);
    window.setTimeout(() => document.getElementById(`coding-panel-${issues[0].panel}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };

  const panel1SetupFingerprint = JSON.stringify({
      uploadId: uploadResult?.file_id ?? null, uploadAvailability, uploading,
      messageColumn, identifierColumns, identityColumn, orderColumn, orderDirection,
      contextColumns, contextDescriptions, rowsAsUnits,
    });
  const panel2SetupFingerprint = JSON.stringify({ codebook, senderVerificationSignature });
  const panel3SetupFingerprint = experimentInstructions;
  const panel4SetupFingerprint = JSON.stringify({ modelSlots, runsPerModel });
  const setupPanelSnapshots = (): Record<SetupIssue["panel"], string> => ({
    1: panel1SetupFingerprint,
    2: panel2SetupFingerprint,
    3: panel3SetupFingerprint,
    4: panel4SetupFingerprint,
  });

  const showSetupValidation = (action: SetupAction): SetupIssue[] => {
    const issues = collectSetupIssues(action);
    setupValidationSnapshotsRef.current = setupPanelSnapshots();
    setSetupIssues(issues);
    revealSetupIssues(issues);
    return issues;
  };

  useEffect(() => {
    const snapshots = setupValidationSnapshotsRef.current;
    if (!snapshots || setupIssues.length === 0) return;
    const current: Record<SetupIssue["panel"], string> = {
      1: panel1SetupFingerprint,
      2: panel2SetupFingerprint,
      3: panel3SetupFingerprint,
      4: panel4SetupFingerprint,
    };
    const changedPanels = new Set<SetupIssue["panel"]>();
    setupIssues.forEach((issue) => {
      if (current[issue.panel] !== snapshots[issue.panel]) changedPanels.add(issue.panel);
    });
    if (changedPanels.size === 0) return;
    setSetupIssues((previous) => previous.filter((issue) => !changedPanels.has(issue.panel)));
    changedPanels.forEach((panel) => { snapshots[panel] = current[panel]; });
  }, [panel1SetupFingerprint, panel2SetupFingerprint, panel3SetupFingerprint, panel4SetupFingerprint, setupIssues]);

  const saveCodebookEditor = () => {
    const cleanedCodebook = codebook.filter((entry) => {
      const hasValueContent = entry.values.some((value) =>
        (entry.type !== "binary" && value.value.trim())
        || value.definition.trim()
        || value.examples.trim()
        || value.context.trim()
      );
      return Boolean(entry.label.trim() || entry.definition.trim() || hasValueContent);
    });
    setCodebook(cleanedCodebook);
    setCodebookSaveAttempted(true);
    const issues = collectCodebookIssues(cleanedCodebook);
    if (issues.length > 0) return;
    setCodebookSaveAttempted(false);
    codebookSnapshotRef.current = JSON.stringify(cleanedCodebook);
    setExpandedTable(null);
    const removed = codebook.length - cleanedCodebook.length;
    showToast(removed > 0 ? `Codebook saved · removed ${removed} empty variable${removed === 1 ? "" : "s"}` : "Codebook saved");
  };

  const handleDownloadPackage = async () => {
    const issues = showSetupValidation("package");
    if (issues.length > 0) return;
    if (!uploadResult || codingActionBusyRef.current || resultDownloadKind) return;
    setSetupIssues([]);
    codingActionBusyRef.current = true;
    setGenerating(true);
    setGenerateError("");
    try {
      const download = await withReadyUpload(async (activeUpload) => {
        const pkgInit = await gzipJsonInit({
          file_id: activeUpload.file_id,
          file_name: activeUpload.file_name,
          message_column: messageColumn,
          identifier_columns: identifierColumns,
          identity_column: identityColumn || null,
          order_column: orderColumn || null,
          order_direction: orderDirection,
          experiment_instructions: experimentInstructions,
          empty_message_handling: emptyMessageHandling,
          codebook,
          participants,
          context: contextColumns.map((c) => ({ column: c, description: contextDescriptions[c] || "" })),
          provider,
          model,
          // Generated packages never contain credentials; the local script reads
          // CAT_API_KEY or prompts securely when it starts.
          api_key: "provided_at_runtime",
          model_slots: [],
          source_rows: selectedSourceIndices,
        });
        const res = await fetch("/api/coding/generate-package", {
          method: "POST",
          headers: pkgInit.headers,
          body: pkgInit.body,
        });
        const contentType = (res.headers.get("Content-Type") || "").toLowerCase();
        if (!res.ok || !contentType.includes("application/zip")) {
          const raw = await res.text();
          const pkgFirewall = firewallErrorFromText(raw);
          if (pkgFirewall) throw pkgFirewall;
          let detail = "";
          let responseCode: string | null = null;
          if (contentType.includes("application/json")) {
            try {
              const parsed = JSON.parse(raw) as { detail?: unknown; code?: unknown };
              detail = typeof parsed.detail === "string" ? parsed.detail : "";
              responseCode = typeof parsed.code === "string" ? parsed.code : null;
            } catch {}
          }
          const errorCode = res.headers.get("X-CAT-Error-Code") || responseCode;
          if (isRestorableUploadCode(errorCode)) {
            throw new UploadUnavailableError(detail || "The uploaded dataset must be restored.", errorCode);
          }
          if (!detail && raw.trim().startsWith("<")) {
            const title = raw.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
            detail = `The server returned an HTML error page instead of the coding package (HTTP ${res.status}${title ? `: ${title}` : ""}).`;
          }
          throw new Error(detail || res.statusText || "Package generation failed");
        }
        return {
          blob: await res.blob(),
          filename: (res.headers.get("Content-Disposition") || "").match(/filename="?([^";]+)"?/)?.[1]
            || "cat_coding_package.zip",
        };
      });
      const { blob, filename } = download;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      showToast("Coding package downloaded");
    } catch (e: unknown) {
      setGenerateError(e instanceof Error ? e.message : "Package download failed");
    } finally {
      setGenerating(false);
      codingActionBusyRef.current = false;
    }
  };

  // ── Console ───────────────────────────────────────────────────────────────

  const log = (level: "info" | "warn" | "error", msg: string) => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setConsoleLogs((prev) => [...prev, { time, level, msg }]);
    setTimeout(() => consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight }), 50);
  };

  const beginRunAction = () => {
    if (codingActionBusyRef.current) return null;
    codingActionBusyRef.current = true;
    const action = {
      token: ++runActionGenerationRef.current,
      controller: new AbortController(),
    };
    runActionRef.current = action;
    runAbortRef.current = action.controller;
    return action;
  };

  const isCurrentRunAction = (action: { token: number; controller: AbortController }) =>
    runActionGenerationRef.current === action.token
    && runActionRef.current?.token === action.token
    && !action.controller.signal.aborted;

  const assertCurrentRunAction = (action: { token: number; controller: AbortController }) => {
    if (!isCurrentRunAction(action)) throw new DOMException("The coding action was stopped.", "AbortError");
  };

  const finishRunAction = (action: { token: number; controller: AbortController }) => {
    if (runActionRef.current?.token !== action.token || runActionGenerationRef.current !== action.token) return;
    runActionRef.current = null;
    if (runAbortRef.current === action.controller) runAbortRef.current = null;
    codingActionBusyRef.current = false;
    setRunning(false);
  };

  const buildResultExportConfig = (): ResultExportConfig => {
    const savedCodebook = codebook.map((entry) => ({
      ...entry,
      values: entry.values.map((value) => ({ ...value })),
    }));
    const savedParticipants = [...participants];
    const savedContext = contextColumns.map((column) => ({
      column,
      description: contextDescriptions[column] || "",
    }));
    const nonsecretModelConfig = modelSlots.map((slot) => ({
      provider: slot.provider,
      model: slot.model,
      temperature: slot.temperature,
      topP: slot.topP,
      maxTokens: slot.maxTokens,
    }));
    const fingerprint = JSON.stringify({
      messageColumn,
      identifierColumns,
      identityColumn,
      orderColumn,
      orderDirection,
      context: savedContext,
      codebook: savedCodebook,
      participants: savedParticipants,
      emptyMessageHandling,
      experimentInstructions,
      models: nonsecretModelConfig,
      runsPerModel,
    });
    return {
      messageColumn,
      identifierColumns: [...identifierColumns],
      identityColumn,
      orderColumn,
      orderDirection,
      context: savedContext,
      codebook: savedCodebook,
      participants: savedParticipants,
      models: nonsecretModelConfig,
      runsPerModel,
      rowsAsUnits,
      episodeCount: rowsAsUnits ? effectiveRowCount : preprocessedRows.length,
      modelCallCount: modelSlots.length * runsPerModel,
      fingerprint,
    };
  };

  // ── Run coding ────────────────────────────────────────────────────────────

  // Start the run on the server instead of inside this connection. Returns as
  // soon as the job exists; from then on the results panel watches it by token,
  // and the run survives this tab closing.
  // A finished server-side run is pulled into the same state a browser run leaves
  // behind, so the results panel below shows the ordinary view — live results,
  // validation, agreement, downloads and the run summary — with no second
  // implementation to keep in step.
  const adoptServerRunResults = useCallback(async (job: JobStatus) => {
    if (job.status !== "completed" || !job.result_path) return;
    setRunFinishedAt(new Date().toISOString());
    try {
      const key = serverRunKey || (() => {
        try { return localStorage.getItem(`cat_run_key_${job.token}`) || ""; } catch { return ""; }
      })();
      const response = await fetch(`/api/coding/jobs/${encodeURIComponent(job.token)}/rows`, {
        headers: key ? { "X-CAT-Run-Key": key } : undefined,
      });
      if (response.ok) {
        const data = (await response.json()) as { rows?: CodedRow[]; config?: ServerRunConfig };
        if (Array.isArray(data.rows)) setCodedRows(data.rows);
        // Opened by link, this browser has no setup of its own to export from.
        if (data.config && Object.keys(data.config).length > 0) {
          setResultExportConfig((existing) => existing ?? exportConfigFromServer(data.config!, data.rows?.length ?? 0));
        }
      }
    } catch { /* the progress panel still shows the outcome and the download */ }
    // The cards above the results read this; without it a run opened by link
    // reports 0 processed out of 0.
    setRunProgress({ current: job.current, total: job.total, percent: 100 });
    setRunComplete({
      total_rows: job.total,
      coded_rows: job.episodes_coded,
      file_path: job.result_path,
    });
  }, [serverRunKey]);

  // Shown while a server-side run is going and kept afterwards, so the link, the
  // access key and the server-side download stay reachable next to the ordinary
  // results view.
  // Same estimate the server-side run shows, from the rate this run is achieving.
  // Sequential coding makes the first few episodes predict the rest closely.
  const browserRunEta = (() => {
    if (!running || !runStartedAt || !runProgress || runProgress.current < 5) return null;
    if (runProgress.current >= runProgress.total) return null;
    const elapsed = (Date.now() - new Date(runStartedAt).getTime()) / 1000;
    if (elapsed <= 0) return null;
    return Math.max(0, Math.round((runProgress.total - runProgress.current) * (elapsed / runProgress.current)));
  })();

  const watchedRunToken = serverRunToken || (viewingRunLink ? linkedRunToken : "");
  // The results panel defaults to the script view, which is meaningless when the
  // page *is* a run. Derived rather than set, so opening a link needs no effect.
  const effectiveRightView = viewingRunLink ? "run" : rightView;
  // The workspace opens with the config column filling the width, which hides the
  // results pane entirely. A run link is nothing but results, so treat it as the
  // side-by-side layout — derived, so opening a link needs no effect.
  const effectiveLayoutMode = viewingRunLink ? "side" : layoutMode;
  const serverRunHeader = watchedRunToken ? (
    <>
      <RunProgress token={watchedRunToken} onFinished={adoptServerRunResults} />
      {!viewingRunLink && (
        <p className="job-note">
          This run continues on the server even if you close CAT. Its own
          link: <a href={`/runs/${watchedRunToken}`} target="_blank" rel="noopener noreferrer">/runs/{watchedRunToken.slice(0, 8)}…</a>
        </p>
      )}
      {serverRunKey && (
        <div className="job-key-callout">
          <span>Access key for this run</span>
          <code>{serverRunKey}</code>
          <span className="job-key-note">
            Needed to open the run on another device. We emailed it with the link,
            and this browser already has it.
          </span>
        </div>
      )}
    </>
  ) : null;

  /** The run configuration, shared by the estimate and by starting a run. */
  const buildRunConfig = (fileId: string) => ({
    file_id: fileId,
    file_name: uploadResult?.file_name ?? "",
    message_column: messageColumn,
    identifier_columns: identifierColumns,
    identity_column: identityColumn || null,
    order_column: orderColumn || null,
    order_direction: orderDirection,
    experiment_instructions: experimentInstructions,
    coding_instructions: "",
    empty_message_handling: emptyMessageHandling,
    codebook,
    participants,
    context: contextColumns.map((c) => ({ column: c, description: contextDescriptions[c] || "" })),
    model_slots: modelSlots.map(buildSlotPayload),
    runs_per_model: runsPerModel,
    source_rows: selectedSourceIndices,
    row_indices: null,
  });

  // Ask what the run will take before committing to it. A run is a long,
  // irreversible spend against the researcher's own API key, and until now the
  // only way to find out its size was to start it.
  const openRunConfirmation = async (kind: "browser" | "server") => {
    const issues = showSetupValidation("run");
    if (issues.length > 0) return;
    if (!uploadResult || resultDownloadKind) return;
    if (kind === "server") {
      const address = resultEmail.trim();
      if (emailNotifications && !address) {
        setServerRunError("Enter the email address we should send the link to.");
        setOpenPanels((prev) => new Set(prev).add(4));
        return;
      }
      if (address && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
        setServerRunError("That does not look like a valid email address.");
        setOpenPanels((prev) => new Set(prev).add(4));
        return;
      }
      setServerRunError("");
    }
    setSetupIssues([]);
    setPendingRun(kind);
    setEstimate(null);
    setEstimateError("");
    setEstimateLoading(true);
    try {
      const init = await gzipJsonInit({ config: buildRunConfig(uploadResult.file_id) });
      const response = await fetch("/api/coding/estimate", {
        method: "POST",
        headers: init.headers,
        body: init.body,
      });
      const raw = await response.text();
      const firewall = firewallErrorFromText(raw);
      if (firewall) throw firewall;
      if (!response.ok) {
        let detail = response.statusText;
        try { detail = (JSON.parse(raw) as { detail?: string }).detail || detail; } catch {}
        throw new Error(detail);
      }
      setEstimate(JSON.parse(raw) as RunEstimate);
    } catch (e: unknown) {
      // The estimate failing must not block the run; the dialog says so and
      // still offers to start.
      setEstimateError(e instanceof Error ? e.message : "Could not estimate this run.");
    } finally {
      setEstimateLoading(false);
    }
  };

  const confirmPendingRun = () => {
    const kind = pendingRun;
    setPendingRun(null);
    if (kind === "server") void handleRunOnServer();
    else if (kind === "browser") void handleRun();
  };

  const handleRunOnServer = async () => {
    const issues = showSetupValidation("run");
    if (issues.length > 0) return;
    if (!uploadResult || resultDownloadKind || startingServerRun) return;
    setSetupIssues([]);
    // Asking to be emailed without saying where is the one setup mistake this
    // option invites, so catch it before the run starts rather than after.
    const notifyEmail = resultEmail.trim();
    if (emailNotifications && !notifyEmail) {
      setServerRunError("Enter the email address we should send the link to.");
      setOpenPanels((prev) => new Set(prev).add(4));
      return;
    }
    if (notifyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail)) {
      setServerRunError("That does not look like a valid email address.");
      setOpenPanels((prev) => new Set(prev).add(4));
      return;
    }
    setServerRunError("");
    setStartingServerRun(true);
    try {
      const readyUpload = await withReadyUpload(
        async (upload) => upload,
        { recovery: { used: false } },
      );
      const init = await gzipJsonInit({
        config: {
          file_id: readyUpload.file_id,
          file_name: readyUpload.file_name,
          message_column: messageColumn,
          identifier_columns: identifierColumns,
          identity_column: identityColumn || null,
          order_column: orderColumn || null,
          order_direction: orderDirection,
          experiment_instructions: experimentInstructions,
          empty_message_handling: emptyMessageHandling,
          codebook,
          participants,
          context: contextColumns.map((c) => ({ column: c, description: contextDescriptions[c] || "" })),
          model_slots: modelSlots.map(buildSlotPayload),
          runs_per_model: runsPerModel,
          source_rows: selectedSourceIndices,
          row_indices: null,
        },
        email: notifyEmail,
      });
      const response = await fetch("/api/coding/jobs", {
        method: "POST",
        headers: init.headers,
        body: init.body,
      });
      const raw = await response.text();
      const firewall = firewallErrorFromText(raw);
      if (firewall) throw firewall;
      if (!response.ok) {
        let detail = response.statusText;
        try { detail = (JSON.parse(raw) as { detail?: string }).detail || detail; } catch {}
        throw new Error(detail);
      }
      const job = JSON.parse(raw) as { token: string; access_key?: string };
      setServerRunToken(job.token);
      setServerRunKey(job.access_key || "");
      // Stored for this browser so the run opens here without the prompt. The
      // key is returned once, at creation, and never again.
      if (job.access_key) rememberRunKey(job.token, job.access_key);
      setResultExportConfig(buildResultExportConfig());
      setRunStartedAt(new Date().toISOString());
      setRunFinishedAt(null);
      setValidationReport(null);
      setRightView("run");
      // The results column is collapsed in "fill" mode, so without this the run
      // starts correctly and the researcher sees nothing happen.
      setLayoutMode((m) => (m === "fill" ? "side" : m));
      // A previous browser run's output would otherwise sit underneath this one.
      setCodedRows([]);
      setRunErrors([]);
      setRunComplete(null);
      setRunError("");
      // Remembered so reopening CAT offers the run back even if the email never
      // arrives or was never requested.
      try { localStorage.setItem("cat_last_server_run", job.token); } catch {}
    } catch (e: unknown) {
      setServerRunError(e instanceof Error ? e.message : "Could not start the run on the server.");
    } finally {
      setStartingServerRun(false);
    }
  };

  const handleRun = async () => {
    const issues = showSetupValidation("run");
    if (issues.length > 0) return;
    if (!uploadResult || resultDownloadKind) return;
    setSetupIssues([]);
    const action = beginRunAction();
    if (!action) return;
    const signal = action.controller.signal;
    const uploadRecovery = { used: false };
    setRunning(true);
    setRunProgress(null);
    setCodedRows([]);
    setRunErrors([]);
    setRunComplete(null);
    setRunError("");
    setValidationReport(null);
    setAgreementReport(null); setAgreementLoading(false); setAgreementError("");
    setResultDownloadError("");
    setResultExportConfig(buildResultExportConfig());
    setGenerateError("");
    setConsoleLogs([]);
    setRightView("run");
    setLayoutMode((m) => (m === "fill" ? "side" : m));
    setRunStartedAt(new Date().toISOString());
    setRunFinishedAt(null);
    log("info", "Checking the uploaded dataset...");

    // Outcome tracking (state is stale inside this closure, so use locals).
    const runId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const runStartMs = Date.now();
    let startTracked = false;
    let outcomeCoded = 0;
    let outcomeErrors = 0;
    let outcomeCompleted = false;
    let outcomeStopped = false;
    const outcomeErrorSamples: string[] = [];
    const noteError = (msg: string) => {
      outcomeErrors += 1;
      if (outcomeErrorSamples.length < 10) outcomeErrorSamples.push(String(msg).slice(0, 300));
    };

    let stage: "preflight" | "script" | "validation" | "stream" = "preflight";
    try {
      const activeUpload = await withReadyUpload(
        async (readyUpload) => readyUpload,
        { recovery: uploadRecovery, signal },
      );
      assertCurrentRunAction(action);
      trackEvent("run", { run_id: runId });
      startTracked = true;

      stage = "script";
      log("info", "Generating coding script...");
      const scriptInit = await gzipJsonInit({
        file_name: activeUpload.file_name,
        message_column: messageColumn,
        identifier_columns: identifierColumns,
        identity_column: identityColumn || null,
        order_column: orderColumn || null,
        order_direction: orderDirection,
        experiment_instructions: experimentInstructions,
        empty_message_handling: emptyMessageHandling,
        codebook,
        participants,
        context: contextColumns.map((c) => ({ column: c, description: contextDescriptions[c] || "" })),
        provider,
        model,
        // Script previews do not contain credentials. The actual browser run
        // sends the entered key only to validation and coding endpoints below.
        api_key: "provided_at_runtime",
        model_slots: [],
      });
      const res = await fetch("/api/coding/generate-script", {
        method: "POST",
        headers: scriptInit.headers,
        signal,
        body: scriptInit.body,
      });
      const scriptRaw = await res.text();
      const scriptFirewall = firewallErrorFromText(scriptRaw);
      if (scriptFirewall) throw scriptFirewall;
      if (!res.ok) {
        let detail = res.statusText;
        try { detail = (JSON.parse(scriptRaw) as { detail?: string }).detail || detail; } catch {}
        throw new Error(detail);
      }
      const data: GenerateResult = JSON.parse(scriptRaw);
      assertCurrentRunAction(action);
      setResult(data);
      log("info", `Script generated: ${data.filename}`);

      stage = "validation";
      log("info", "Validating API keys and models...");
      const valInit = await gzipJsonInit({
        model_slots: modelSlots.map((s) => ({
          provider: s.provider,
          model: s.model,
          api_key: s.apiKey,
        })),
      });
      const valRes = await fetch("/api/coding/validate", {
        method: "POST",
        headers: valInit.headers,
        signal,
        body: valInit.body,
      });
      const valRaw = await valRes.text();
      const valFirewall = firewallErrorFromText(valRaw);
      if (valFirewall) throw valFirewall;
      if (!valRes.ok) throw new Error("Validation request failed");
      const valData = JSON.parse(valRaw);
      assertCurrentRunAction(action);
      for (const r of valData.results) {
        if (r.ok) log("info", `  ${r.label} — OK`);
        else log("error", `  ${r.label} — FAILED: ${r.error}`);
      }
      if (!valData.ok) {
        log("error", "Validation failed. Fix the errors above before running.");
        return;
      }
      log("info", "All models validated successfully.");

      stage = "stream";
      log("info", "Connecting to coding service...");
      const modelNames = modelSlots.map((s) => {
        const p = PROVIDERS.find((p) => p.value === s.provider);
        const m = p?.models.find((m) => m.value === s.model);
        return `${p?.label}/${m?.label}`;
      });
      log("info", `Models: ${modelNames.join(", ")} × ${runsPerModel} run${runsPerModel > 1 ? "s" : ""} each`);
      log("info", `Aggregation: configured per variable · File: ${activeUpload.file_name} (${activeUpload.row_count} rows)`);
      log("info", `Codebook: ${codebook.filter((e) => e.label.trim()).map((e) => e.label).join(", ")}`);
      log("info", "Connected. Starting coding...");

      await withReadyUpload(async (streamUpload) => {
        assertCurrentRunAction(action);
        try {
          await streamJsonLines<CodingStreamMessage>(
            "/api/coding/run-stream",
            {
              file_id: streamUpload.file_id,
              message_column: messageColumn,
              identifier_columns: identifierColumns,
              identity_column: identityColumn || null,
              order_column: orderColumn || null,
              order_direction: orderDirection,
              experiment_instructions: experimentInstructions,
              empty_message_handling: emptyMessageHandling,
              codebook,
              participants,
              context: contextColumns.map((c) => ({ column: c, description: contextDescriptions[c] || "" })),
              model_slots: modelSlots.map(buildSlotPayload),
              runs_per_model: runsPerModel,
              source_rows: selectedSourceIndices,
              row_indices: null,
              // The server records every run's outcome on its own (the browser
              // report below needs analytics consent and a surviving tab). Sharing
              // the id lets the dashboard treat both reports as one run. Only sent
              // with consent: without it the server uses an id of its own.
              client_run_id: analyticsConsent === "accepted" ? runId : null,
            },
            signal,
            (msg) => {
              assertCurrentRunAction(action);
              if (msg.type === "progress") {
                setRunProgress({ current: msg.current!, total: msg.total!, percent: msg.percent! });
                log("info", `Episode ${msg.current}/${msg.total} (${msg.percent}%)`);
              } else if (msg.type === "row") {
                const row = { index: msg.index!, original: msg.original!, coded: msg.coded! };
                setCodedRows((prev) => [...prev, row]);
                outcomeCoded += 1;
                const issues = checkRow(row.index, row.coded, resultVars);
                for (const issue of issues) {
                  const detail = issue.issueType === "api_error"
                    ? `Episode ${row.index + 1}: ${issue.value}`
                    : `Episode ${row.index + 1}: ${issue.variable} ${issue.issueType === "not_numeric" ? "not numeric" : "out of range"} (got "${String(issue.value)}")`;
                  setRunErrors((prev) => [...prev, detail]);
                  noteError(detail);
                  log("warn", detail);
                }
              } else if (msg.type === "error" && isRestorableUploadCode(msg.code)) {
                throw new UploadUnavailableError(msg.message || "The uploaded dataset must be restored.", msg.code);
              } else if (msg.type === "error" && msg.index !== undefined) {
                const message = msg.message ?? "Coding failed";
                setRunErrors((prev) => [...prev, message]);
                noteError(message);
                log("error", message);
              } else if (msg.type === "error") {
                const message = msg.message ?? "Coding failed";
                setRunError(message);
                noteError(message);
                log("error", `Fatal: ${message}`);
              } else if (msg.type === "complete") {
                setRunComplete({
                  total_rows: msg.total_rows!,
                  coded_rows: msg.coded_rows!,
                  file_path: msg.file_path!,
                });
                outcomeCompleted = true;
                outcomeCoded = msg.codings ?? msg.coded_rows ?? outcomeCoded;
                log("info", `Coding complete. ${msg.total_rows} episodes processed, ${msg.coded_rows} coded.`);
              }
            },
          );
          assertCurrentRunAction(action);
        } catch (error) {
          if (error instanceof StreamResponseError && isRestorableUploadCode(error.code)) {
            throw new UploadUnavailableError(error.message, error.code);
          }
          throw error;
        }
      }, { initialUpload: activeUpload, recovery: uploadRecovery, signal });
    } catch (e: unknown) {
      if (isAbortError(e)) outcomeStopped = true;
      if (isAbortError(e) || !isCurrentRunAction(action)) return;
      const message = e instanceof Error ? e.message : "Coding failed";
      noteError(message);
      if (stage === "preflight") {
        setGenerateError(message);
      } else if (stage === "script") {
        log("error", `Script generation failed: ${message}`);
        setGenerateError(message);
      } else if (stage === "validation") {
        log("error", `Validation error: ${message}`);
      } else {
        log("error", `Coding connection failed: ${message}`);
        setRunError(message);
      }
    } finally {
      // Record the run's outcome so the admin can distinguish completed runs
      // from failed, stopped, or abandoned ones.
      if (startTracked) {
        const status = outcomeStopped ? "stopped" : outcomeCompleted ? "completed" : "failed";
        trackEvent("run_complete", {
          run_id: runId,
          status,
          episodes_coded: outcomeCoded,
          error_count: outcomeErrors,
          duration_ms: Date.now() - runStartMs,
          error_sample: outcomeErrorSamples,
        });
      }
      finishRunAction(action);
    }
  };

  const handleStop = () => {
    const action = runActionRef.current;
    if (!action) return;
    runActionGenerationRef.current += 1;
    runActionRef.current = null;
    codingActionBusyRef.current = false;
    action.controller.abort();
    runAbortRef.current = null;
    uploadPreflightRef.current = null;
    restorePromiseRef.current = null;
    if (uploadRequestRef.current) {
      uploadLifecycleRef.current += 1;
      uploadRequestRef.current.controller.abort();
      uploadRequestRef.current = null;
      setUploading(false);
    }
    if (!liveUploadIdRef.current && uploadMeta) {
      setUploadAvailability("reupload-required");
    }
    log("warn", "Coding stopped by user.");
    setRunning(false);
  };

  const handleExportResults = async () => {
    if (!runComplete || !uploadResult || running || generating || resultDownloadKind) return;
    const exportConfig = resultExportConfig ?? buildResultExportConfig();
    const bundled = exportConfig.modelCallCount > 1;
    setResultDownloadKind("results");
    setResultDownloadError("");
    const uploadRecovery = { used: false };
    try {
      const fallbackStem = (uploadResult.file_name || "dataset").replace(/\.[^.]+$/, "") || "dataset";
      const artifact = await withReadyUpload(async (activeUpload) => {
        const exportInit = await gzipJsonInit({
          file_id: activeUpload.file_id,
          message_column: exportConfig.messageColumn,
          identifier_columns: exportConfig.identifierColumns,
          identity_column: exportConfig.identityColumn || null,
          order_column: exportConfig.orderColumn || null,
          order_direction: exportConfig.orderDirection,
          context: exportConfig.context,
          codebook: exportConfig.codebook,
          participants: exportConfig.participants,
          // Send only the latest aggregate value for each episode. Selective
          // reruns replace entries in codedRows by index before this export.
          coded_rows: codedRows.map(({ index, coded }) => ({ index, coded })),
          kind: "primary",
          result_path: runComplete.file_path,
          model_call_count: exportConfig.modelCallCount,
        });
        const response = await fetch("/api/coding/export-results", {
          method: "POST",
          headers: exportInit.headers,
          body: exportInit.body,
        });
        return parseDownloadArtifact(
          response,
          bundled ? "zip" : "csv",
          bundled ? `${fallbackStem}_coded_results.zip` : `${fallbackStem}_coded.csv`,
        );
      }, { recovery: uploadRecovery });
      downloadBlob(artifact.blob, artifact.filename);
      showToast(bundled ? "Complete results package downloaded" : "Coded dataset downloaded");
    } catch (error) {
      setResultDownloadError(error instanceof Error ? error.message : "Could not download the results.");
    } finally {
      setResultDownloadKind(null);
    }
  };

  const handleCodebookDownload = async (format: "json" | "csv" | "txt" | "pdf" | "xlsx" | "latex") => {
    const entries = codebook.filter((e) => e.label.trim());
    const filename = `codebook`;

    // Flatten: one row per coded value. Numeric/text vars (no values) get a single blank-value row.
    const flatRows = entries.flatMap((e) => {
      const level = e.level;
      if (e.values.length === 0) {
        return [{
          label: e.label, type: e.type, level, aggregation: e.type === "text" ? "not aggregated" : e.aggregation, definition: e.definition,
          value: "", value_definition: "", examples: "", context: "",
        }];
      }
      return e.values
        .filter((v) => v.value.trim() || v.definition.trim())
        .map((v) => ({
          label: e.label, type: e.type, level, aggregation: e.type === "text" ? "not aggregated" : e.aggregation, definition: e.definition,
          value: v.value, value_definition: v.definition, examples: v.examples, context: v.context,
        }));
    });

    if (format === "json") {
      const data = JSON.stringify(entries.map((e) => ({
        label: e.label,
        type: e.type,
        level: e.level,
        aggregation: e.type === "text" ? "not aggregated" : e.aggregation,
        definition: e.definition,
        values: e.values
          .filter((v) => v.value.trim() || v.definition.trim())
          .map((v) => ({
            value: v.value,
            definition: v.definition,
            examples: v.examples || null,
            context: v.context || null,
          })),
      })), null, 2);
      downloadBlob(new Blob([data], { type: "application/json" }), `${filename}.json`);

    } else if (format === "csv") {
      const header = "label,type,level,aggregation,definition,value,value_definition,examples,context";
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = flatRows.map((r) =>
        [r.label, r.type, r.level, r.aggregation, r.definition, r.value, r.value_definition, r.examples, r.context]
          .map(esc).join(",")
      );
      downloadBlob(new Blob([[header, ...rows].join("\n")], { type: "text/csv" }), `${filename}.csv`);

    } else if (format === "txt") {
      const lines = entries.map((e, i) => {
        const head = [
          `${i + 1}. ${e.label} (${e.type}, ${e.level === "sender" ? "per sender" : "per episode"})`,
          `   Aggregation: ${e.type === "text" ? "not aggregated; every response is exported separately" : e.aggregation === "mean" ? "average (mean)" : "majority vote (mode)"}`,
          `   Definition: ${e.definition}`,
        ];
        const valueLines = e.values
          .filter((v) => v.value.trim() || v.definition.trim())
          .map((v) => {
            const parts = [`   - ${v.value}: ${v.definition}`];
            if (v.examples.trim()) parts.push(`       Examples: ${v.examples}`);
            if (v.context.trim()) parts.push(`       Context: ${v.context}`);
            return parts.join("\n");
          });
        return [...head, ...valueLines].join("\n");
      });
      downloadBlob(new Blob([lines.join("\n\n")], { type: "text/plain" }), `${filename}.txt`);

    } else if (format === "xlsx") {
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.json_to_sheet(flatRows, { header: [...CODEBOOK_EXPORT_COLUMNS] });
      ws["!cols"] = [
        { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 36 },
        { wch: 10 }, { wch: 36 }, { wch: 28 }, { wch: 28 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Codebook");
      XLSX.writeFile(wb, `${filename}.xlsx`);

    } else if (format === "pdf") {
      const sections = entries.map((e, i) => {
        const valueRows = e.values
          .filter((v) => v.value.trim() || v.definition.trim())
          .map((v) => `
            <tr class="value-row">
              <td class="value-cell">${htmlEsc(v.value)}</td>
              <td>${htmlEsc(v.definition)}</td>
              <td class="muted">${htmlEsc(v.examples) || "—"}</td>
              <td class="muted">${htmlEsc(v.context) || "—"}</td>
            </tr>`).join("");

        return `
          <div class="var-block">
            <div class="var-head">
              <span class="var-num">${i + 1}</span>
              <span class="var-label">${htmlEsc(e.label)}</span>
              <span class="var-meta">${htmlEsc(e.type)} · ${e.level === "sender" ? "per sender" : "per episode"} · ${e.type === "text" ? "not aggregated" : e.aggregation === "mean" ? "average" : "majority vote"}</span>
            </div>
            <p class="var-def">${htmlEsc(e.definition)}</p>
            ${valueRows ? `
              <table class="value-table">
                <thead><tr><th>Value</th><th>Definition</th><th>Examples</th><th>Context</th></tr></thead>
                <tbody>${valueRows}</tbody>
              </table>` : `<p class="muted">No fixed values (numeric/free text).</p>`}
          </div>`;
      }).join("");

      const html = `<!DOCTYPE html>
  <html><head><meta charset="utf-8"><title>Codebook</title>
  <style>
    body{font-family:-apple-system,sans-serif;padding:40px;color:#18181b;font-size:13px}
    h1{font-size:18px;font-weight:600;margin-bottom:4px}
    p{color:#71717a;margin-bottom:24px;font-size:12px}
    .var-block{margin-bottom:22px;page-break-inside:avoid}
    .var-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
    .var-num{color:#a1a1aa;font-size:11px}
    .var-label{font-weight:600;font-size:14px}
    .var-meta{color:#7c4dab;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
    .var-def{color:#3f3f46;font-size:12px;margin:0 0 8px;font-style:italic}
    .value-table{width:100%;border-collapse:collapse;margin-top:4px}
    .value-table th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;
      color:#a1a1aa;border-bottom:2px solid #e4e4e7;padding:5px 8px}
    .value-table td{padding:6px 8px;border-bottom:1px solid #f4f4f5;vertical-align:top;font-size:12px}
    .value-cell{font-family:monospace;color:#7c4dab;font-weight:600;width:60px}
    .muted{color:#a1a1aa;font-size:11px}
    @media print{body{padding:20px}}
    ${PDF_WATERMARK_CSS}
  </style></head>
  <body>
    ${PDF_WATERMARK_HTML}
    <h1>Codebook</h1>
    <p>Generated ${new Date().toLocaleDateString()} · ${entries.length} variable${entries.length !== 1 ? "s" : ""}</p>
    ${sections}
  </body></html>`;

      const win = window.open("", "_blank");
      if (win) {
        win.document.write(html);
        win.document.close();
        win.print();
      }

    } else if (format === "latex") {
      const esc = (s: string) => String(s ?? "")
        .replace(/\\/g, "\\textbackslash{}")
        .replace(/([&%$#_{}])/g, "\\$1")
        .replace(/~/g, "\\textasciitilde{}")
        .replace(/\^/g, "\\textasciicircum{}")
        .replace(/—/g, "---").replace(/–/g, "--")
        .replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
      const DASH = "---";
      const blocks = entries.map((e) => {
        const meta = `${e.type}, ${e.level === "sender" ? "per sender" : "per episode"}, ${e.type === "text" ? "not aggregated" : e.aggregation === "mean" ? "average" : "majority vote"}`;
        const header = `\\multicolumn{3}{@{}l}{\\textbf{${esc(e.label)}} \\quad \\textit{(${esc(meta)})}} \\\\`;
        const def = e.definition.trim() ? `\\multicolumn{3}{@{}p{\\linewidth}}{${esc(e.definition)}} \\\\` : "";
        const vals = e.values.filter((v) => v.value.trim() || v.definition.trim());
        let rows: string;
        if (vals.length === 0) {
          const kind = e.type === "numeric" ? "numeric --- free number" : "free text";
          rows = `\\multicolumn{3}{@{}l}{\\quad \\textit{(${kind}, no fixed values)}} \\\\`;
        } else {
          rows = vals.map((v) => {
            const notes = [
              v.examples.trim() ? `e.g.\\ ${esc(v.examples)}` : "",
              v.context.trim() ? esc(v.context) : "",
            ].filter(Boolean).join("; ") || DASH;
            return `${esc(v.value) || DASH} & ${esc(v.definition) || DASH} & ${notes} \\\\`;
          }).join("\n");
        }
        return [header, def, "\\addlinespace[2pt]", rows].filter(Boolean).join("\n");
      }).join("\n\\midrule\n");

      const tex = `% Codebook — generated by CAT (Communication Annotation Tool)
% Requires in your preamble: \\usepackage{booktabs}
\\begin{table}[htbp]
\\centering
\\caption{Coding codebook}
\\label{tab:codebook}
\\footnotesize
\\begin{tabular}{@{}l p{6cm} p{3.6cm}@{}}
\\toprule
\\textbf{Value} & \\textbf{Definition} & \\textbf{Examples / context} \\\\
\\midrule
${blocks}
\\bottomrule
\\end{tabular}
\\end{table}
`;
      downloadBlob(new Blob([tex], { type: "application/x-tex" }), `${filename}.tex`);
    }

    showToast(`Codebook exported as .${format}`);
  };

  // Helper used by handleCodebookDownload
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Run summary (printable PDF) ─────────────────────────────────────────────
  const handleRunSummary = () => {
    if (!uploadResult || !runComplete) return;
    const summaryConfig = resultExportConfig ?? buildResultExportConfig();
    const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
    let duration = "—";
    if (runStartedAt && runFinishedAt) {
      const ms = new Date(runFinishedAt).getTime() - new Date(runStartedAt).getTime();
      const s = Math.max(0, Math.round(ms / 1000));
      duration = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    }
    const totalCalls = summaryConfig.modelCallCount;
    const episodeCount = summaryConfig.episodeCount;
    const errs = runErrors.length;
    const rowsHtml = (arr: string[]) => arr.join("");

    const modelRows = summaryConfig.models.map((s, i) => {
      const p = PROVIDERS.find((pp) => pp.value === s.provider);
      const m = p?.models.find((mm) => mm.value === s.model);
      const noTemp = modelIgnoresTemperature(s.provider, s.model);
      return `<tr><td>${i + 1}</td><td>${htmlEsc(p?.label ?? s.provider)}</td><td>${htmlEsc(m?.label ?? s.model)}</td>
        <td>${noTemp ? "n/a" : (s.temperature ?? 0.2)}</td><td>${s.topP ?? 1.0}</td><td>${s.maxTokens ?? 1024}</td></tr>`;
    });
    const summaryCodebook = summaryConfig.codebook.filter((e) => e.label.trim());
    const cbRows = summaryCodebook.map((e) => {
      const vals = TYPE_HAS_VALUES(e.type) ? e.values.filter((v) => v.value.trim()).map((v) => v.value).join(", ") : "—";
      return `<tr><td>${htmlEsc(e.label)}</td><td>${htmlEsc(e.type)}</td><td>${e.level === "sender" ? "per sender" : "per episode"}</td><td>${e.type === "text" ? "Not aggregated" : e.aggregation === "mean" ? "Average (mean)" : "Majority vote (mode)"}</td><td>${htmlEsc(vals)}</td></tr>`;
    });
    const agreementMetricTable = (rows: InterCoderAgreementVariable[]) => `<table>
                <thead><tr><th>Variable</th><th>Agreement</th><th>Cohen's κ</th><th>AC1</th><th>N</th></tr></thead>
                <tbody>
                  ${rows.map((metric) => `<tr>
                    <td>${htmlEsc(metric.variable)}</td>
                    <td>${metric.agreement_rate == null ? "—" : `${metric.agreement_rate.toFixed(1)}%`}</td>
                    <td>${metric.cohens_kappa == null ? "N/A" : metric.cohens_kappa.toFixed(3)}</td>
                    <td>${metric.gwets_ac1 == null ? "N/A" : metric.gwets_ac1.toFixed(3)}</td>
                    <td>${metric.n}</td>
                  </tr>`).join("")}
                </tbody>
              </table>`;
    const hasAgreement = !!agreementReport
      && agreementReport.numeric_variables.length > 0
      && (agreementReport.within_models.length > 0 || agreementReport.pairs.length > 0);
    const withinSection = agreementReport && agreementReport.within_models.length > 0
      ? `<h2>Agreement within each LLM</h2>
        <p class="muted">How consistently one model repeated itself across its own runs.</p>
        ${agreementReport.within_models.map((model) => `<div class="agreement-report-pair">
              <h3>${htmlEsc(model.model)} — ${model.run_count} runs${model.pair_count > 1
                ? `, averaged over ${model.pair_count} run pairs`
                : ""}</h3>
              ${agreementMetricTable(model.variables)}
            </div>`).join("")}`
      : "";
    const betweenSection = agreementReport && agreementReport.pairs.length > 0
      ? `<h2>Agreement between LLMs</h2>
        <p class="muted">Each model's runs are aggregated first, then the models are compared.</p>
        ${agreementReport.pairs.map((pair) => `<div class="agreement-report-pair">
              <h3>${htmlEsc(pair.model_a)} vs ${htmlEsc(pair.model_b)}</h3>
              ${agreementMetricTable(pair.variables)}
            </div>`).join("")}`
      : "";
    const agreementSection = hasAgreement
      ? `${withinSection}${betweenSection}
        <p class="note"><strong>Agreement</strong> — exact-match rate. <strong>Cohen's κ</strong> — agreement corrected for chance. <strong>AC1</strong> — Gwet's chance-corrected agreement, which stays stable when one category dominates. <strong>N</strong> — episodes scored by both coders.</p>`
      : "";

    const kv = (k: string, v: string) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Run Summary</title>
<style>
  body{font-family:-apple-system,Segoe UI,sans-serif;padding:40px;color:#18181b;font-size:12.5px}
  h1{font-size:19px;font-weight:700;margin-bottom:2px}
  .sub{color:#71717a;font-size:11px;margin-bottom:20px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#7c4dab;margin:18px 0 6px;border-bottom:1px solid #e4e4e7;padding-bottom:3px}
  h3{font-size:11px;margin:10px 0 4px}
  table{width:100%;border-collapse:collapse;margin-bottom:6px}
  td,th{padding:4px 8px;border-bottom:1px solid #f1f1f4;text-align:left;vertical-align:top}
  th{font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:#a1a1aa}
  td.k{color:#71717a;width:180px}
  .agreement-report-pair{break-inside:avoid;page-break-inside:avoid;margin-bottom:10px}
  .note,.muted{color:#71717a;font-size:10.5px;line-height:1.4}
  .pill{display:inline-block;padding:1px 7px;border-radius:10px;background:#f3eef8;color:#5b2d8e;font-weight:600;font-size:11px}
  @media print{body{padding:24px}}
  ${PDF_WATERMARK_CSS}
</style></head><body>
${PDF_WATERMARK_HTML}
<h1>LLM Coding — Run Summary</h1>
<div class="sub">Generated ${new Date().toLocaleString()}</div>

<h2>Run</h2>
<table>
  ${kv("Started", fmt(runStartedAt))}
  ${kv("Finished", fmt(runFinishedAt))}
  ${kv("Duration", duration)}
  ${kv("Episodes in task", String(episodeCount))}
  ${kv("Unresolved output issues", String(validationReport?.problematicIndices.length ?? 0))}
  ${kv("Errors", errs > 0 ? `<span class="pill" style="background:#fee2e2;color:#b91c1c">${errs}</span>` : "0")}
  ${kv("Configured calls", `${summaryConfig.models.length} model${summaryConfig.models.length !== 1 ? "s" : ""} × ${summaryConfig.runsPerModel} run${summaryConfig.runsPerModel !== 1 ? "s" : ""} = ${totalCalls} per non-skipped episode`)}
</table>

<h2>Dataset</h2>
<table>
  ${kv("File", htmlEsc(uploadResult.file_name))}
  ${kv("Rows (messages)", String(uploadResult.row_count))}
  ${kv("Episodes", String(episodeCount))}
  ${kv("Columns", htmlEsc(uploadResult.columns.join(", ")))}
</table>

<h2>Column Mapping</h2>
<table>
  ${kv("Message", htmlEsc(summaryConfig.messageColumn || "—"))}
  ${kv("Identifier(s)", summaryConfig.rowsAsUnits ? "each row is its own episode" : htmlEsc(summaryConfig.identifierColumns.join(" + ") || "—"))}
  ${kv("Sender identity", htmlEsc(summaryConfig.identityColumn || "none"))}
  ${kv("Order", summaryConfig.orderColumn ? `${htmlEsc(summaryConfig.orderColumn)} (${summaryConfig.orderDirection})` : "file order")}
  ${kv("Context columns", htmlEsc(summaryConfig.context.map((item) => item.column).join(", ") || "none"))}
</table>

<h2>Models &amp; configuration</h2>
<table>
  <thead><tr><th>#</th><th>Provider</th><th>Model</th><th>Temp</th><th>Top-p</th><th>Max Tokens</th></tr></thead>
  <tbody>${rowsHtml(modelRows)}</tbody>
</table>

<h2>Codebook (${summaryCodebook.length} variable${summaryCodebook.length !== 1 ? "s" : ""})</h2>
<table>
  <thead><tr><th>Label</th><th>Type</th><th>Level</th><th>Aggregation</th><th>Values</th></tr></thead>
  <tbody>${rowsHtml(cbRows)}</tbody>
</table>
${agreementSection}
</body></html>`;

    const win = window.open("", "_blank");
    if (win) { win.document.write(html); win.document.close(); win.print(); }
    showToast("Run summary opened — save as PDF from the print dialog");
  };

  const handleRerun = async (indices: number[] | null) => {
    if (!uploadResult || uploadAvailability !== "ready" || resultDownloadKind) return;
    const previousDetailedPath = indices ? runComplete?.file_path : null;
    if (indices && !previousDetailedPath) {
      setRunError("The previous detailed result records are unavailable. Re-run all episodes once before using a selective rerun.");
      return;
    }
    const currentExportConfig = buildResultExportConfig();
    if (
      indices
      && resultExportConfig
      && currentExportConfig.fingerprint !== resultExportConfig.fingerprint
    ) {
      const message = "The coding setup has changed since this result was produced. Re-run all episodes so every result uses the same mapping, codebook, instructions, and model configuration.";
      setRunError(message);
      showToast("Re-run all episodes after changing the coding setup");
      return;
    }
    const action = beginRunAction();
    if (!action) return;
    const signal = action.controller.signal;
    const uploadRecovery = { used: false };
    setRunning(true);
    setRunProgress(null);
    setRunErrors([]);
    if (!indices) setRunComplete(null);
    setValidationReport(null);
    setAgreementReport(null); setAgreementLoading(false); setAgreementError("");
    setRunError("");
    setResultDownloadError("");
    setConsoleLogs([]);

    if (indices) {
      log("info", `Re-running ${indices.length} affected episodes...`);
    } else {
      setCodedRows([]);
      setResultExportConfig(currentExportConfig);
      log("info", "Re-running all episodes from scratch...");
    }

    let stage: "preflight" | "stream" = "preflight";
    try {
      const activeUpload = await withReadyUpload(
        async (readyUpload) => readyUpload,
        { recovery: uploadRecovery, signal },
      );
      assertCurrentRunAction(action);
      stage = "stream";
      log("info", "Connected. Starting re-coding...");
      await withReadyUpload(async (streamUpload) => {
        assertCurrentRunAction(action);
        try {
          await streamJsonLines<CodingStreamMessage>(
            "/api/coding/run-stream",
            {
              file_id: streamUpload.file_id,
              message_column: messageColumn,
              identifier_columns: identifierColumns,
              identity_column: identityColumn || null,
              order_column: orderColumn || null,
              order_direction: orderDirection,
              experiment_instructions: experimentInstructions,
              empty_message_handling: emptyMessageHandling,
              codebook,
              participants,
              context: contextColumns.map((c) => ({ column: c, description: contextDescriptions[c] || "" })),
              model_slots: modelSlots.map(buildSlotPayload),
              runs_per_model: runsPerModel,
              source_rows: selectedSourceIndices,
              row_indices: indices,
              previous_result_path: previousDetailedPath,
            },
            signal,
            (msg) => {
              assertCurrentRunAction(action);
              if (msg.type === "progress") {
                setRunProgress({ current: msg.current!, total: msg.total!, percent: msg.percent! });
                log("info", `Episode ${msg.current}/${msg.total} (${msg.percent}%)`);
              } else if (msg.type === "row") {
                const row = { index: msg.index!, original: msg.original!, coded: msg.coded! };
                if (indices) {
                  setCodedRows((prev) => prev.map((r) => r.index === row.index ? row : r));
                } else {
                  setCodedRows((prev) => [...prev, row]);
                }
                const issues = checkRow(row.index, row.coded, resultVars);
                for (const issue of issues) {
                  const detail = issue.issueType === "api_error"
                    ? `Episode ${row.index + 1}: ${issue.value}`
                    : `Episode ${row.index + 1}: ${issue.variable} ${issue.issueType === "not_numeric" ? "not numeric" : "out of range"} (got "${String(issue.value)}")`;
                  setRunErrors((prev) => [...prev, detail]);
                  log("warn", detail);
                }
              } else if (msg.type === "error" && isRestorableUploadCode(msg.code)) {
                throw new UploadUnavailableError(msg.message || "The uploaded dataset must be restored.", msg.code);
              } else if (msg.type === "error" && msg.index !== undefined) {
                const message = msg.message ?? "Coding failed";
                setRunErrors((prev) => [...prev, message]);
                log("error", message);
              } else if (msg.type === "error") {
                const message = msg.message ?? "Coding failed";
                setRunError(message);
                log("error", `Fatal: ${message}`);
              } else if (msg.type === "complete") {
                setRunComplete({
                  total_rows: msg.total_rows!,
                  coded_rows: msg.coded_rows!,
                  file_path: msg.file_path!,
                });
                log("info", `Re-coding complete. ${msg.total_rows} episodes processed, ${msg.coded_rows} coded.`);
              }
            },
          );
          assertCurrentRunAction(action);
        } catch (error) {
          if (error instanceof StreamResponseError && isRestorableUploadCode(error.code)) {
            throw new UploadUnavailableError(error.message, error.code);
          }
          throw error;
        }
      }, { initialUpload: activeUpload, recovery: uploadRecovery, signal });
    } catch (e: unknown) {
      if (isAbortError(e) || !isCurrentRunAction(action)) return;
      const message = e instanceof Error ? e.message : "Coding failed";
      log("error", `${stage === "preflight" ? "Dataset check" : "Coding connection"} failed: ${message}`);
      setRunError(message);
    } finally {
      finishRunAction(action);
    }
  };

  // ── Reset ─────────────────────────────────────────────────────────────────

  // Remove the loaded dataset and the mapping that describes it, leaving the
  // codebook, instructions, and model setup alone — the usual reason to clear is
  // swapping in a different file for the same study.
  const handleClearDataset = () => {
    uploadRequestRef.current?.controller.abort();
    uploadRequestRef.current = null;
    uploadPreflightRef.current = null;
    restorePromiseRef.current = null;
    liveUploadIdRef.current = null;
    void clearStoredUpload().catch(() => {});
    invalidateRunArtifacts();
    resetMapping();
    setUploadResult(null); setUploadMeta(null); setUploadAvailability("none");
    setUploading(false); setUploadError(""); setUploadNotice(""); setDragOver(false);
    setContextConflictAlert(null);
    setSenderVerificationSignature("");
    // Row numbers refer to the file that just went away.
    setRowSelectionMode("all");
    setRowSelectionCount(""); setRowSelectionPercent(""); setRowSelectionSpec("");
    setSetupIssues([]);
  };

  const handleReset = () => {
    if (tourOpen) return;
    if (resultDownloadKind) {
      showToast("Wait for the current results download to finish before resetting.");
      return;
    }
    if (codingActionBusyRef.current) {
      showToast(running ? "Stop the coding run before resetting." : "Wait for the current coding action to finish before resetting.");
      return;
    }
    if (!window.confirm("Reset everything and clear all saved fields? This cannot be undone.")) return;
    const filesToClean = { ...serverFilesRef.current };
    cleanupServerFiles(filesToClean.fileId, filesToClean.resultPath);
    try { localStorage.removeItem(PERSIST_KEY); } catch {}
    uploadLifecycleRef.current += 1;
    uploadTokenRef.current += 1;
    uploadRequestRef.current?.controller.abort();
    uploadRequestRef.current = null;
    restorePromiseRef.current = null;
    uploadPreflightRef.current = null;
    restoreStartedRef.current = true;
    liveUploadIdRef.current = null;
    serverFilesRef.current = {};
    void clearStoredUpload().catch(() => {});
    runAbortRef.current?.abort();
    runAbortRef.current = null;
    setUploadResult(null); setUploadMeta(null); setUploadAvailability("none");
    setUploading(false); setUploadError(""); setUploadNotice(""); setDragOver(false);
    setMessageColumn(""); setExperimentInstructions("");
    setIdentifierColumns([]); setIdentityColumn(""); setOrderColumn(""); setOrderDirection("asc");
    setContextColumns([]); setContextDescriptions({}); setRowsAsUnits(false); setEmptyMessageHandling("ignore");
    setContextConflictAlert(null);
    setCodebook([newEntry()]); setSenderVerificationSignature("");
    setModelSlots([{ ...EMPTY_SLOT }]); setRunsPerModel(1);
    setGenerating(false); setGenerateError(""); setResult(null);
    setRunning(false); setRunProgress(null); setCodedRows([]); setRunErrors([]);
    setRunComplete(null); setRunStartedAt(null); setRunFinishedAt(null); setRunError(""); setValidationReport(null);
    setAgreementReport(null); setAgreementLoading(false); setAgreementError("");
    setResultExportConfig(null);
    setResultDownloadKind(null); setResultDownloadError("");
    setConsoleLogs([]); setRightView("script"); setExpandedTable(null);
    setOpenPanels(new Set([1]));
    if (fileRef.current) fileRef.current.value = "";
    showToast("All fields cleared");
  };

  // ── Derived values ────────────────────────────────────────────────────────

  const codebookLabels = resultVars.map((v) => v.key);
  const visibleRows = codedRows.slice(-5);
  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <nav className="topbar">
        <div className="topbar-left">
          <div className="topbar-logos">
            <a
              href="https://nyuad.nyu.edu/"
              target="_blank"
              rel="noopener noreferrer"
              className="topbar-logo-link"
              aria-label="Visit the NYU Abu Dhabi website"
              title="NYU Abu Dhabi"
            >
              <Image src="/nyuad_logo.avif" alt="NYU Abu Dhabi" width={138} height={24} className="topbar-logo topbar-logo-nyuad" priority unoptimized />
            </a>
            <div className="topbar-sep" aria-hidden="true" />
            <a
              href="https://ssel.abudhabi.nyu.edu/"
              target="_blank"
              rel="noopener noreferrer"
              className="topbar-logo-link"
              aria-label="Visit the Social Science Experimental Laboratory website"
              title="Social Science Experimental Laboratory"
            >
              <Image src="/ssel_logo.png" alt="SSELab" width={110} height={24} className="topbar-logo" priority unoptimized />
            </a>
          </div>
          <div className="topbar-sep" />
          <Link href="/coding" className="topbar-title topbar-title-link">
            CAT — Communication Annotation Tool
          </Link>
          <span className="topbar-badge">v1.4</span>
          <div className="topbar-sep" />
          <MenuBar pathname={pathname} />
        </div>
        <div className="topbar-right">
          <button className="btn btn-outline btn-sm topbar-reset-btn" onClick={handleReset}>Reset</button>
          <button className="tour-help-btn" onClick={startTour}>Guided Tour</button>
        </div>
      </nav>

      <div className="layout">
        <main className="main">
          <div className={`tool-page tool-page-fill ${activeTool === "coding" || activeTool === "run" ? "active" : ""}`}>
            {rememberedRun && rememberedRun !== serverRunToken && (
              <div className="resume-run-bar">
                <span>You have a coding run on the server.</span>
                <a className="btn btn-outline btn-xs" href={`/runs/${rememberedRun}`}>Open it</a>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => {
                    try { localStorage.removeItem("cat_last_server_run"); } catch {}
                    setRememberedRun("");
                  }}
                >Dismiss</button>
              </div>
            )}
            {!viewingRunLink && <div className="tool-header tool-header-slim">
              <p className="tool-citation-note">
                <strong>Please cite:</strong> Baranski, A., Cooper, D. J., &amp; Lee, J. K. (2026). Are LLMs reliable coders of communication content in economic experiments? <em>NYUAD Division of Social Science Working Paper</em>, #0115. <a href="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7129638" target="_blank" rel="noopener noreferrer">View paper</a>
              </p>
            </div>}

            <div className={`pipeline-layout split layout-${layoutMode}`} style={{ display: "flex", gap: 0 }}>
              {/* ── Left: Config Column ── */}
              <div
                className="config-col"
                style={{
                  width: viewingRunLink ? 0 : tourOpen && layoutMode !== "hidden" ? "50vw" : layoutMode === "hidden" ? 0 : layoutMode === "side" ? "clamp(340px, 40%, 560px)" : "calc(100% - 56px)",
                  minWidth: 0,
                  borderRight: layoutMode === "hidden" && !tourOpen ? "none" : undefined,
                }}
              >
                <div className="config-scroll">

                  {/* Panel 1: Upload Dataset */}
                  <div id="coding-panel-1" className={`panel ${openPanels.has(1) ? "open" : ""}${skipPanelAnim ? " no-animate" : ""}${panelHasSetupIssue(1) ? " setup-invalid" : ""}`}>
                    <button className="panel-head" onClick={() => togglePanel(1)}>
                      <div className="panel-head-left">
                        <span className="step-badge">1</span>
                        <span className="panel-label">Upload Dataset</span>
                        <HelpTip text="Upload a CSV or Excel file with one message per row. Next, map your columns: tag the message text and choose how rows form episodes (group by shared columns, or code each row on its own)." />
                        {uploadAvailability === "ready" && uploadResult && <span className="tag">uploaded</span>}
                        {uploadAvailability === "restoring" && <span className="tag">restoring…</span>}
                        {uploadAvailability === "reupload-required" && <span className="tag">re-upload required</span>}
                        {panelHasSetupIssue(1) && <span className="setup-error-tag">Needs attention</span>}
                      </div>
                      <svg className="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6l4 4 4-4" /></svg>
                    </button>
                    <div className="panel-content-wrap"><div className="panel-content"><div className="panel-content-inner">
                      <div
                        className={`dropzone${dragOver ? " drag-active" : ""}${datasetLoaded ? " dz-loaded" : ""}${setupIssueByKey("upload") ? " field-invalid" : ""}`}
                        aria-disabled={uploading || uploadAvailability === "restoring"}
                        onClick={() => { if (!datasetLoaded && !uploading && uploadAvailability !== "restoring") fileRef.current?.click(); }}
                        onDrop={(e) => {
                          setDragOver(false);
                          if (!uploading && uploadAvailability !== "restoring") onDrop(e);
                          else e.preventDefault();
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          if (!uploading && uploadAvailability !== "restoring") setDragOver(true);
                        }}
                        onDragLeave={() => setDragOver(false)}
                      >
                        {datasetLoaded ? (
                          <div className="dz-file">
                            <svg className="dz-file-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
                            </svg>
                            <span className="dz-file-info">
                              <span className="dz-file-name">{uploadResult!.file_name}</span>
                              <span className="dz-file-meta">{uploadResult!.row_count} rows · {uploadResult!.columns.length} columns</span>
                            </span>
                            <button
                              type="button"
                              className="dz-file-clear"
                              title="Remove this dataset and choose another"
                              aria-label="Remove dataset"
                              onClick={(e) => { e.stopPropagation(); handleClearDataset(); }}
                            >×</button>
                          </div>
                        ) : (
                          <>
                            <div className="dz-icon">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="28" height="28">
                                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                              </svg>
                            </div>
                            <p className="dz-text">
                              {uploadAvailability === "restoring"
                                ? <><span className="spinner" /> Restoring saved dataset...</>
                                : uploading
                                  ? <><span className="spinner" /> Uploading...</>
                                  : "Drop a CSV or Excel file here, or click to browse"}
                            </p>
                          </>
                        )}
                      </div>
                      <div className="episode-def">
                        <span className="episode-def-term">Communication episode:</span>
                        <span className="episode-def-text"> the unit of analysis — a combination of messages exchanged through the same channel, or a collection of messages sent by one sender. Rows that share your chosen identifier(s) are merged into one episode.</span>
                      </div>
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".csv,.xlsx,.xls"
                        disabled={uploading || uploadAvailability === "restoring"}
                        onClick={(e) => { e.currentTarget.value = ""; }}
                        onChange={onFileChange}
                        className="input-hidden"
                      />
                      {uploadAvailability === "reupload-required" && (
                        <div className="mt-8">
                          <p className="recap-warn">
                            Retry the saved copy, or re-upload {uploadMeta?.name ? <strong>{uploadMeta.name}</strong> : "the original dataset"}. Your column mapping and coding configuration have been kept.
                          </p>
                          {uploadMeta && (
                            <button
                              type="button"
                              className="btn btn-outline btn-xs mt-8"
                              disabled={uploading || !!uploadRequestRef.current || codingActionBusyRef.current}
                              onClick={handleRetrySavedUpload}
                            >
                              Retry saved dataset
                            </button>
                          )}
                        </div>
                      )}
                      {uploadError && <p className="enc-error">{uploadError}</p>}
                      {setupIssueByKey("upload") && <p className="field-error" role="alert">{setupIssueByKey("upload")!.message}</p>}
                      {uploadNotice && <p className="hint">{uploadNotice}</p>}
                      {uploadResult && (
                        <div className="mt-12" id="tour-episode-preview">
                          {/* Rows to code — subset the dataset before mapping/coding */}
                          <div className={`row-select${rowSelectionMode !== "all" && rowSelection.error ? " field-invalid" : ""}`}>
                            <div className="row-select-head">
                              <span className="row-select-title">Rows to code</span>
                              <span className="chip-meta">
                                {rowSelectionMode === "all"
                                  ? `All ${totalSourceRows} rows`
                                  : rowSelection.error
                                    ? "—"
                                    : `${rowSelection.count} of ${totalSourceRows} rows`}
                              </span>
                            </div>
                            <div className="row-select-modes">
                              {([
                                ["all", "All rows"],
                                ["count", "Random count"],
                                ["percent", "Random %"],
                                ["specific", "Specific rows"],
                              ] as [RowSelectionMode, string][]).map(([mode, label]) => (
                                <button
                                  key={mode}
                                  type="button"
                                  className={`btn btn-sm ${rowSelectionMode === mode ? "btn-primary" : "btn-outline"}`}
                                  onClick={() => setRowSelectionMode(mode)}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                            {rowSelectionMode === "count" && (
                              <div className="row-select-input">
                                <label>Code a random{" "}
                                  <input type="number" min={1} max={totalSourceRows} className="row-select-num"
                                    value={rowSelectionCount} onChange={(e) => setRowSelectionCount(e.target.value)} />
                                  {" "}of {totalSourceRows} rows
                                </label>
                                <button type="button" className="btn btn-ghost btn-xs"
                                  onClick={() => setRowSelectionSeed((Math.random() * 2 ** 31) | 0)}>↻ Reshuffle</button>
                              </div>
                            )}
                            {rowSelectionMode === "percent" && (
                              <div className="row-select-input">
                                <label>Code a random{" "}
                                  <input type="number" min={0.1} max={100} step={0.1} className="row-select-num"
                                    value={rowSelectionPercent} onChange={(e) => setRowSelectionPercent(e.target.value)} />
                                  {" "}% of rows
                                </label>
                                <button type="button" className="btn btn-ghost btn-xs"
                                  onClick={() => setRowSelectionSeed((Math.random() * 2 ** 31) | 0)}>↻ Reshuffle</button>
                              </div>
                            )}
                            {rowSelectionMode === "specific" && (
                              <div className="row-select-input">
                                <input type="text" className="row-select-spec" placeholder="e.g. 1-50, 75, 90-100"
                                  value={rowSelectionSpec} onChange={(e) => setRowSelectionSpec(e.target.value)} />
                                <span className="hint">Row numbers as uploaded (1–{totalSourceRows}); use ranges and commas.</span>
                              </div>
                            )}
                            {rowSelectionMode !== "all" && rowSelection.error && (
                              <p className="field-error" role="alert">{rowSelection.error}</p>
                            )}
                            {rowSelectionMode !== "all" && !rowSelection.error && (
                              <p className="hint">
                                Coding {rowSelection.count} of {totalSourceRows} rows{rowSelectionMode !== "specific" ? " (random sample)" : ""}. The other rows stay in the file but are not sent to the model.
                              </p>
                            )}
                          </div>

                          {/* Mapping recap + open the highlighting popup */}
                          <div className={`colmap-recap${setupIssues.some((issue) => issue.key.startsWith("mapping.")) ? " field-invalid" : ""}`}>
                            <div className="colmap-recap-roles">
                              <span className="recap-item"><span className="role-dot" style={{ background: ROLE_META.message.color }} />Message: <b>{messageColumn || "—"}</b></span>
                              <span className="recap-item"><span className="role-dot" style={{ background: ROLE_META.identifier.color }} />Identifier: <b>{rowsAsUnits ? "each row = episode" : (identifierColumns.join(" + ") || "—")}</b></span>
                              <span className="recap-item"><span className="role-dot" style={{ background: ROLE_META.identity.color }} />Sender: <b>{identityColumn || "none"}</b></span>
                              <span className="recap-item"><span className="role-dot" style={{ background: ROLE_META.order.color }} />Order: <b>{orderColumn ? `${orderColumn} (${orderDirection})` : "file order"}</b></span>
                              <span className="recap-item"><span className="role-dot" style={{ background: ROLE_META.context.color }} />Context: <b>{contextColumns.join(" + ") || "none"}</b></span>
                            </div>
                            <div className="colmap-recap-foot">
                              <button className="btn btn-outline btn-sm" onClick={() => setColumnModalOpen(true)}>
                                {messageColumn ? "Edit Column Mapping" : "Map Columns"}
                              </button>
                              {!mappingComplete && <span className="recap-warn">⚠ Mapping incomplete — finish it to continue.</span>}
                              {mappingComplete && currentContextConflicts.length > 0 && (
                                <span className="recap-warn">⚠ Context values conflict within some episodes — edit the mapping to resolve them.</span>
                              )}
                            </div>
                            {setupIssues.filter((issue) => issue.key.startsWith("mapping.")).map((issue) => (
                              <p className="field-error" role="alert" key={issue.key}>{issue.message}</p>
                            ))}
                          </div>

                          {/* Original table */}
                          <div className="ds-table-label">
                            <span className="ds-badge ds-badge-orig">Original</span>
                            <span className="ds-table-cap">As uploaded — {uploadResult.row_count} rows</span>
                          </div>
                          <div className="table-wrap table-mini table-clickable" onClick={() => setExpandedTable("preview")} title="Click to expand">
                            <table className="tbl tbl-compact">
                              <thead><tr>{uploadResult.columns.map((col) => {
                                const role = roleOf(col);
                                return <th key={col} style={role ? { borderTop: `3px solid ${ROLE_META[role].color}` } : undefined}>{col}</th>;
                              })}</tr></thead>
                              <tbody>
                                {uploadResult.preview.slice(0, 5).map((row, i) => (
                                  <tr key={i}>{uploadResult.columns.map((col) => <td key={col} className="mono">{String(row[col] ?? "")}</td>)}</tr>
                                ))}
                              </tbody>
                            </table>
                            {uploadResult.preview.length > 5 && <div className="table-more">Click to see all {uploadResult.preview.length} rows</div>}
                          </div>

                          {isPreprocessed && (
                            <div className="mt-12">
                              <div className="ds-table-label">
                                <span className="ds-badge ds-badge-final">Preprocessed</span>
                                <span className="ds-table-cap">What the models will code — {preprocessedRows.length} merged episode{preprocessedRows.length !== 1 ? "s" : ""}</span>
                                <button className="btn btn-ghost btn-xs ds-dl-btn" onClick={downloadPreprocessed}>↓ Download CSV</button>
                              </div>
                              <div className="table-wrap table-mini">
                                <table className="tbl tbl-compact">
                                  <thead><tr>{uploadResult.columns.map((col) => <th key={col} className={col === messageColumn ? "col-msg" : ""}>{col}</th>)}</tr></thead>
                                  <tbody>
                                    {preprocessedRows.slice(0, 5).map((row, i) => (
                                      <tr key={i}>{uploadResult.columns.map((col) => <td key={col} className="mono ds-pre-cell">{String(row[col] ?? "")}</td>)}</tr>
                                    ))}
                                  </tbody>
                                </table>
                                {preprocessedRows.length > 5 && <div className="table-more">{preprocessedRows.length} episodes total</div>}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div></div></div>
                  </div>

                  {/* Panel 2: Codebook */}
                  <div id="coding-panel-2" className={`panel ${openPanels.has(2) ? "open" : ""}${skipPanelAnim ? " no-animate" : ""}${panelHasSetupIssue(2) ? " setup-invalid" : ""}`}>
                    <button className="panel-head" onClick={() => togglePanel(2)}>
                      <div className="panel-head-left">
                        <span className="step-badge">2</span>
                        <span className="panel-label">Codebook</span>
                        <HelpTip text="Define each variable to code: its label, type, level, aggregation method, category definition, and coded-value definitions with optional examples and context." />
                        {codebook.some((e) => e.label.trim()) && (
                          <span className="tag">{codebook.filter((e) => e.label.trim()).length} var{codebook.filter((e) => e.label.trim()).length !== 1 ? "s" : ""}</span>
                        )}
                        {panelHasSetupIssue(2) && <span className="setup-error-tag">Needs attention</span>}
                      </div>
                      <svg className="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6l4 4 4-4" /></svg>
                    </button>
                    <div className="panel-content-wrap"><div className="panel-content"><div className="panel-content-inner">
                      <div className="f" id="tour-empty-handling">
                        <label>Empty Message Handling</label>
                        <select value={emptyMessageHandling} onChange={(e) => setEmptyMessageHandling(e.target.value as "ignore" | "code")}>
                          <option value="ignore">Ignore (skip model call)</option>
                          <option value="code">Code as Value</option>
                        </select>
                        <p className="hint">
                          {emptyMessageHandling === "ignore" && "Fully empty episodes are not sent to a model. Their original rows remain in the primary CSV with blank code cells."}
                          {emptyMessageHandling === "code" && "Fully empty episodes are sent to the model and coded from the codebook definitions."}
                        </p>
                      </div>
                      <div className="f" id="tour-codebook" style={{ marginTop: 12 }}>
                        <label>Codebook Variables</label>
                        <div className={`cb-summary${panelHasSetupIssue(2) ? " field-invalid" : ""}`} onClick={() => setExpandedTable("codebook")} title="Click to edit the codebook">
                          {codebook.filter((e) => e.label.trim()).length === 0 ? (
                            <p className="hint" style={{ margin: 0 }}>No variables yet — click to define your codebook.</p>
                          ) : (
                            codebook.map((e, i) => e.label.trim() ? (
                              <div className="cb-sum-row" key={i}>
                                <span className="cb-sum-label">{e.label}</span>
                                <span className="cb-sum-meta">{e.type} · {e.level === "sender" ? "per sender" : "per episode"} · {e.type === "text" ? "not aggregated" : e.aggregation === "mean" ? "average" : "majority vote"}</span>
                                <span className="cb-sum-vals">{
                                  e.type === "numeric" ? "number"
                                  : e.type === "text" ? "free text"
                                  : (e.values.filter((v) => v.value.trim()).map((v) => v.value).join(", ") || "—")
                                }</span>
                              </div>
                            ) : null)
                          )}
                          <div className="cb-sum-edit">Click to edit codebook →</div>
                        </div>
                        {setupIssues.filter((issue) => issue.panel === 2).map((issue) => (
                          <p className="field-error" role="alert" key={issue.key}>{issue.message}</p>
                        ))}
                        <p className="hint mt-8">Each variable has its own <strong>aggregation method</strong>, category definition, and coded-value guidance. <strong>Per episode</strong> = one value per episode; <strong>per sender</strong> = one value per verified sender.</p>
                        {duplicateCodeLabels.length > 0 && (
                          <p className="enc-error mt-8" role="alert">
                            Output labels must be unique. Rename the conflicting variable or sender labels: {duplicateCodeLabels.join(", ")}.
                          </p>
                        )}
                        {duplicateAggregateLabels.length > 0 && (
                          <p className="enc-error mt-8" role="alert">
                            Categorical values create duplicate aggregate columns. Rename the conflicting values or variables: {duplicateAggregateLabels.join(", ")}.
                          </p>
                        )}
                        {hasSenderVar && (
                          <div className={`sender-verification ${sendersOk ? "verified" : "needs-attention"}`}>
                            <div className="sender-verification-head">
                              <label>Detected senders <span className="fv">{participants.length}</span></label>
                              {senderListVerified && detectedSenderInfo.blankRows.length === 0 && participants.length > 0 && (
                                <span className="sender-verified-badge">✓ Verified</span>
                              )}
                            </div>
                            {participants.length > 0 && (
                              <div className="sender-tags">{participants.map((sender) => <span className="sender-tag" key={sender}>{sender}</span>)}</div>
                            )}
                            <p className={sendersOk ? "hint" : "enc-error"}>{sendersOk ? "These names were detected automatically from the mapped Sender column." : senderConfigurationMessage}</p>
                            {identityColumn && participants.length > 0 && detectedSenderInfo.blankRows.length === 0 && !senderListVerified && (
                              <button className="btn btn-outline btn-xs" onClick={() => setSenderVerificationSignature(currentSenderSignature)}>I Verified These Senders</button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* ── Codebook export ── */}
                      <div className="cb-export-block" id="tour-codebook-download">
                        <div className="cb-export-divider" />
                        <div className="cb-export-row">
                          <span className="cb-export-title">Download Codebook</span>
                          <div className="cb-export-formats">
                            {(["json", "csv", "txt", "pdf", "xlsx", "latex"] as const).map((fmt) => (
                              <button
                                key={fmt}
                                className={`cb-fmt ${exportFormat === fmt ? "active" : ""}`}
                                onClick={() => setExportFormat(fmt)}
                                title={fmt === "latex" ? "LaTeX table" : `.${fmt}`}
                              >
                                {fmt === "latex" ? "LaTeX" : fmt.toUpperCase()}
                              </button>
                            ))}
                          </div>
                          <button
                            className="btn-export"
                            onClick={() => handleCodebookDownload(exportFormat)}
                            disabled={!codebook.some((e) => e.label.trim())}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                            </svg>
                            Download
                          </button>
                        </div>
                      </div>
                    </div></div></div>
                  </div>

                  {/* Panel 3: Experiment Instructions */}
                  <div id="coding-panel-3" className={`panel ${openPanels.has(3) ? "open" : ""}${skipPanelAnim ? " no-animate" : ""}${panelHasSetupIssue(3) ? " setup-invalid" : ""}`}>
                    <button className="panel-head" onClick={() => togglePanel(3)}>
                      <div className="panel-head-left">
                        <span className="step-badge">3</span>
                        <span className="panel-label">Experiment Instructions</span>
                        <HelpTip text="Give the model full context: the task, roles, decisions, payoffs, and communication rules." />
                        {experimentInstructions.trim() && <span className="tag">set</span>}
                        {panelHasSetupIssue(3) && <span className="setup-error-tag">Needs attention</span>}
                      </div>
                      <svg className="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6l4 4 4-4" /></svg>
                    </button>
                    <div className="panel-content-wrap"><div className="panel-content"><div className="panel-content-inner">
                      <div className="f" id="tour-experiment-instructions">
                        <div className="ta-label-row">
                          <label>Describe the experiment context</label>
                          <button id="tour-pdf-import" className="btn btn-sm btn-pdf-import" type="button" onClick={openPdfModal} title="Convert a PDF of the instructions (including figures and tables) into text">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
                              <path d="M12 18v-6M9.5 14.5 12 12l2.5 2.5" />
                            </svg>
                            Import from PDF
                          </button>
                        </div>
                        <textarea
                          className={`ta-fit${setupIssueByKey("instructions") ? " field-invalid" : ""}`}
                          rows={16}
                          value={experimentInstructions}
                          onChange={(e) => setExperimentInstructions(e.target.value)}
                          placeholder={EXAMPLE_INSTRUCTIONS}
                        />
                        {setupIssueByKey("instructions") && <p className="field-error" role="alert">{setupIssueByKey("instructions")!.message}</p>}
                        <p className="hint">Provide context about what the data represents and the research goals. Have a PDF with figures or tables? Use <strong>Import from PDF</strong> to convert it to text first. <span className="cite-note">The placeholder is a constructed example.</span></p>
                      </div>
                    </div></div></div>
                  </div>

                  {/* Panel 4: Models & Runs */}
                  <div id="coding-panel-4" className={`panel ${openPanels.has(4) ? "open" : ""}${skipPanelAnim ? " no-animate" : ""}${panelHasSetupIssue(4) ? " setup-invalid" : ""}`}>
                    <button className="panel-head" onClick={() => togglePanel(4)}>
                      <div className="panel-head-left">
                        <span className="step-badge">4</span>
                        <span className="panel-label">Models &amp; Runs</span>
                        <HelpTip text="Select providers and models, then choose runs per model. Browser coding requires an API key for every configured model. Package generation does not require a key because the downloaded script requests it at runtime. Aggregation is selected separately for each codebook variable." />
                        <span className="tag">
                          {modelSlots.length} model{modelSlots.length !== 1 ? "s" : ""} × {runsPerModel} run{runsPerModel !== 1 ? "s" : ""}
                        </span>
                        {panelHasSetupIssue(4) && <span className="setup-error-tag">Needs attention</span>}
                      </div>
                      <svg className="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6l4 4 4-4" /></svg>
                    </button>
                    <div className="panel-content-wrap"><div className="panel-content"><div className="panel-content-inner">

                      <div className="model-slots" id="tour-model-slots">
                        {modelSlots.map((slot, idx) => {
                          const provInfo = PROVIDERS.find((p) => p.value === slot.provider);
                          const modelInfo = provInfo?.models.find((m) => m.value === slot.model);
                          const noTemp = modelIgnoresTemperature(slot.provider, slot.model);
                          const noTopP = modelIgnoresTopP(slot.provider, slot.model);
                          const temperatureMax = modelInfo?.temperatureMax ?? 2;

                          return (
                            <div className={`model-slot${setupIssues.some((issue) => issue.modelIndex === idx) ? " field-invalid" : ""}`} key={idx}>
                              <div className="slot-header">
                                <span className="slot-num">{idx + 1}</span>
                                <span className="slot-title">{provInfo?.label ?? slot.provider} — {modelInfo?.label ?? slot.model}</span>
                                <div className="flex-1" />
                                {modelSlots.length > 1 && (
                                  <button className="row-rm" onClick={() => setModelSlots((prev) => prev.filter((_, i) => i !== idx))} title="Remove model">×</button>
                                )}
                              </div>

                              <div className="slot-body">
                                <div className="slot-fields">
                                  <div className={`f${modelFieldIssue(idx, "provider") ? " field-group-invalid" : ""}`}>
                                    <label>Provider</label>
                                    <select
                                      value={slot.provider}
                                      onChange={(e) => {
                                        const np = e.target.value;
                                        const ms = PROVIDERS.find((p) => p.value === np)?.models ?? [];
                                        updateSlot(idx, { provider: np, model: ms[0]?.value ?? "" });
                                      }}
                                    >
                                      {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                                    </select>
                                    {modelFieldIssue(idx, "provider") && <p className="field-error" role="alert">{modelFieldIssue(idx, "provider")!.message}</p>}
                                  </div>
                                  <div className={`f${modelFieldIssue(idx, "model") ? " field-group-invalid" : ""}`}>
                                    <label>Model</label>
                                    <select value={slot.model} onChange={(e) => updateSlot(idx, { model: e.target.value })}>
                                      {(provInfo?.models ?? []).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                                    </select>
                                    {modelFieldIssue(idx, "model") && <p className="field-error" role="alert">{modelFieldIssue(idx, "model")!.message}</p>}
                                  </div>
                                  <div className={`f${modelFieldIssue(idx, "apiKey") ? " field-group-invalid" : ""}`}>
                                    <label>API Key <span className="text-muted">(browser run only)</span></label>
                                    <div className="enc-key-wrap">
                                      <input
                                        type={slot.showKey ? "text" : "password"}
                                        value={slot.apiKey}
                                        onChange={(e) => updateSlot(idx, { apiKey: e.target.value })}
                                        placeholder="sk-..."
                                      />
                                      <button
                                        className="enc-key-toggle"
                                        onClick={() => updateSlot(idx, { showKey: !slot.showKey })}
                                        title={slot.showKey ? "Hide key" : "Show key"}
                                        type="button"
                                      >
                                        {slot.showKey ? (
                                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                                        ) : (
                                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                        )}
                                      </button>
                                    </div>
                                    {modelFieldIssue(idx, "apiKey") && <p className="field-error" role="alert">{modelFieldIssue(idx, "apiKey")!.message}</p>}
                                  </div>
                                </div>

                                <div className="slot-tuning">
                                  {(noTemp || noTopP) && (
                                    <div className="slot-tuning-warn">
                                      {noTemp && noTopP
                                        ? "This model uses provider-controlled sampling — temperature and top-p will not be sent."
                                        : noTemp
                                        ? "This model ignores temperature — the parameter will not be sent."
                                        : "This model ignores top-p — the parameter will not be sent."}
                                    </div>
                                  )}
                                  <div className="tuning-params-grid">
                                    <div className="tuning-param">
                                      <div className="tuning-param-header">
                                        <label className={noTemp ? "text-muted" : ""}>Temperature</label>
                                        <span className={`tuning-param-val${noTemp ? " text-muted" : ""}`}>{noTemp ? "N/A" : (slot.temperature ?? 0.2).toFixed(2)}</span>
                                      </div>
                                      <input type="range" min={0} max={temperatureMax} step={0.05} value={Math.min(slot.temperature ?? 0.2, temperatureMax)} disabled={noTemp}
                                        onChange={(e) => updateSlot(idx, { temperature: parseFloat(e.target.value) })} className={noTemp ? "range-disabled" : ""} />
                                      <div className="tuning-param-bounds"><span>0</span><span>{temperatureMax}</span></div>
                                    </div>
                                    <div className="tuning-param">
                                      <div className="tuning-param-header">
                                        <label className={noTopP ? "text-muted" : ""}>Top-p</label>
                                        <span className={`tuning-param-val${noTopP ? " text-muted" : ""}`}>{noTopP ? "N/A" : (slot.topP ?? 1.0).toFixed(2)}</span>
                                      </div>
                                      <input type="range" min={0} max={1} step={0.05} value={slot.topP ?? 1.0} disabled={noTopP}
                                        onChange={(e) => updateSlot(idx, { topP: parseFloat(e.target.value) })} className={noTopP ? "range-disabled" : ""} />
                                      <div className="tuning-param-bounds"><span>0</span><span>1</span></div>
                                    </div>
                                    <div className="tuning-param">
                                      <div className="tuning-param-header">
                                        <label>Max Tokens</label>
                                        <span className="tuning-param-val">{slot.maxTokens ?? 1024}</span>
                                      </div>
                                      <input type="number" min={64} max={8192} step={64} value={slot.maxTokens ?? 1024}
                                        onChange={(e) => updateSlot(idx, { maxTokens: parseInt(e.target.value, 10) })} className="tuning-tokens-input" />
                                      <div className="tuning-param-bounds"><span>64</span><span>8192</span></div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <button
                        className="btn btn-ghost btn-xs mt-8"
                        onClick={() => setModelSlots((prev) => [...prev, { ...EMPTY_SLOT }])}
                      >
                        + Add Model
                      </button>
                      {setupIssueByKey("models") && <p className="field-error" role="alert">{setupIssueByKey("models")!.message}</p>}

                      <div className="enc-voting-settings" id="tour-runs">
                        <div className="enc-voting-row">
                          <div className="f voting-runs">
                            <label>Runs per Model <span className="fv">{runsPerModel}×</span></label>
                            <input
                              type="range" min={1} max={10} value={runsPerModel}
                              onChange={(e) => setRunsPerModel(Number(e.target.value))}
                            />
                          </div>
                        </div>
                        <div className="enc-voting-summary">
                          <span className="enc-voting-calc">
                            {modelSlots.length} model{modelSlots.length !== 1 ? "s" : ""} × {runsPerModel} run{runsPerModel !== 1 ? "s" : ""} = <strong>{modelSlots.length * runsPerModel}</strong> calls/episode
                          </span>
                          {modelSlots.length * runsPerModel > 1 && <span className="enc-voting-agg">Aggregated per codebook variable</span>}
                        </div>
                      </div>

                      <div className="server-run-opt">
                        <label className="server-run-toggle">
                          <input
                            type="checkbox"
                            checked={runOnServer}
                            onChange={(e) => setRunOnServer(e.target.checked)}
                          />
                          <span className="server-run-copy">
                            <strong>
                              {emailNotifications
                                ? "Run on CAT\u2019s server and email me the link"
                                : "Run on CAT\u2019s server"}
                            </strong>
                            <span className="server-run-hint">
                              Coding keeps going even if your connection drops or you close this tab.
                              You get a page showing the progress and the results
                              {emailNotifications
                                ? ". We email you the link as soon as the run starts, and again when it finishes."
                                : ". Keep the link — email notifications are not available on this server yet."}
                            </span>
                          </span>
                        </label>
                        {runOnServer && emailNotifications && (
                          <>
                            <input
                              type="email"
                              required
                              className={`server-run-email${serverRunError && !resultEmail.trim() ? " field-invalid" : ""}`}
                              placeholder="you@university.edu"
                              value={resultEmail}
                              onChange={(e) => {
                                setResultEmail(e.target.value);
                                if (serverRunError) setServerRunError("");
                              }}
                              aria-label="Email address for the run link"
                            />
                            <p className="server-run-note">
                              Your API key is used for the run and never stored. Results stay on the
                              server for 48 hours and are then deleted. The email contains the link,
                              never the data — and anyone holding that link can download the results.
                            </p>
                          </>
                        )}
                        {runOnServer && !emailNotifications && (
                          <p className="server-run-note">
                            Your API key is used for the run and never stored. Results stay on the
                            server for 48 hours and are then deleted. Anyone holding the run link can
                            download the results, so keep it to yourself.
                          </p>
                        )}
                        {serverRunError && <p className="enc-error">{serverRunError}</p>}
                      </div>
                    </div></div></div>
                  </div>

                </div>

              </div>
              {/* Layout toggle rail — left collapses, right expands */}
              <div className="layout-rail" style={tourOpen ? { display: "none" } : undefined}>
                <div className="layout-rail-btns">
                  {layoutMode !== "hidden" && (
                    <button className="layout-arrow" onClick={collapseLayout} title={layoutMode === "fill" ? "Settings to the side" : "Hide settings"} aria-label="Collapse settings">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 4L6 8l4 4" /></svg>
                    </button>
                  )}
                  {layoutMode !== "fill" && (
                    <button className="layout-arrow" onClick={expandLayout} title={layoutMode === "hidden" ? "Show settings" : "Expand settings"} aria-label="Expand settings">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4l4 4-4 4" /></svg>
                    </button>
                  )}
                </div>
              </div>

              {/* ── Right: Results Column ── */}
              <div className="results-col" id="tour-results-panel" style={{ flex: 1, minWidth: 0 }}>
                {effectiveLayoutMode !== "fill" && (<>
                {!viewingRunLink && (result || codedRows.length > 0 || running || consoleLogs.length > 0) && (
                  <div className="tab-strip tab-strip-gap">
                    <button className={`tab ${rightView === "run" ? "active" : ""}`} onClick={() => setRightView("run")}>
                      Live Coding {running && <span className="enc-pulse" />}
                    </button>
                    <button className={`tab ${rightView === "script" ? "active" : ""}`} onClick={() => setRightView("script")}>
                      Script Preview
                    </button>
                  </div>
                )}

                {/* Run view */}
                {effectiveRightView === "run" && watchedRunToken && !runComplete ? (
                  <div className="tab-pane">{serverRunHeader}</div>
                ) : effectiveRightView === "run" && (running || codedRows.length > 0 || runComplete || consoleLogs.length > 0 || watchedRunToken) ? (
                  <div className="tab-pane">
                    {watchedRunToken && serverRunHeader}
                    {/* The server-run panel above already shows this run's progress. */}
                    {!watchedRunToken && (runProgress || running) && (
                      <div className="enc-progress-wrap">
                        <div className="enc-progress-header">
                          <span className="enc-progress-label">
                            {runComplete ? "Coding complete" : running ? `Coding episode ${runProgress?.current ?? 0} of ${runProgress?.total ?? "?"}...` : "Ready"}
                            {browserRunEta != null && <span className="enc-progress-eta">About {formatDuration(browserRunEta)} remaining</span>}
                          </span>
                          <span className="enc-progress-pct">{runProgress?.percent ?? 0}%</span>
                        </div>
                        <div className="enc-progress-track">
                          <div className={`enc-progress-fill ${runComplete ? "complete" : ""}`} style={{ width: `${runProgress?.percent ?? 0}%` }} />
                        </div>
                      </div>
                    )}

                    {(runProgress || runComplete) && (
                      <div className="stat-row mt-12">
                        <div className="stat"><div className="stat-v">{runProgress?.current ?? 0}</div><div className="stat-l">Processed</div></div>
                        <div className="stat"><div className="stat-v">{runProgress?.total ?? 0}</div><div className="stat-l">Total</div></div>
                        <div className="stat"><div className="stat-v">{runErrors.length}</div><div className="stat-l">Errors</div></div>
                      </div>
                    )}

                    {visibleRows.length > 0 && (
                      <div className="res-section mt-12">
                        <div className="res-section-h">Live Results (last {Math.min(5, codedRows.length)} of {codedRows.length} coded episodes)</div>
                        <div className="enc-live-table-wrap table-clickable" onClick={() => setExpandedTable("live")} title="Click to expand">
                          <table className="tbl tbl-compact">
                            <thead>
                              <tr>
                                <th>#</th><th>{messageColumn || "Message"}</th>
                                {codebookLabels.map((l) => <th key={l} className="enc-coded-col">{l}</th>)}
                              </tr>
                            </thead>
                            <tbody>
                              {visibleRows.map((row) => (
                                <tr key={row.index} className="enc-row-animate">
                                  <td className="mono text-muted">{row.index + 1}</td>
                                  <td className="cell-truncate">{String(row.original[messageColumn] ?? "")}</td>
                                  {codebookLabels.map((label) => (
                                    <td key={label} className="enc-coded-col">
                                      <span className={`pill ${row.coded._error ? "bad" : "lbl"}`}>
                                        {row.coded._error ? "err" : String(row.coded[label] ?? "—")}
                                      </span>
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {runErrors.length > 0 && (
                      <div className="res-section mt-12">
                        <div className="res-section-h text-bad">Errors ({runErrors.length})</div>
                        <div className="enc-errors-body">
                          {runErrors.slice(-5).map((err, i) => <div key={i} className="enc-error-line">{err}</div>)}
                        </div>
                      </div>
                    )}

                    {runError && <p className="enc-error mt-12">{runError}</p>}

                    {runComplete && validationReport && (
                      <div className={`enc-validation-report ${validationReport.problematicIndices.length === 0 ? "valid" : "has-issues"}`}>
                        {validationReport.problematicIndices.length === 0 ? (
                          <div className="enc-validation-header valid">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                            All <strong>{validationReport.totalRows}</strong> coded episodes passed output validation
                          </div>
                        ) : (
                          <>
                            <div className="enc-validation-header issues">
                              <strong>{validationReport.problematicIndices.length}</strong> of {validationReport.totalRows} coded episodes need attention
                            </div>
                            <div className="enc-validation-summary">
                              {validationReport.errorRows > 0 && <span className="pill bad">{validationReport.errorRows} API errors</span>}
                              {validationReport.outOfRangeRows > 0 && <span className="pill mid">{validationReport.outOfRangeRows} out-of-range</span>}
                            </div>
                            <div className="enc-validation-details">
                              {validationReport.issues.slice(0, 10).map((issue, i) => (
                                <div key={i} className="enc-validation-issue">
                                  <span className="enc-vi-row">Episode {issue.rowIndex + 1}</span>
                                  <span className="enc-vi-var">{issue.variable}</span>
                                  {issue.issueType === "api_error" ? (
                                    <span className="enc-vi-type">API error</span>
                                  ) : (
                                    <>
                                      <span className="enc-vi-type">{issue.issueType === "not_numeric" ? "not numeric" : "out of range"}</span>
                                      <span className="enc-vi-detail">got &ldquo;{String(issue.value)}&rdquo;, expected: {issue.expected}</span>
                                    </>
                                  )}
                                </div>
                              ))}
                              {validationReport.issues.length > 10 && <div className="enc-vi-more">...and {validationReport.issues.length - 10} more issues</div>}
                            </div>
                            <div className="enc-validation-actions">
                              <button className="btn btn-outline" disabled={resultDownloadKind !== null || generating} onClick={() => handleRerun(validationReport.problematicIndices)}>Re-run Affected Episodes</button>
                              <button className="btn btn-ghost" disabled={resultDownloadKind !== null || generating} onClick={() => handleRerun(null)}>Re-run All Episodes</button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                    {runComplete && !validationReport && <div className="enc-complete-bar"><div>Validating results...</div></div>}

                    {runComplete && validationReport && (
                      <div className="res-section mt-12 results-download-card" id="tour-result-downloads">
                        <div className="res-section-h">Download Results</div>
                        {validationReport.problematicIndices.length > 0 && (
                          <div className="results-download-warning">
                            These downloads include {validationReport.problematicIndices.length} unresolved coded episode{validationReport.problematicIndices.length === 1 ? "" : "s"}. Re-run the affected episodes first if you want corrected values.
                          </div>
                        )}
                        <div className="results-download-primary">
                          <div>
                            <div className="results-download-title">Complete Results</div>
                            <p className="results-download-helper">
                              {aggregationActive
                                ? "Downloads one ZIP containing overall aggregates, text responses when present, per-LLM aggregates, every original LLM/run result, and coder agreement when a model ran more than once or two or more models were used."
                                : "Downloads the coded dataset with every original row and column, including all coded variable types."}
                            </p>
                          </div>
                          <button
                            className="btn btn-primary"
                            disabled={resultDownloadKind !== null || generating}
                            aria-busy={resultDownloadKind === "results"}
                            onClick={handleExportResults}
                          >
                            {resultDownloadKind === "results"
                              ? <><span className="spinner" /> Preparing</>
                              : aggregationActive ? "Download All Results (.zip)" : "Download Results (.csv)"}
                          </button>
                        </div>
                        {resultDownloadError && <p className="enc-error results-download-error" role="alert">{resultDownloadError}</p>}
                      </div>
                    )}

                    {runComplete && (
                      <div className="res-section mt-12 run-summary-cta">
                        <div>
                          <div className="run-summary-title">Run Summary</div>
                          <div className="run-summary-sub">Dataset, models, configuration, timing, results, and coder agreement when applicable — save as PDF.</div>
                        </div>
                        <button
                          className="btn btn-outline btn-sm"
                          disabled={agreementLoading}
                          onClick={handleRunSummary}
                        >↓ Download Summary (PDF)</button>
                      </div>
                    )}

                    {runComplete && !running && resultExportConfig && (resultExportConfig.models.length >= 2 || resultExportConfig.runsPerModel >= 2) && (
                      <div className="res-section mt-12 agreement-card">
                        <div className="res-section-h">Coder Agreement</div>
                        {agreementLoading && (
                          <div className="agreement-status"><span className="spinner" /> Comparing runs and models...</div>
                        )}
                        {!agreementLoading && agreementError && (
                          <div className="agreement-status agreement-error">
                            <span>{agreementError}</span>
                            <button className="btn btn-outline btn-xs" onClick={() => setAgreementRequestVersion((value) => value + 1)}>Retry</button>
                          </div>
                        )}
                        {!agreementLoading && agreementReport && agreementReport.numeric_variables.length === 0 && (
                          <div className="agreement-status">No non-text aggregate output columns are available for agreement analysis.</div>
                        )}
                        {!agreementLoading && agreementReport && agreementReport.numeric_variables.length > 0 && !agreementReport.within_eligible && !agreementReport.eligible && (
                          <div className="agreement-status">Agreement needs either two or more LLMs, or one LLM run more than once.</div>
                        )}
                        {!agreementLoading && agreementReport && agreementReport.numeric_variables.length > 0 && agreementReport.within_models.length > 0 && (
                          <div className="agreement-group">
                            <div className="agreement-group-h">
                              <span>Within each LLM</span>
                              <span className="agreement-group-sub">how consistently one model repeated itself across its own runs</span>
                            </div>
                            {agreementReport.within_models.map((model) => (
                              <section className="agreement-pair" key={model.model}>
                                <div className="agreement-pair-header">
                                  <span>{model.model}</span>
                                  <span className="agreement-summary-metrics">
                                    {model.run_count} runs
                                    {model.pair_count > 1 && ` · averaged over ${model.pair_count} run pairs`}
                                  </span>
                                </div>
                                <AgreementTable rows={model.variables} />
                              </section>
                            ))}
                          </div>
                        )}
                        {!agreementLoading && agreementReport && agreementReport.numeric_variables.length > 0 && agreementReport.pairs.length > 0 && (
                          <div className="agreement-group">
                            <div className="agreement-group-h">
                              <span>Between LLMs</span>
                              <span className="agreement-group-sub">each model&apos;s runs aggregated first, then the models compared</span>
                            </div>
                            {agreementReport.pairs.map((pair) => (
                              <section className="agreement-pair" key={`${pair.model_a}-${pair.model_b}`}>
                                <div className="agreement-pair-header">
                                  <span>{pair.model_a} vs {pair.model_b}</span>
                                  <span className="agreement-summary-metrics">{pair.variables.length} variable{pair.variables.length === 1 ? "" : "s"}</span>
                                </div>
                                <AgreementTable rows={pair.variables} />
                              </section>
                            ))}
                          </div>
                        )}
                        {!agreementLoading && agreementReport && agreementReport.numeric_variables.length > 0 && (agreementReport.within_models.length > 0 || agreementReport.pairs.length > 0) && (
                          <p className="agreement-note"><strong>Agreement</strong> — exact-match rate. <strong>Cohen&apos;s κ</strong> — agreement corrected for chance. <strong>AC1</strong> — Gwet&apos;s chance-corrected agreement, which stays stable when one category dominates. <strong>N</strong> — episodes scored by both coders.</p>
                        )}
                      </div>
                    )}

                    {consoleLogs.length > 0 && (
                      <div className="enc-console mt-12">
                        <div className="enc-console-header">
                          <span>Console</span>
                          <button className="btn btn-ghost btn-xs" onClick={() => setConsoleLogs([])}>Clear</button>
                        </div>
                        <div className="enc-console-body" ref={consoleRef}>
                          {consoleLogs.map((entry, i) => (
                            <div key={i} className={`enc-console-line ${entry.level}`}>
                              <span className="enc-console-time">{entry.time}</span>
                              <span className={`enc-console-level ${entry.level}`}>{entry.level.toUpperCase()}</span>
                              <span className="enc-console-msg">{entry.msg}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : effectiveRightView === "run" ? (
                  <div className="results-empty">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                    </svg>
                    <p>No results yet</p>
                    <span className="text-sm">Configure the left panel, then press Run Coding</span>
                  </div>
                ) : null}

                {/* Script view */}
                {effectiveRightView === "script" && result ? (
                  <div className="tab-pane">
                    <div className="res-head">
                      <h2>Generated Script</h2>
                      <span className="res-meta">{result.filename}</span>
                    </div>
                    <div className="stat-row">
                      <div className="stat"><div className="stat-v">{uploadResult?.row_count ?? 0}</div><div className="stat-l">Rows</div></div>
                      <div className="stat"><div className="stat-v">{codebookLabels.length}</div><div className="stat-l">Variables</div></div>
                      <div className="stat"><div className="stat-v">{modelSlots.length} × {runsPerModel}</div><div className="stat-l">Models × Runs</div></div>
                    </div>
                    <div className="res-section mb-12">
                      <div className="res-section-h">
                        <span>Script Preview</span>
                        <button className="btn btn-primary btn-xs" disabled={generating || resultDownloadKind !== null} onClick={handleDownloadPackage}>{generating ? "Preparing…" : "Download Package (.zip)"}</button>
                      </div>
                      <div className="script-preview">
                        <pre className="code-block">{result.script}</pre>
                      </div>
                    </div>
                  </div>
                ) : effectiveRightView === "script" && !result ? (
                  <div className="results-empty">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      <path d="M14 2v6h6M10 12l-2 2 2 2M14 12l2 2-2 2" />
                    </svg>
                    <p>No script generated</p>
                    <span className="text-sm">Configure the left panel, then choose Generate Package.</span>
                  </div>
                ) : null}
                </>)}
              </div>
            </div>

            {/* Run bar */}
            {!viewingRunLink && <div id="coding-run-bar" className="run-bar">
              <div className="run-bar-summary">
                {datasetLoaded && (
                  <span className="run-bar-scope">
                    <strong>{uploadResult!.file_name}</strong>
                    <span className="run-bar-dot">·</span>
                    {effectiveRowCount} of {totalSourceRows} rows
                    <span className="run-bar-dot">·</span>
                    {modelSlots.length} model{modelSlots.length !== 1 ? "s" : ""} × {runsPerModel} run{runsPerModel !== 1 ? "s" : ""}
                    <span className="run-bar-dot">·</span>
                    {effectiveRowCount * modelSlots.length * runsPerModel} calls
                  </span>
                )}
              </div>
              {generateError && <span className="enc-error run-bar-error">{generateError}</span>}
              {serverRunError && <span className="enc-error run-bar-error">{serverRunError}</span>}
              {setupIssues.length > 0 && (
                <span className="setup-error-summary" role="alert">
                  Fix {setupIssues.length} setup issue{setupIssues.length === 1 ? "" : "s"} highlighted above.
                </span>
              )}
              <span id="tour-model-execution" className="run-bar-help">
                <HelpTip
                  placement="top"
                  label="What's the difference?"
                  text={<><strong>Run Coding</strong> uses every model and run configured in step 4, and needs an API key for each. <strong>Generate Package</strong> saves no API key and no tuning settings: the downloaded script records only the first selected provider and model, makes one call per episode, and asks for a key when you run it locally.</>}
                />
              </span>
              <button className="btn btn-outline btn-sm" disabled={generating || running || resultDownloadKind !== null} onClick={handleDownloadPackage} title="No API key is required; the local script requests it when run.">
                {generating ? <><span className="spinner" /> Generating</> : "Generate Package"}
              </button>
              {running ? (
                <button className="btn btn-sm btn-stop" onClick={handleStop}>Stop</button>
              ) : (
                <button
                  className="btn btn-run"
                  disabled={generating || resultDownloadKind !== null || startingServerRun}
                  onClick={() => openRunConfirmation(runOnServer ? "server" : "browser")}
                >
                  {startingServerRun ? <><span className="spinner" /> Starting</> : "Run Coding"}
                  {modelSlots.length * runsPerModel > 1 && (
                    <span className="run-calls-hint">({modelSlots.length}×{runsPerModel})</span>
                  )}
                </button>
              )}
            </div>}
          </div>

          {activeTool === "instructions" && <Instructions />}
          {activeTool === "usage" && <UsageStatistics />}
          {activeTool === "acknowledgements" && <Acknowledgements />}

          {activeTool === "documentation" && (
            <div className="tool-page active">
              <div className="tool-header">
                <div>
                  <h1>Documentation</h1>
                  <p className="tool-desc">Research papers describing CAT and the methodology behind LLM-based coding of experimental communication.</p>
                </div>
              </div>
              <div className="tool-body documentation-body">
                <div className="documentation-list">
                  <article className="documentation-paper">
                    <div className="documentation-paper-kicker">Methodology paper · NYUAD Working Paper No. 0115</div>
                    <h2>Are LLMs reliable coders of communication content in economic experiments?</h2>
                    <p className="documentation-authors">Andrzej Baranski, David J. Cooper, and Jeong Kyu Lee</p>
                    <div className="documentation-rule" aria-hidden="true" />
                    <h3>Abstract</h3>
                    <p>
                      Analysis of free-form communication from experiments has largely relied on manual coding by research assistants (RAs), a costly and time-consuming process. We outline an easily implemented method for coding communication data using large language models (LLMs) and propose a novel standard for evaluating the performance of LLM-based coding (“reliability”). Using data from three published articles, we find that LLM-based coding meets our two reliability conditions: (1) differences between LLM-based and RA-based coding are no larger than differences between the RA-based and original coding and (2) the LLM-based coding largely replicates qualitative conclusions from the original papers. That said, there are cases where the LLM-based coding agrees poorly with the RA-based coding or fails to replicate statistical results from the original papers. We demonstrate that these problems can be ameliorated with better prompt design. We conclude that use of LLMs can reduce research costs and time without sacrificing reliability, making content analysis a more accessible tool for experimental economists. However, only with a combination of test coding by RAs and prompt design by researchers can we avoid significant problems with LLM-based coding, highlighting the continued importance of human input.
                    </p>
                    <div className="documentation-citation">
                      <h3>Suggested Citation</h3>
                      <p>
                        <span className="citation-balanced-line">Baranski, A., Cooper, D. J., &amp; Lee, J. K. (2026). Are LLMs reliable coders of communication</span>
                        <span className="citation-balanced-line">content in economic experiments? <em>NYUAD Division of Social Science Working Paper</em>, #0115. <a href="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7129638" target="_blank" rel="noopener noreferrer">Available at SSRN</a>.</span>
                      </p>
                    </div>
                    <div className="documentation-paper-actions">
                      <a className="btn btn-primary btn-sm" href="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7129638" target="_blank" rel="noopener noreferrer">View paper</a>
                    </div>
                  </article>

                  <article className="documentation-paper">
                    <div className="documentation-paper-kicker">CAT Documentation</div>
                    <h2>CAT: An LLM-based Tool for Content Analysis in Experimental Economics</h2>
                    <p className="documentation-authors">Andrzej Baranski, David J. Cooper, and Jeong Kyu Lee</p>
                    <div className="documentation-rule" aria-hidden="true" />
                    <CatDocumentationPaper />
                    <div className="documentation-citation">
                      <h3>Suggested Citation</h3>
                      <p>Baranski, A., Cooper, D. J., &amp; Lee, J. K. (2026). CAT: An LLM-based Tool for Content Analysis in Experimental Economics. <a href="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7370379" target="_blank" rel="noopener noreferrer">Available at SSRN</a>.</p>
                    </div>
                    <div className="documentation-paper-actions">
                      <a className="btn btn-primary btn-sm" href="/documentation/CAT_An_LLM-based_Tool_for_Content_Analysis_in_Experimental_Economics.pdf" download>Download PDF</a>
                    </div>
                  </article>
                </div>
              </div>
            </div>
          )}

          {activeTool === "versions" && (
            <div className="tool-page active">
              <div className="tool-header">
                <div>
                  <h1>Version History</h1>
                  <p className="tool-desc">A record of CAT releases and the user-facing changes introduced in each version.</p>
                </div>
              </div>
              <div className="tool-body release-history-body">
                <section className="release-history" aria-labelledby="release-history-title">
                  <div className="release-history-head">
                    <div>
                      <div className="documentation-paper-kicker">Product updates</div>
                      <h2 id="release-history-title">CAT Releases</h2>
                      <p>Features, fixes, and workflow improvements by release.</p>
                    </div>
                    <span className="release-current-badge">Current · v1.4</span>
                  </div>

                  <div className="release-timeline">
                    <article className="release-entry current">
                      <div className="release-marker" aria-hidden="true" />
                      <div className="release-entry-body">
                        <div className="release-entry-title">
                          <h3>CAT v1.4</h3>
                          <time dateTime="2026-10-01">October 1, 2026</time>
                        </div>
                        <p className="release-summary">Coding runs that survive a dropped connection.</p>
                        <ul>
                          <li>A run can now be carried out on <strong>CAT&apos;s server</strong> instead of inside your browser&apos;s connection, so losing the network or closing the tab no longer destroys the work. Tick the option in Step 4 before pressing Run Coding.</li>
                          <li>Such a run gets <strong>its own link</strong> showing live progress, how long it has been running, and an estimate of the time remaining based on the rate the run is actually achieving. The results can be downloaded from the same page.</li>
                          <li>Give an email address and CAT <strong>sends you that link</strong> when the run finishes. The message contains the link, never the data. Results and the link remain available for 48 hours, then the results are deleted from the server.</li>
                          <li>Your API key is used for the run and is still never stored. Running in the browser is unchanged for anyone who does not opt in.</li>
                        </ul>
                      </div>
                    </article>

                    <article className="release-entry">
                      <div className="release-marker" aria-hidden="true" />
                      <div className="release-entry-body">
                        <div className="release-entry-title">
                          <h3>CAT v1.3</h3>
                          <time dateTime="2026-09-30">September 30, 2026</time>
                        </div>
                        <p className="release-summary">Coder agreement statistics, public usage figures, and a clearer coding workspace.</p>
                        <ul>
                          <li>Brought back <strong>agreement statistics</strong> in the results panel: exact agreement, Cohen&apos;s κ, Gwet&apos;s AC1, and N — reported both <strong>within each LLM</strong> (comparing its repeated runs against each other, so a single model run more than once now yields a reliability check) and <strong>between LLMs</strong>. They appear below the downloads, in the run summary PDF, and in the exported agreement CSV.</li>
                          <li>Reorganised navigation into a <strong>menu bar</strong>, and added two public pages: <strong>Usage Statistics</strong>, with live figures and a world map of where CAT is used, and <strong>Acknowledgements</strong>, crediting the researchers whose feedback shaped the tool.</li>
                          <li>Added the latest models from every provider, including OpenAI GPT-6, Gemini 3.8 Flash, Claude Fable 5.1, and Grok 4.7. Existing choices are unchanged, so saved setups keep working.</li>
                          <li>Reworked the coding workspace: a slimmer top bar, a run bar pinned across the bottom that shows what is about to run and explains how <strong>Run Coding</strong> and <strong>Generate Package</strong> differ, an upload box that shows the loaded dataset with a button to swap it out, and a more visible <strong>Import from PDF</strong> button.</li>
                          <li>Coding runs and package downloads are now counted on the server, so the laboratory can see real usage even when a visitor declines optional analytics.</li>
                        </ul>
                      </div>
                    </article>

                    <article className="release-entry">
                      <div className="release-marker" aria-hidden="true" />
                      <div className="release-entry-body">
                        <div className="release-entry-title">
                          <h3>CAT v1.2</h3>
                          <time dateTime="2026-09-17">September 17, 2026</time>
                        </div>
                        <p className="release-summary">Code a subset of your dataset, with more reliable uploads and runs.</p>
                        <ul>
                          <li>Added a <strong>Rows to code</strong> control in Step 1: code all rows, a random count, a random percentage, or specific rows and ranges (for example <code>1-50, 75, 90-100</code>) — no need to prepare a separate file for a quick test run. The selected rows flow through the preview, coding, reruns, and generated packages.</li>
                          <li>Made dataset uploads and coding runs more reliable on networks with strict security filtering, with a clearer message (and a reference ID to share with IT) when a request is blocked before it reaches CAT.</li>
                          <li>Added this in-app <strong>Versions</strong> tab and a version badge so the running release is always visible.</li>
                        </ul>
                      </div>
                    </article>

                    <article className="release-entry">
                      <div className="release-marker" aria-hidden="true" />
                      <div className="release-entry-body">
                        <div className="release-entry-title">
                          <h3>CAT v1.1</h3>
                          <time dateTime="2026-09-11">September 11, 2026</time>
                        </div>
                        <p className="release-summary">Clearer setup validation and a more stable coding workspace.</p>
                        <ul>
                          <li>Kept <strong>Run Coding</strong> and <strong>Generate Package</strong> available before setup is complete.</li>
                          <li>Added submit-time validation with red field borders and specific, actionable messages for every missing or conflicting setting.</li>
                          <li>Made validation action-aware: browser runs require an API key for every model, while generated packages do not.</li>
                          <li>Made validation errors clear one section at a time when that section is edited, without hiding unresolved errors elsewhere.</li>
                          <li>Applied the same inline validation behavior to the column-mapping and codebook dialogs.</li>
                          <li>Automatically removed completely untouched codebook variables when the codebook is saved.</li>
                          <li>Locked the coding workspace to one viewport so the action bar stays visible while settings and results scroll independently.</li>
                        </ul>
                      </div>
                    </article>

                    <article className="release-entry">
                      <div className="release-marker" aria-hidden="true" />
                      <div className="release-entry-body">
                        <div className="release-entry-title">
                          <h3>CAT v1.0</h3>
                          <span>Initial release</span>
                        </div>
                        <p className="release-summary">The first paper-aligned public release of the Communication Annotation Tool.</p>
                        <ul>
                          <li>Introduced CSV and Excel upload, column mapping, episode construction, and preprocessing previews.</li>
                          <li>Added binary, categorical, numeric, and free-text codebook variables at the episode or sender level.</li>
                          <li>Supported browser coding with multiple providers, models, repeated calls, and per-variable aggregation.</li>
                          <li>Added standalone coding-package generation, live progress, output validation, selective reruns, and complete result exports.</li>
                          <li>Included experiment-instruction entry and PDF-to-text import, guided onboarding, privacy controls, and research documentation.</li>
                        </ul>
                      </div>
                    </article>
                  </div>
                </section>
              </div>
            </div>
          )}

          {activeTool === "contact" && (
            <div className="tool-page active">
              <div className="tool-header">
                <div>
                  <h1>Contact Us</h1>
                  <p className="tool-desc">Have a question, found a bug, or want to give feedback? Send us a message and we&apos;ll get back to you.</p>
                </div>
              </div>
              <div className="tool-body">
                <div className="ana-section mt-16">
                  <div className="ana-section-h">Questions or Concerns?</div>
                  <div className="faq-contact"><ContactForm /></div>
                </div>
              </div>
            </div>
          )}

          {activeTool === "privacy" && (
            <PrivacyNotice
              onChangeAnalyticsChoice={() => {
                try { localStorage.removeItem("cat_analytics_consent"); } catch {}
                setShowWelcome(false);
                setAnalyticsConsent("undecided");
                navigateToTool("coding");
              }}
            />
          )}
        </main>
      </div>

      {/* Import-from-PDF popup: pick a vision-capable model → convert → review → use */}
      {pdfModalOpen && (
        <div className="colmap-overlay" onClick={closePdfModal}>
          <div className="pdf-modal" onClick={(e) => e.stopPropagation()}>
            <div className="colmap-head">
              <div>
                <h2 className="colmap-title">Import Instructions from PDF</h2>
                <p className="colmap-sub">Only some models can read PDFs (including figures and tables). Pick one below to convert the document into text — you can review and edit it before using it. Your main coding run can still use any model you like.</p>
              </div>
              <button className="modal-close" onClick={closePdfModal} title="Close" disabled={pdfConverting}>✕</button>
            </div>

            <div className="pdf-modal-body">
              <div className="f">
                <label>PDF File</label>
                <div
                  className={`dropzone pdf-dropzone${pdfDragOver ? " drag-active" : ""}${pdfValidationAttempted && !pdfFile ? " field-invalid" : ""}`}
                  onClick={() => pdfFileRef.current?.click()}
                  onDrop={(e) => {
                    e.preventDefault(); setPdfDragOver(false);
                    choosePdfFile(e.dataTransfer.files?.[0] ?? null);
                  }}
                  onDragOver={(e) => { e.preventDefault(); setPdfDragOver(true); }}
                  onDragLeave={() => setPdfDragOver(false)}
                >
                  <div className="dz-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="28" height="28">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /><path d="M8 15h8M12 11v8" />
                    </svg>
                  </div>
                  <p className="dz-text">{pdfFile ? pdfFile.name : "Drop a PDF file here, or click to browse"}</p>
                  {pdfFile && <span className="chip-meta">{(pdfFile.size / 1024 / 1024).toFixed(2)} MB</span>}
                </div>
                {pdfValidationAttempted && !pdfFile && <p className="field-error" role="alert">Choose a PDF file.</p>}
                <input
                  ref={pdfFileRef}
                  className="input-hidden"
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => choosePdfFile(e.target.files?.[0] ?? null)}
                />
              </div>

              <div className="slot-fields">
                <div className="f">
                  <label>Provider</label>
                  <select
                    value={pdfProvider}
                    onChange={(e) => {
                      const np = e.target.value;
                      const ms = PDF_MODELS.find((p) => p.provider === np)?.models ?? [];
                      setPdfProvider(np); setPdfModel(ms[0]?.value ?? "");
                    }}
                  >
                    {PDF_MODELS.map((p) => <option key={p.provider} value={p.provider}>{p.label}</option>)}
                  </select>
                </div>
                <div className="f">
                  <label>Model</label>
                  <select value={pdfModel} onChange={(e) => setPdfModel(e.target.value)}>
                    {(PDF_MODELS.find((p) => p.provider === pdfProvider)?.models ?? []).map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div className={`f${pdfValidationAttempted && !pdfApiKey.trim() ? " field-group-invalid" : ""}`}>
                  <label>API Key</label>
                  <div className="enc-key-wrap">
                    <input
                      type={pdfShowKey ? "text" : "password"}
                      value={pdfApiKey}
                      onChange={(e) => setPdfApiKey(e.target.value)}
                      placeholder="sk-..."
                    />
                    <button className="enc-key-toggle" type="button" onClick={() => setPdfShowKey((v) => !v)} title={pdfShowKey ? "Hide key" : "Show key"}>
                      {pdfShowKey ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      )}
                    </button>
                  </div>
                  {pdfValidationAttempted && !pdfApiKey.trim() && <p className="field-error" role="alert">Enter an API key for the selected model.</p>}
                </div>
              </div>

              {pdfError && <div className="pdf-modal-error">{pdfError}</div>}

              {pdfResultText != null && (
                <div className="f">
                  <label>Converted text — review and edit before using</label>
                  <textarea
                    className="ta-fit"
                    rows={12}
                    value={pdfResultText}
                    onChange={(e) => setPdfResultText(e.target.value)}
                  />
                  <p className="hint">Figures and images are described inline as <code>[FIGURE: …]</code>. Edit anything the model got wrong.</p>
                </div>
              )}
            </div>

            <div className="pdf-modal-actions">
              <button className="btn btn-ghost btn-sm" onClick={closePdfModal} disabled={pdfConverting}>Cancel</button>
              <div className="flex-1" />
              <button className="btn btn-outline btn-sm" onClick={convertPdf} disabled={pdfConverting}>
                {pdfConverting ? "Converting…" : pdfResultText != null ? "Re-convert" : "Convert"}
              </button>
              {pdfResultText != null && (
                <button className="btn btn-primary btn-sm" onClick={applyPdfText} disabled={pdfConverting}>Use This Text</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Column-mapping popup: square role tabs → verify → proceed */}
      {columnModalOpen && uploadResult && (() => {
        const assignedFor = (role: ColRole): string[] =>
          role === "message" ? (messageColumn ? [messageColumn] : [])
          : role === "identifier" ? identifierColumns
          : role === "identity" ? (identityColumn ? [identityColumn] : [])
          : role === "order" ? (orderColumn ? [orderColumn] : [])
          : contextColumns;
        const popupMappingIssues = mapValidationAttempted ? [
          ...(!messageColumn ? [{ role: "message" as ColRole, message: "Tag the column that contains the message text." }] : []),
          ...(!rowsAsUnits && identifierColumns.length === 0 ? [{ role: "identifier" as ColRole, message: "Tag at least one episode identifier, or choose “Each row is its own episode.”" }] : []),
          ...(currentContextConflicts.length > 0 ? [{ role: "context" as ColRole, message: "Resolve the context fields with conflicting values." }] : []),
        ] : [];
        return (
          <div className="colmap-overlay">
            <div className="colmap-modal" id="tour-map-modal">
              <div className="colmap-head">
                <div>
                  <h2 className="colmap-title">Map Your Columns</h2>
                  <p className="colmap-sub">Work through the steps — click a column below to tag it for the active step. Steps marked <span className="colmap-req">*</span> are required.</p>
                </div>
                <button className="modal-close" onClick={closeColumnModal} title="Close without saving">✕</button>
              </div>

              {/* Numbered step checklist (replaces the old role tabs) */}
              <div className="colmap-steps" id="tour-map-roles">
                {ROLE_ORDER.map((role, i) => {
                  const meta = ROLE_META[role];
                  const required = role === "message" || role === "identifier";
                  const assigned = role === "identifier" && rowsAsUnits ? ["each row = episode"] : assignedFor(role);
                  const done = assigned.length > 0;
                  const active = activeRole === role;
                  return (
                    <button key={role} id={`tour-role-${role}`} className={`colmap-step ${active ? "active" : ""} ${done ? "done" : ""}${popupMappingIssues.some((issue) => issue.role === role) ? " field-invalid" : ""}`}
                      style={active ? { borderColor: meta.color, background: meta.bg } : undefined}
                      onClick={() => setActiveRole(role)}>
                      <span className="colmap-step-num"
                        style={done ? { background: meta.color, borderColor: meta.color, color: "#fff" }
                          : active ? { borderColor: meta.color, color: meta.color } : undefined}>
                        {done ? "✓" : i + 1}
                      </span>
                      <span className="colmap-step-body">
                        <span className="colmap-step-eyebrow">Step {i + 1}</span>
                        <span className="colmap-step-name">{meta.label}{required ? <span className="colmap-req"> *</span> : <span className="colmap-step-opt"> · optional</span>}</span>
                        <span className="colmap-step-val">{done ? assigned.join(", ") : required ? "not set — click here" : "none"}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Prominent instruction for the active step */}
              <div className="colmap-guide" style={{ borderColor: ROLE_META[activeRole].color, background: ROLE_META[activeRole].bg }}>
                <span className="colmap-guide-num" style={{ background: ROLE_META[activeRole].color }}>{ROLE_ORDER.indexOf(activeRole) + 1}</span>
                <span className="colmap-guide-txt">
                  {activeRole === "identifier"
                    ? (rowsAsUnits
                        ? "Each row is coded as its own episode — no identifier columns needed."
                        : "First choose how episodes are formed, then click the identifier column(s) in the table below.")
                    : ROLE_META[activeRole].hint}
                </span>
              </div>

              {activeRole === "identifier" && (
                <div className="episode-choice">
                  <button className={`episode-opt ${!rowsAsUnits ? "sel" : ""}`} onClick={() => setRowsAsUnits(false)}>
                    <span className="episode-opt-radio" />
                    <span className="episode-opt-body">
                      <span className="episode-opt-title">Group rows into one episode</span>
                      <span className="episode-opt-desc">Rows that share the column(s) you tag below are merged into a single episode — e.g. all messages in the same session + round.</span>
                    </span>
                  </button>
                  <button className={`episode-opt ${rowsAsUnits ? "sel" : ""}`} onClick={() => { setRowsAsUnits(true); setIdentifierColumns([]); }}>
                    <span className="episode-opt-radio" />
                    <span className="episode-opt-body">
                      <span className="episode-opt-title">Each row is its own episode</span>
                      <span className="episode-opt-desc">Every message row is coded on its own — no grouping, no identifier columns needed.</span>
                    </span>
                  </button>
                </div>
              )}
              {activeRole === "order" && orderColumn && (
                <div className="colmap-order-dir">
                  <span>Order messages by <b>{orderColumn}</b>:</span>
                  <div className="seg">
                    <button className={orderDirection === "asc" ? "on" : ""} onClick={() => setOrderDirection("asc")}>Ascending</button>
                    <button className={orderDirection === "desc" ? "on" : ""} onClick={() => setOrderDirection("desc")}>Descending</button>
                  </div>
                  <span className="colmap-order-tie">Tied values always retain their uploaded row order.</span>
                </div>
              )}

              {/* Clickable preview = highlight columns */}
              <div className="colmap-table-wrap" id="tour-map-table">
                <table className="colmap-table">
                  <thead><tr>
                    <th className="colmap-rownum">#</th>
                    {uploadResult.columns.map((col) => {
                      const role = roleOf(col);
                      const meta = role ? ROLE_META[role] : null;
                      return (
                        <th key={col} className={`colmap-col ${role ? "assigned" : ""}`}
                          style={meta ? { borderTopColor: meta.color, background: meta.bg } : undefined}
                          onClick={() => clickColumn(col)} title={`Click to tag as ${ROLE_META[activeRole].label}`}>
                          <span className="colmap-col-name">{col}</span>
                          {meta && <span className="colmap-col-badge" style={{ background: meta.color }}>{meta.short}</span>}
                        </th>
                      );
                    })}
                  </tr></thead>
                  <tbody>
                    {uploadResult.preview.slice(0, 8).map((row, i) => (
                      <tr key={i}>
                        <td className="colmap-rownum">{i + 1}</td>
                        {uploadResult.columns.map((col) => {
                          const role = roleOf(col);
                          const meta = role ? ROLE_META[role] : null;
                          return (
                            <td key={col} className={`colmap-cell ${role ? "assigned" : ""}`}
                              style={meta ? { background: meta.bg } : undefined} onClick={() => clickColumn(col)}>
                              {String(row[col] ?? "")}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {uploadResult.preview.length > 8 && <div className="colmap-more">Showing 8 of {uploadResult.preview.length} rows</div>}
              </div>

              {/* Context column descriptions */}
              {contextColumns.length > 0 && (
                <div className="colmap-context">
                  <div className="colmap-context-head">Context for the model — describe what each tagged column&apos;s values mean</div>
                  {contextColumns.map((col) => (
                    <div className="f colmap-context-row" key={col}>
                      <label><span className="role-dot" style={{ background: ROLE_META.context.color }} /> {col}</label>
                      <textarea
                        rows={2}
                        value={contextDescriptions[col] ?? ""}
                        onChange={(e) => setContextDescriptions((prev) => ({ ...prev, [col]: e.target.value }))}
                        placeholder={`e.g. ${col} is the chat channel — p-v1 = private chat between P and V1, public = all players, …`}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Sender-name verification (for per-sender variables) */}
              {hasSenderVar && (
                <div className={`colmap-verify-result ${sendersOk ? "ok" : "warn"}`} style={{ margin: 0 }}>
                  {!identityColumn ? (
                    <p><b>⚠ Sender column needed.</b> Tag the column that identifies who sent each message.</p>
                  ) : detectedSenderInfo.blankRows.length > 0 ? (
                    <p><b>⚠ Blank sender values.</b> Correct source row{detectedSenderInfo.blankRows.length === 1 ? "" : "s"} <b>{detectedSenderInfo.blankRows.slice(0, 5).join(", ")}{detectedSenderInfo.blankRows.length > 5 ? "…" : ""}</b> and re-upload the dataset.</p>
                  ) : participants.length === 0 ? (
                    <p><b>⚠ No senders detected.</b> Choose a Sender column containing at least one nonblank value.</p>
                  ) : sendersOk ? (
                    <p><b>✓ Sender list verified.</b> CAT will code each sender detected in <b>{identityColumn}</b>: {participants.join(", ")}.</p>
                  ) : (
                    <p><b>⚠ Verification required.</b> Review and verify the detected sender list in the Codebook.</p>
                  )}
                </div>
              )}

              {/* Save & proceed */}
              <div className="colmap-foot" id="tour-map-proceed">
                <div className="colmap-foot-status">
                  {popupMappingIssues.length > 0
                    ? popupMappingIssues.map((issue) => <p className="field-error" role="alert" key={issue.role}>{issue.message}</p>)
                    : <span className={`hint ${colMapError ? "text-bad" : ""}`} style={{ margin: 0 }}>
                        {mappingComplete && currentContextConflicts.length === 0
                          ? "Mapping complete."
                          : colMapError || "Complete the required mapping steps."}
                      </span>}
                </div>
                <button className="btn btn-primary" onClick={saveAndProceed}>Save &amp; Proceed</button>
              </div>
            </div>
          </div>
        );
      })()}

      {contextConflictAlert && (
        <div className="modal-overlay open context-conflict-overlay" role="dialog" aria-modal="true" aria-labelledby="context-conflict-title">
          <div className="modal context-conflict-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2 id="context-conflict-title">Context values differ within some episodes</h2>
                <p>Each selected Context field must have exactly one value in every episode.</p>
              </div>
            </div>
            <div className="modal-body context-conflict-body">
              {contextConflictAlert.map((conflict) => (
                <div className="context-conflict-item" key={conflict.column}>
                  <strong>{conflict.column}</strong>
                  <span>{conflict.conflictingEpisodeCount} episode{conflict.conflictingEpisodeCount === 1 ? "" : "s"} contain multiple values.</span>
                  <span>Example: {conflict.exampleEpisode} contains <b>{conflict.exampleValues.join(" and ")}</b>.</span>
                </div>
              ))}
              <p>Correct the dataset and re-upload it, or remove the inconsistent field from Context. CAT will check again before allowing you to proceed.</p>
            </div>
            <div className="modal-actions context-conflict-actions">
              <button className="btn btn-ghost" onClick={() => setContextConflictAlert(null)}>Return to Mapping</button>
              <button className="btn btn-outline" onClick={unselectConflictingContext}>Unselect Inconsistent Fields</button>
              <button className="btn btn-primary" onClick={replaceDatasetForContext}>Correct and Re-upload Dataset</button>
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen table modal */}
      {expandedTable && (
        <div className="modal-overlay" onClick={closeExpanded}>
          <div className="modal modal-table" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="fw-600">
                {expandedTable === "preview" && `Dataset (${uploadResult?.preview.length ?? 0} rows)`}
                {expandedTable === "codebook" && "Codebook"}
                {expandedTable === "live" && `Coded Results (${codedRows.length} episodes)`}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={closeExpanded}>✕</button>
            </div>
            <div className="modal-body">
              {expandedTable === "preview" && uploadResult && (
                <table className="tbl">
                  <thead><tr><th className="th-row-num">#</th>{uploadResult.columns.map((col) => <th key={col} className={col === messageColumn ? "col-msg" : ""}>{col}</th>)}</tr></thead>
                  <tbody>
                    {uploadResult.preview.map((row, i) => (
                      <tr key={i}><td className="mono text-muted">{i + 1}</td>{uploadResult.columns.map((col) => <td key={col}>{String(row[col] ?? "")}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              )}
              {expandedTable === "codebook" && (
                <div className="cb-editor" id="tour-cb-editor">
                  {codebook.map((entry, idx) => (
                    <div className={`cb-card${codebookEntryIssues(idx).length > 0 ? " field-invalid" : ""}`} id={idx === 0 ? "tour-cb-card" : undefined} key={idx}>
                      <div className="cb-card-top">
                        <input className={`cb-card-label${codebookEditorIssueByKey(`codebook.${idx}.label`) ? " field-invalid" : ""}`} aria-invalid={Boolean(codebookEditorIssueByKey(`codebook.${idx}.label`))} type="text" value={entry.label} onChange={(e) => updateCodebook(idx, "label", e.target.value)} placeholder="Variable label — e.g. promise" />
                        <div className="cb-type-wrap" id={idx === 0 ? "tour-cb-type" : undefined}>
                          <select className={codebookEditorIssueByKey(`codebook.${idx}.type`) ? "field-invalid" : ""} aria-invalid={Boolean(codebookEditorIssueByKey(`codebook.${idx}.type`))} value={entry.type} onChange={(e) => changeType(idx, e.target.value)}>
                            {CODEBOOK_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                          </select>
                          <HelpTip text={TYPE_HELP} />
                        </div>
                        <select value={entry.level} onChange={(e) => updateCodebook(idx, "level", e.target.value)}>
                          <option value="episode">Per episode</option>
                          <option value="sender">Per sender</option>
                        </select>
                        <button className="row-rm" onClick={() => removeCodebookRow(idx)} title="Remove variable" disabled={codebook.length <= 1}>×</button>
                      </div>
                      {codebookEntryIssues(idx).map((issue) => (
                        <p className="field-error" role="alert" key={issue.key}>{issue.message}</p>
                      ))}

                      <div className="cb-field">
                        <label>Category Definition</label>
                        <textarea rows={2} value={entry.definition} onChange={(e) => updateCodebook(idx, "definition", e.target.value)} placeholder="What this variable measures and how to decide it" />
                      </div>

                      <div className="cb-aggregation" id={idx === 0 ? "tour-cb-aggregation" : undefined}>
                        <div>
                          <label>Aggregate Repeated Calls</label>
                          <p>How results from multiple models or runs are combined. A tied numeric mode uses the median (the average of the two middle values when the count is even).</p>
                        </div>
                        {entry.type === "text" ? (
                          <span className="text-muted text-sm">Text cannot be aggregated. CAT excludes it from the main aggregate file and exports every model/run response in a separate text-results CSV.</span>
                        ) : (
                          <div className="cb-aggregation-control">
                            <select value={entry.aggregation} onChange={(e) => updateCodebook(idx, "aggregation", e.target.value)}>
                              <option value="mode">Majority vote (mode)</option>
                              <option value="mean">Average (mean)</option>
                            </select>
                            {entry.type === "categorical" && (
                              <p className="cb-aggregation-note">For aggregation, each permitted value becomes a separate binary column, and CAT applies the selected rule to each column.</p>
                            )}
                          </div>
                        )}
                      </div>

                      {!TYPE_HAS_VALUES(entry.type) ? (
                        <div className="cb-values" id={idx === 0 ? "tour-cb-values" : undefined}>
                          <p className="hint" style={{ margin: 0 }}>
                            {entry.type === "numeric"
                              ? "Numeric — the model returns a number. No fixed values to define."
                              : "Text — the model returns free-form text. No fixed values to define."}
                          </p>
                        </div>
                      ) : (
                        <div className="cb-values" id={idx === 0 ? "tour-cb-values" : undefined}>
                          <div className="cb-values-h">Coded Values <span className="cb-opt">
                            {entry.type === "binary" ? "fixed 0 / 1 — just define what each means" : "one definition per value"}
                          </span></div>
                          <div className="cb-value-grid cb-value-head">
                            <span>Value</span>
                            <span>Definition</span>
                            <span>Examples <em>(optional)</em></span>
                            <span>Additional context <em>(optional)</em></span>
                            <span />
                          </div>
                          {entry.values.map((v, vIdx) => (
                            <div className="cb-value-grid" key={vIdx}>
                              <input className="cb-value-key" type="text" value={v.value} readOnly={entry.type === "binary"} onChange={(e) => updateValue(idx, vIdx, "value", e.target.value)} placeholder="e.g. P" />
                              <textarea className="cb-val-ta" rows={1} value={v.definition} onChange={(e) => updateValue(idx, vIdx, "definition", e.target.value)} placeholder="What this value means" />
                              <textarea className="cb-val-ta" rows={1} value={v.examples} onChange={(e) => updateValue(idx, vIdx, "examples", e.target.value)} placeholder="examples" />
                              <textarea className="cb-val-ta" rows={1} value={v.context} onChange={(e) => updateValue(idx, vIdx, "context", e.target.value)} placeholder="context" />
                              {entry.type === "binary"
                                ? <span />
                                : <button className="row-rm" onClick={() => removeValueRow(idx, vIdx)} title="Remove value" disabled={entry.values.length <= 1}>×</button>}
                            </div>
                          ))}
                          {entry.type !== "binary" && <button className="btn btn-ghost btn-xs" onClick={() => addValueRow(idx)}>+ Add Value</button>}
                        </div>
                      )}
                    </div>
                  ))}
                  <button className="btn btn-outline btn-sm" onClick={addCodebookRow}>+ Add Variable</button>
                  {hasSenderVar && (
                    <div className={`sender-verification mt-12 ${sendersOk ? "verified" : "needs-attention"}`}>
                      <div className="sender-verification-head">
                        <label>Detected senders <span className="fv">{participants.length}</span></label>
                        {senderListVerified && detectedSenderInfo.blankRows.length === 0 && participants.length > 0 && (
                          <span className="sender-verified-badge">✓ Verified</span>
                        )}
                      </div>
                      {participants.length > 0 && (
                        <div className="sender-tags">{participants.map((sender) => <span className="sender-tag" key={sender}>{sender}</span>)}</div>
                      )}
                      <p className={sendersOk ? "hint" : "enc-error"}>{sendersOk ? "Per-sender variables will be coded once for each verified sender." : senderConfigurationMessage}</p>
                      {identityColumn && participants.length > 0 && detectedSenderInfo.blankRows.length === 0 && !senderListVerified && (
                        <button className="btn btn-outline btn-sm" onClick={() => setSenderVerificationSignature(currentSenderSignature)}>I Verified These Senders</button>
                      )}
                    </div>
                  )}
                  {duplicateCodeLabels.length > 0 && (
                    <p className="enc-error mt-12" role="alert">
                      Output labels must be unique. Rename the conflicting variable or sender labels: {duplicateCodeLabels.join(", ")}.
                    </p>
                  )}
                  {duplicateAggregateLabels.length > 0 && (
                    <p className="enc-error mt-8" role="alert">
                      Categorical values create duplicate aggregate columns. Rename the conflicting values or variables: {duplicateAggregateLabels.join(", ")}.
                    </p>
                  )}
                  {visibleCodebookIssues.filter((issue) => issue.key === "codebook.empty").map((issue) => (
                    <p className="field-error" role="alert" key={issue.key}>{issue.message}</p>
                  ))}
                  <div className="cb-editor-foot">
                    <button className="btn btn-ghost" onClick={closeCodebookEditor}>Cancel</button>
                    <button className="btn btn-primary" onClick={saveCodebookEditor}>Save</button>
                  </div>
                </div>
              )}
              {expandedTable === "live" && codedRows.length > 0 && (
                <table className="tbl">
                  <thead><tr><th className="th-row-num">#</th><th className="col-msg">{messageColumn || "Message"}</th>{codebookLabels.map((l) => <th key={l}>{l}</th>)}</tr></thead>
                  <tbody>
                    {codedRows.map((row) => (
                      <tr key={row.index}>
                        <td className="mono text-muted">{row.index + 1}</td>
                        <td>{String(row.original[messageColumn] ?? "")}</td>
                        {codebookLabels.map((label) => (
                          <td key={label} className="tc">
                            <span className={`pill ${row.coded._error ? "bad" : "lbl"}`}>
                              {row.coded._error ? "err" : String(row.coded[label] ?? "—")}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      <div className={`toast ${toast ? "show" : ""}`}>{toast}</div>

      {pendingRun && (
        <div className="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="run-estimate-title">
          <div className="modal run-estimate-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 id="run-estimate-title">Start this coding run?</h2>
            </div>
            <div className="modal-body run-estimate-body">
              {estimateLoading && <p className="job-status"><span className="spinner" /> Working out what this run involves...</p>}

              {!estimateLoading && estimateError && (
                <p className="enc-error">Could not estimate this run ({estimateError}). You can still start it.</p>
              )}

              {!estimateLoading && estimate && (
                <>
                  <div className="run-estimate-figures">
                    <div className="run-estimate-figure">
                      <span className="run-estimate-value">{formatDuration(estimate.seconds)}</span>
                      <span className="run-estimate-label">estimated time</span>
                    </div>
                    <div className="run-estimate-figure">
                      <span className="run-estimate-value">
                        {estimate.cost_usd === null ? "—" : formatUsd(estimate.cost_usd)}
                      </span>
                      <span className="run-estimate-label">estimated cost</span>
                    </div>
                    <div className="run-estimate-figure">
                      <span className="run-estimate-value">{estimate.calls.toLocaleString("en-US")}</span>
                      <span className="run-estimate-label">model calls</span>
                    </div>
                  </div>

                  <p className="run-estimate-breakdown">
                    {estimate.episodes.toLocaleString("en-US")} episode{estimate.episodes === 1 ? "" : "s"}
                    {" × "}{estimate.models} model{estimate.models === 1 ? "" : "s"}
                    {" × "}{estimate.runs_per_model} run{estimate.runs_per_model === 1 ? "" : "s"}
                    {" = "}<strong>{estimate.calls.toLocaleString("en-US")}</strong> calls
                    {" · "}{estimate.input_tokens.toLocaleString("en-US")} tokens in
                    {" / "}{estimate.output_tokens.toLocaleString("en-US")} out
                  </p>

                  {estimate.cost_by_model.length > 1 && (
                    <ul className="run-estimate-models">
                      {estimate.cost_by_model.map((row) => (
                        <li key={row.model}>
                          <span className="run-estimate-model-name">{row.model}</span>
                          <span className="run-estimate-model-cost">{formatUsd(row.cost_usd)}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <p className="run-estimate-rate-note">
                    {estimate.cost_usd === null
                      ? "CAT has no published rate on file for the model you selected, so it cannot estimate the cost."
                      : `Priced at published list rates as of ${formatPriceDate(estimate.prices_updated)}. Check your provider's current pricing.`}
                    {estimate.unpriced_models.length > 0 && estimate.cost_usd !== null && (
                      <> The total excludes {estimate.unpriced_models.join(", ")}, which CAT has no rate for.</>
                    )}
                  </p>

                  <p className="run-estimate-caveat">
                    These are rough estimates. Token counts are approximate, and the time
                    {estimate.timing_from_history
                      ? " comes from how long previous runs on this server actually took."
                      : " uses a default, as this server has no completed runs to measure yet."}
                    {" "}Retries and provider rate limits can make a run take longer.
                  </p>
                </>
              )}
            </div>
            <div className="modal-actions run-estimate-actions">
              <button className="btn btn-ghost" onClick={() => setPendingRun(null)}>Cancel</button>
              <button className="btn btn-run" disabled={estimateLoading} onClick={confirmPendingRun}>
                {pendingRun === "server" ? "Run on the server" : "Run"}
              </button>
            </div>
          </div>
        </div>
      )}

      {analyticsConsent === "undecided" && (
        <div className="privacy-consent" role="dialog" aria-modal="true" aria-labelledby="privacy-consent-title">
          <div className="privacy-consent-dialog">
            <div className="privacy-consent-copy">
              <span className="privacy-consent-kicker">Privacy choices</span>
              <h2 id="privacy-consent-title">Allow optional analytics?</h2>
              <p>
                If you accept, CAT records your public IP address, approximate IP-derived location,
                a browser identifier, browser metadata, and basic configuration counts. CAT never
                records API keys or dataset contents. If you reject, CAT records only one anonymous
                visit count—without your IP address, location, or browser identifier. Either way, the
                server keeps an operational record of each coding run and package download (time,
                model names, task counts, and outcome) with none of those identifiers.
              </p>
              <a href="/privacy" target="_blank" rel="noopener noreferrer">Read the full privacy notice</a>
            </div>
            <div className="privacy-consent-actions">
              <button className="btn btn-outline" onClick={() => chooseAnalytics("rejected")}>Do not allow</button>
              <button className="btn btn-primary" onClick={() => chooseAnalytics("accepted")}>Allow</button>
            </div>
          </div>
        </div>
      )}

      <GuidedTour
        open={tourOpen}
        steps={CODING_TOUR_STEPS}
        onClose={endTour}
        onStepEnter={handleStepEnter}
      />

      {showWelcome && (
        <div className="welcome-overlay" onClick={() => dismissWelcome("later")}>
          <div className="welcome-modal" onClick={(e) => e.stopPropagation()}>
            <div className="welcome-emoji">👋</div>
            <h2 className="welcome-title">First Time Here?</h2>
            <p className="welcome-text">
              Take a quick guided walkthrough of the LLM Coding page — we&apos;ll highlight each step, from uploading your data to running the models.
            </p>
            <div className="welcome-actions">
              <button className="btn btn-primary" onClick={() => dismissWelcome("tour")}>Take the Tour</button>
              <button className="btn btn-outline" onClick={() => dismissWelcome("later")}>Maybe Later</button>
            </div>
            <button className="welcome-link" onClick={() => dismissWelcome("guide")}>Or View Demo Video →</button>
            <button className="welcome-never" onClick={() => dismissWelcome("never")}>Don&apos;t Show Again</button>
          </div>
        </div>
      )}
    </>
  );
}
