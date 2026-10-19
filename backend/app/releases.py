"""Deploy/release history — the single source of truth for the app version.

Each deploy to production adds one entry to the TOP of RELEASES with the next
patch number and the date it shipped. The website shows the major.minor (e.g.
"1.2"); the admin Version History shows the full patch-level log below.

``__version__`` (in app/__init__.py) is derived from RELEASES[0], so bumping the
version is just prepending a new entry here.

Dates for entries up to 1.2.4 were reconstructed from the git merge history on
`main` (each merge to main is one deploy). Times are the release date (UAE).
"""

RELEASES = [
    {
        "version": "1.4.9",
        "date": "2026-10-19",
        "title": "Simpler public usage figures",
        "notes": "The public Usage Statistics page now shows just total visits and the number of countries, above the map. The coding-run and episode counts remain on the admin dashboard.",
    },
    {
        "version": "1.4.8",
        "date": "2026-10-19",
        "title": "Tanya Rosenblat added to the acknowledgements",
        "notes": "The Acknowledgements page now thanks Tanya Rosenblat (School of Information and Department of Economics, University of Michigan) for her feedback on CAT.",
    },
    {
        "version": "1.4.7",
        "date": "2026-10-13",
        "title": "The run estimate prices itself",
        "notes": "The estimate shown before a run now works out an approximate cost from the published list rates for the models selected, so there is no rate to type in. It names the date those rates were checked, breaks the cost down per model when a run mixes them, and says plainly when a model has no rate on file rather than quoting it as free. The dialog itself is laid out properly, with Cancel and Run in the footer.",
    },
    {
        "version": "1.4.6",
        "date": "2026-10-13",
        "title": "See what a run will take before starting it",
        "notes": "Run Coding now shows an estimate first — how long the run should take, how many model calls it will make, and roughly how many tokens it will use — with Run and Cancel. Enter the rate your provider charges and it shows an approximate cost. The timing is measured from this server's own completed runs once there are some.",
    },
    {
        "version": "1.4.5",
        "date": "2026-10-07",
        "title": "A run link shows the full results view",
        "notes": "Opening a server-side run's link now shows the same results view as the app — live results, validation, coder agreement, downloads and the run summary — instead of progress and a download button. The browser run also shows an estimate of the time remaining, which only the server-side run had.",
    },
    {
        "version": "1.4.4",
        "date": "2026-10-05",
        "title": "Repeated runs sweep the whole dataset each time",
        "notes": "With more than one run per model, CAT now codes every episode once, then starts again from the first — rather than coding one episode repeatedly before moving on. Repeated measurements of the same episode are no longer taken back-to-back, and the progress bar counts every pass, so five episodes over three runs reads as fifteen.",
    },
    {
        "version": "1.4.3",
        "date": "2026-10-05",
        "title": "Server-side runs show the full results view",
        "notes": "Starting a run on the server now opens the results column, and once it finishes the usual results view appears — live results, validation, coder agreement, downloads and the run summary — rather than progress alone. A run that cannot start also reports why in the run bar instead of failing silently.",
    },
    {
        "version": "1.4.2",
        "date": "2026-10-05",
        "title": "Server-side runs are protected by an access key",
        "notes": "Opening a server-side run now needs both its link and an access key emailed alongside it. The key is entered on the page and never appears in the web address, so a link on its own no longer exposes anyone's results. Only a hash of the key is stored.",
    },
    {
        "version": "1.4.1",
        "date": "2026-10-05",
        "title": "Email at the start of a run as well as the end",
        "notes": "A server-side run now emails its link as soon as it starts, not only when it finishes, so the way back to the run exists before anything can go wrong with the connection. Asking to be emailed now requires an address.",
    },
    {
        "version": "1.4.0",
        "date": "2026-10-01",
        "title": "Runs that survive a dropped connection",
        "notes": (
            "A coding run can now be carried out on CAT's server instead of inside the "
            "browser's connection, so losing the network no longer destroys the work. Such a "
            "run gets its own link showing live progress, a time estimate from its own "
            "measured rate, and the results to download; the link lasts 48 hours and is "
            "emailed when the run finishes if an address was given. Opt-in: the browser path "
            "is unchanged. API keys are still never stored, and the email carries the link "
            "rather than the results."
        ),
    },
    {
        "version": "1.3.1",
        "date": "2026-09-30",
        "title": "Clearer usage map",
        "notes": "Every country that has used CAT is now filled with a single purple on both the public and admin maps, instead of being shaded by volume, so quieter countries are as visible as busy ones.",
    },
    {
        "version": "1.3.0",
        "date": "2026-09-30",
        "title": "Coder agreement, usage statistics, and a clearer workspace",
        "notes": (
            "Agreement statistics are back in the results: exact agreement, Cohen's kappa, "
            "Gwet's AC1 and N, both within each LLM (across its repeated runs) and between "
            "LLMs, shown below the downloads and included in the run summary PDF and the "
            "exported agreement CSV. Navigation moved to a compact menu bar with new public "
            "Usage Statistics (live figures and a world map) and Acknowledgements pages. "
            "Added the latest models from every provider. The workspace gained a slimmer top "
            "bar, a pinned run bar showing what is about to run, an upload box that shows the "
            "loaded dataset, and a more visible Import from PDF button."
        ),
    },
    {
        "version": "1.2.12",
        "date": "2026-09-30",
        "title": "Count coding runs and downloads on the server",
        "notes": "Coding runs, their outcomes, and script-package downloads are now recorded by the backend, so the admin no longer undercounts runs when a visitor declines browser analytics or closes the tab.",
    },
    {
        "version": "1.2.11",
        "date": "2026-09-30",
        "title": "Fix coding runs freezing the server",
        "notes": "The request-decoding middleware answered receive() instantly, which made streaming coding runs busy-loop and hang the whole backend. It now defers to the real receive.",
    },
    {
        "version": "1.2.10",
        "date": "2026-09-30",
        "title": "Persistent error log; remove live server-log view",
        "notes": "Removed the live server-log tail. Backend exceptions are now persisted and shown in the admin Errors view alongside coding-run errors.",
    },
    {
        "version": "1.2.9",
        "date": "2026-09-30",
        "title": "Hotfix: backend stability",
        "notes": "Admin stats now compute off the event loop (bounded), and the log buffer no longer floods SQL logs. Fixes backend timeouts / admin 504s.",
    },
    {
        "version": "1.2.8",
        "date": "2026-09-30",
        "title": "Admin errors view + live server logs",
        "notes": "Capture run error messages, add an Errors view, a live backend-log tail, and admin auto-refresh.",
    },
    {
        "version": "1.2.7",
        "date": "2026-09-29",
        "title": "Firewall: base64-safe request encoding",
        "notes": "Send request bodies as gzip+base64 so large gzipped uploads no longer trip the firewall by coincidence.",
    },
    {
        "version": "1.2.6",
        "date": "2026-09-29",
        "title": "Contributor and AI-agent notes",
        "notes": "Added CLAUDE.md documenting the release, deploy, and firewall-encoding conventions.",
    },
    {
        "version": "1.2.5",
        "date": "2026-09-29",
        "title": "Admin version history",
        "notes": "Added this deploy history to the admin dashboard.",
    },
    {
        "version": "1.2.4",
        "date": "2026-09-29",
        "title": "Reliable uploads/coding on filtered networks",
        "notes": "Encoded all coding requests so none are rejected by the upstream firewall.",
    },
    {
        "version": "1.2.3",
        "date": "2026-09-29",
        "title": "Admin dashboard redesign",
        "notes": "Run outcomes, a sessions view, clearer metrics, and a light/dark interface.",
    },
    {
        "version": "1.2.2",
        "date": "2026-09-29",
        "title": "Broader upload/coding reliability",
        "notes": "Added a universal fallback so the firewall mitigation covers every browser.",
    },
    {
        "version": "1.2.1",
        "date": "2026-09-18",
        "title": "Layout and logo fixes",
        "notes": "Fixed blank space around the coding actions and the NYU logo display.",
    },
    {
        "version": "1.2.0",
        "date": "2026-09-17",
        "title": "Row subset, validation feedback, reliable uploads",
        "notes": "Step 1 row subsetting, submit-time setup validation, and firewall-resilient uploads/runs.",
    },
    {
        "version": "1.1.0",
        "date": "2026-09-01",
        "title": "Research documentation and agreement analysis",
        "notes": "Full CAT paper documentation, citations, privacy notice, and inter-coder agreement.",
    },
    {
        "version": "1.0.0",
        "date": "2026-08-21",
        "title": "Initial public release",
        "notes": "Paper-aligned release: upload, mapping, codebook, browser and package coding, exports.",
    },
]

# The current running version is always the newest release entry.
CURRENT_VERSION = RELEASES[0]["version"]
