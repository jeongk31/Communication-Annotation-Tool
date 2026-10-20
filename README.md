# CAT — Communication Annotation Tool

CAT is a web application developed by the Social Science Experimental Laboratory at
NYU Abu Dhabi for coding free-form communication with large language models (LLMs).
It is designed primarily for communication data from economic experiments, although
the workflow can support other structured content-analysis tasks.

The current release is **CAT v1.4.11**. The site shows the major.minor version (v1.4);
the full patch-level log is in `backend/app/releases.py` and on the admin dashboard's
Version history.

## Version history

### CAT v1.4

- **Server-side runs.** A coding run can finish on CAT's server instead of inside the
  browser's connection, so a dropped network or closed tab no longer loses the work. The
  run gets its own link, protected by an access key, showing live progress and the full
  results view; the link and its results expire after 48 hours. CAT can email the link
  when the run starts and when it finishes.
- **Estimate before running.** Run Coding first shows the expected time, number of model
  calls, token use, and an approximate cost priced from the providers' published rates.
- **Models code in parallel.** With several models, each episode is sent to every model
  at the same time, so a run takes about as long as its slowest model. Repeated runs of
  one model stay sequential, and each repeat sweeps the whole dataset before the next
  begins, so repeated measurements of one episode are not taken back-to-back.
- **Accurate usage counts.** Runs and coded episodes are counted on the server, including
  server-side runs, and "episodes coded" counts every coding (episodes × models × runs).
- An Acknowledgements page, and a simpler public Usage Statistics page (visits and
  countries).

### CAT v1.3

- **Agreement statistics** in the results, run-summary PDF, and exported CSV: exact
  agreement, Cohen's kappa, Gwet's AC1, and N, both within each model (across its
  repeated runs) and between models.
- A compact menu bar, public usage statistics with a world map, and an admin dashboard
  with run outcomes, sessions, errors, and version history.

### CAT v1.2

- A **Rows to code** control in Step 1: code all rows, a random count, a random
  percentage, or specific rows and ranges (for example `1-50, 75, 90-100`) without
  preparing a separate smaller file. The selection carries through preprocessing,
  coding, reruns, and generated packages.
- Reliable uploads and coding runs on networks with strict security filtering: request
  bodies are encoded so a gateway firewall does not mistake research text for an
  attack, with a clear message (and a reference ID for IT) if a request is still blocked.

### CAT v1.1

- Full documentation of the CAT paper, citations, a privacy notice, and inter-coder
  agreement.
- Submit-time validation with specific, field-level messages for every missing or
  conflicting setting.

### CAT v1.0

- Paper-aligned initial release: dataset upload, column mapping, episode construction,
  codebook design, browser and standalone-package coding, validation, reruns, and
  complete result exports.

Researchers can upload a dataset, define communication episodes, create a coding
manual, provide experimental context, run one or more LLMs, review validation results,
and download coded data without writing application code.

## Coding workflow

The guided tour uses a small, constructed dataset; it does not contain participant
data.

1. Upload a CSV or Excel (`.csv`, `.xlsx`, or `.xls`) source dataset.
2. Map source columns to CAT's `Message`, `Episode Identifier`, `Sender`, `Order`,
   and `Context` roles. CAT groups source rows into communication episodes while
   retaining the link between every episode and its original rows.
3. Review and, if needed, download the preprocessed episode-level data.
4. Create binary, categorical, numeric, or free-text coding variables. Variables can
   be coded once per episode or separately for each detected sender and can include
   definitions, permitted values, examples, and study-specific context.
5. Enter experimental instructions directly or convert a PDF into editable text with
   a supported document-capable model.
6. Configure models from OpenAI, Google Gemini, DeepSeek, Anthropic Claude, or xAI
   Grok, including model parameters and the number of calls.
7. Review the estimate of time, calls, tokens, and approximate cost, then run the task
   in the browser, leave it to finish on CAT's server, or generate a standalone
   local-execution package that does not contain an API key. Runs can use multiple
   models and repeated calls, with aggregation selected separately for each coding
   variable.
8. Monitor progress, inspect validation issues, selectively rerun affected episodes,
   review agreement within and between models, and use one button to download the
   complete results.

With one model call, the download is a CSV that preserves the order and columns of the
uploaded source data and appends every coding variable. If several source rows form one
communication episode, CAT assigns the episode-level codes to each of those rows.

