---
"cognia-next": minor
---

Rebuild the Logs settings page as a master/detail pane, and stop it from showing settings that were not in effect.

Settings → Observability → Logs was two link cards stacked above a 2 300-line component whose five tabs (`Levels / Transports / PostHog / Advanced / Retention`) appeared with no visual relationship to anything around them — a tab strip floating inside a page that already had a sidebar, with `Advanced` acting as the drawer for everything the other four had no home for. It is now the same shell the Gateway, External Bridge and Memory sections use: a grouped nav rail beside one panel, deep-linkable via `?logsPanel=`, with the rail moving into a sheet on narrow screens.

The six panels are grouped by what a setting does to a log line — where it is captured, what survives the filters, and where it ends up:

- **Overview** — native (Rust) bridge readiness and a live per-transport health list, plus the on-disk log file viewer and the link to the full log panel. Transport health was already polled but only ever rendered as one banner about native logging.
- **Levels** — the global threshold, the two enrichment toggles, per-module overrides, and the native tracing targets that used to sit in a different tab.
- **Filtering & redaction** — sampling rules, diagnostic throttling and redaction, which were scattered across `Advanced`.
- **Transports** — the seven sinks, each with a live health badge and its own configuration. The remote retry-queue bounds moved in beside the endpoint that fills them.
- **Telemetry & analytics** — behaviour telemetry and PostHog merged into one panel, because product analytics only emits while behaviour telemetry is on and the two tabs hid that dependency.
- **Local retention** — the entry and age caps, with a line saying which one wins.

Wiring fixes found while auditing that every control does what it says:

- **"Console Output" never actually turned the console transport off.** The core keeps its own `enableConsole` flag and re-applies it inside `ensureInitialized()`, which runs on every transport-registry call — so removing the console transport was undone by the very next `addTransport` in the same save, and again by each health poll. `applyLoggingSettings` now derives `enableConsole` (and the `enableStorage` / `enableRemote` / `maxStorageEntries` mirrors) from the records that own them.
- **IndexedDB write batching was configured but never applied.** `bufferSize` and `flushInterval` were validated on read and written on save, yet never passed to `createIndexedDBTransport`, so batching always ran at the transport's own defaults. Both are now wired through and exposed on the IndexedDB transport row.
- **Several sliders offered a narrower range than the setting accepts** — 20 000 queued entries against a real ceiling of 100 000, 50 MB against 100 MB, a 10 s diagnostic throttle against 60 s, and 90 days of agent-trace retention against 365. A value set outside the slider's range snapped down the first time the control was touched. Ranges now come from exported `CONFIG_BOUNDS` / `RETENTION_BOUNDS` records that the sanitizer itself uses.
- **Retention was the one persisted record read without validation**, so a corrupted bound went straight into the IndexedDB cleanup pass, where a negative or `NaN` value silently disables pruning. It is now clamped like every other read.

The three config fields nothing reads (`enableStorage`, `enableRemote`, `maxStorageEntries`) plus the unused `sampling` field are now documented as inert at the type, and their mirroring is pinned by a test.

Fixes:

- Sampling showed five rules (`mouse` 1%, `keyboard` 10%, `scroll` 5%, `animation` 1%, `error` 100%) whenever nothing was stored, but the logger applies no sampling for an empty map — so the panel displayed filtering that was not happening. The list now starts empty and says every module logs at 100%; the five rules are offered as an explicit "apply recommended preset" action.
- "Reset" restored a hand-copied set of defaults that had drifted from the ones the app actually ships: the remote and Langfuse transports were reset to off when they default to on, and `minLevel`, `bufferSize`, `flushInterval` and `includeSource` all differed. Restoring defaults now reuses the same records `bootstrap.ts` reads, behind a confirmation, and loads them as an unsaved draft.
- The OTLP headers field committed on every keystroke through a `parse`/`serialize` round-trip, so a partially-typed pair parsed to nothing and erased itself — the field could only be pasted into, never typed into. It now commits on blur/Enter.
- "Maximum local events" clamped on every keystroke against a three-digit floor, so typing `5000` snapped `5` to `100` and appended the rest to that.
- The minimum-level control mirrored its two-line option into a trigger too narrow to hold it.
- The save affordance was a permanent bar that always looked like it had something to do. It now appears only when something changed, names how many fields changed, and offers a discard.
- A failed save is reported instead of leaving the form silently dirty.