With repeated calls or multiple models, the download is one ZIP archive. It contains
up to two overall CSV files: a source-row file with the final non-text aggregates and,
when the codebook contains text variables, a separate call-level file containing every
text response. Each LLM also has up to two corresponding CSV files containing its own
non-text aggregates and text responses. Finally, the archive contains one unchanged
call-level CSV for every individual run of every LLM. Categorical values are represented
in aggregate files as separate binary columns (for example, `option_a`, `option_b`, and
`option_c`), while their original labels remain unchanged in the individual-run files.
CAT reports two kinds of agreement for every non-text output column. **Within a model**,
the repeated runs of one model are compared with each other, a check on how consistently
it answers; with more than two runs, the pairwise results are averaged (the mean of
pairwise Cohen's kappa is Light's kappa). **Between models**, each model's runs are first
aggregated to one value per episode and the models are then compared pairwise. Each
comparison reports the exact agreement rate, unweighted Cohen's kappa, Gwet's AC1, and the
number of paired episodes. The tables appear in the Results panel and run-summary report,
and the ZIP contains the same statistics in `inter_coder_agreement.csv`. Each distinct
numeric result is treated as a nominal coded value, statistics use episodes for which both
coders have a value, and kappa is undefined when expected agreement is 100%. CAT reports
each variable separately and does not average coefficients across variables.
When a numeric mode has no unique winner, CAT uses the median; with an even number of
responses, this is the average of the two middle values.

```text
dataset_coded_results.zip
├── inter_coder_agreement.csv      # repeated runs or 2+ models, non-text outputs
├── overall/
│   ├── aggregated_results.csv     # present when non-text variables exist
│   └── text_results.csv           # present when text variables exist
└── models/
    └── provider_model/
        ├── aggregated_results.csv # present when non-text variables exist
        ├── text_results.csv       # present when text variables exist
        └── runs/
            ├── run1.csv
            └── run2.csv
```

## Technology

| Layer | Technology |
|---|---|
| Frontend | Next.js App Router, React, TypeScript |
| Backend | Python 3.12, FastAPI, SQLAlchemy |
| Database | PostgreSQL through the asynchronous `asyncpg` driver |
| Data processing | pandas and openpyxl |
| Model integrations | OpenAI-compatible APIs, Google Gemini, and Anthropic |
| Styling | Project-specific CSS |

The public production service runs on a university-hosted Red Hat Enterprise Linux
server behind Nginx and HTTPS. The frontend and backend run as systemd-managed services,
and PostgreSQL provides the persistent metadata store. A systemd timer deploys the latest
commit on `main` once its CI checks have passed (see `deploy/`). Hostnames, credentials, internal
paths, and administrative details are intentionally excluded from public documentation.

## Repository structure

```text
LLM_TOOL/
├── requirements.txt               # Root Python dependency entry point
├── backend/
│   ├── requirements.in            # Direct Python dependencies
│   ├── requirements.txt           # Fully pinned Python dependency lock
│   ├── app/
│   │   ├── main.py                # FastAPI application and registered routes
│   │   ├── config.py              # Environment-based application settings
│   │   ├── releases.py            # Release history; the single source of the version
│   │   ├── jobs.py                # Server-side coding runs and their access-key links
│   │   ├── usage.py               # Server-side counting of runs and downloads
│   │   ├── estimate.py, prices.py # Pre-run time, call, token, and cost estimate
│   │   ├── gzip_request.py        # Decodes encoded request bodies (firewall mitigation)
│   │   ├── admin_template.py      # Admin dashboard page
│   │   ├── models/database.py     # Database models
│   │   ├── routes/                # Coding, instructions, analytics, and contact APIs
│   │   └── services/              # LLM execution, aggregation, agreement, and results
│   └── tests/                     # Backend test suite
├── frontend/
│   ├── src/app/                   # Next.js interface and workflow components
│   ├── public/                    # Logos, tour graphics, and demonstration video
│   ├── package.json
│   └── package-lock.json
├── deploy/                        # Production auto-deploy script and systemd units
├── CLAUDE.md                      # Conventions for contributors and AI coding agents
└── .github/workflows/ci.yml       # Automated backend and frontend checks
```

## Requirements

- Python 3.12
- Node.js 22
- PostgreSQL (production runs PostgreSQL 18)
- An API key for each LLM provider used during browser-based coding

API keys are entered for individual runs. CAT does not write them to its database,
browser storage, generated packages, or application logs.

## Local installation

From the repository root, create an isolated Python environment and install the
backend dependencies:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Install the frontend dependencies in a separate step:

```bash
cd frontend
npm ci
cd ..
```

## Running locally

CAT requires PostgreSQL and does not silently fall back to SQLite. Set a valid
connection string before starting the backend:

```bash
export DATABASE_URL=postgresql://<user>:<password>@localhost:5432/<database>
cd backend
python -m uvicorn app.main:app --reload --port 8000
```

In another terminal, start the frontend:

```bash
cd frontend
npm run dev
```

The local interface is available at `http://localhost:3000`. By default, the frontend
forwards API requests to `http://localhost:8000`. Set `NEXT_PUBLIC_API_URL` before
starting the frontend if the backend uses a different address.

The database tables are created automatically when the backend starts with a valid
PostgreSQL connection.

Server-side runs use two optional groups of environment settings (see
`backend/app/config.py`): `PUBLIC_BASE_URL`, the public site address used to build run
links in email, and the `SMTP_*` settings. Without `SMTP_HOST`, CAT sends no email;
server-side runs still work and their link and access key are shown on screen.

## Tests and verification

Run the backend tests from the repository root:

```bash
cd backend
python -m unittest discover -s tests -v
```

Check the frontend:

```bash
cd frontend
npm run lint
npm run build
```

The GitHub Actions workflow also compiles the backend, runs its tests, checks required
application routes, audits production frontend dependencies, and builds the frontend.

To update Python dependencies deliberately, edit `backend/requirements.in`, regenerate
the lock with `python -m pip install pip-tools==7.6.1` followed by
`pip-compile --generate-hashes --strip-extras --output-file=backend/requirements.txt backend/requirements.in`,
and run the complete test suite before committing the result.

## Data handling

- API keys are kept in memory only for the requested operation.
- The selected LLM provider receives the experimental instructions, constructed
  communication episodes, coding manual, and selected context required for coding.
- CAT uses temporary server-side working files for uploaded datasets and results.
  Resetting the project or replacing a dataset requests cleanup, and scheduled cleanup
  removes temporary working files after the 24-hour threshold. Results of a server-side
  run are kept for the 48 hours its link is valid, then removed.
- A server-side run is opened with its link and an access key; only a hash of the key is
  stored. Its API key is held in memory while the run is going and never written to
  disk, so a server restart ends the run rather than resuming it. An email, when
  requested, carries the link and key, never the results.
- The browser stores the current project configuration and a local copy of the uploaded
  dataset so work can be restored after a refresh. Resetting the project clears this
  browser copy.
- CAT asks for consent before collecting optional usage analytics. Acceptance enables
  the disclosed browser, IP-derived location, and configuration metadata. Rejection
  records only one anonymous visit count without a location or browser identifier.
- The server records each coding run and package download for usage statistics: the
  models, settings, counts, outcome, and duration. These server records carry no IP
  address, location, session identifier, or browser identifier.
- CAT stores this metadata, consented analytics, server-side run status (counters and
  model names), error logs, and contact-form submissions in PostgreSQL. It does not store
  dataset contents or API keys in that database.

See the complete [privacy notice](PRIVACY.md).

Researchers are responsible for determining whether sending their data to the selected
LLM provider complies with participant consent, institutional requirements, data-use
agreements, and applicable law or policy. Sensitive datasets should be de-identified or
processed only through an institutionally approved provider.

## Research use

CAT implements a coding procedure; it does not establish construct validity or ground
truth. Researchers should validate a coding task against an appropriate human-coded
sample, retain the coding manual and configuration, inspect individual and aggregate
outputs, and report the models and settings used.

LLM outputs may vary between calls and may change when providers update their models.
Repeated calls and agreement across models can describe stability, but they do not by
themselves establish that a classification is correct.

## Citation

If CAT is used in research, please cite the accompanying paper, *CAT: An LLM-based Tool
for Content Analysis in Experimental Economics*, by Andrzej Baranski, David J. Cooper,
and Jeong Kyu Lee. The DOI will be added when one is assigned.

## Contributing

Do not commit directly to `main`. Create a branch from the latest `main`, make one
focused change, and open a pull request describing what changed and how it was tested.
Before opening the pull request, run the backend tests and the frontend audit, lint, and
production build commands shown above. Every merge to `main` deploys, so each pull request
adds a new entry at the top of `RELEASES` in `backend/app/releases.py` and updates the
version in `backend/tests/test_version.py` and `frontend/package.json`; see `CLAUDE.md`. Pull requests can be merged only after the
required Backend and Frontend CI checks pass and all review conversations are resolved.

Do not include API keys, participant data, server credentials, local environment files,
or generated build artifacts in a branch or pull request. Report suspected security
problems privately using the procedure in [SECURITY.md](SECURITY.md), rather than in a
public issue.

## Policies

- [Security reporting](SECURITY.md)
- [Privacy](PRIVACY.md)
