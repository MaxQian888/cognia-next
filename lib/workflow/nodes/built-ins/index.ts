/** Built-in workflow executor registration facade. */
// Side-effect import — registers the 12 desktop UI-automation executors at
// module load time. Keeps the catalog and the registry in sync without any
// cross-module wiring.
import "../automation/desktop"
// OCR extraction node (ADR-0024) — turns an image/PDF/screen into text.
import "../data/ocr"
// Desktop-pet nodes — the `action.pet.interact` emitter + the
// `trigger.pet.event` pass-through (real firing: runtime/pet-event-trigger).
import "../automation/pet"
// Eval nodes — run a dataset eval / gate a run from a workflow.
import "../evaluation"
// Optional browser-local Transformers.js inference. The module only registers
// an executor; the runtime itself is dynamically imported when the node runs.
import "../ai/browser-model"
// Wave 3 — registers the `action.system.terminal` executor that drives
// the integrated terminal dock from a workflow step.
import "../terminal"
// Persistent terminal-session nodes (open / run / close) — dock or
// unattended-headless mode, with run-scoped cleanup via the orchestrator.
import "../terminal/session"
// Script-file node — runs a .sh/.ps1/.py/… file under its detected
// interpreter (lib/terminal/script-runner.ts), dock or unattended mode.
import "../terminal/script"
// Local Git action nodes (ADR-0038) — stage / commit / push / branch against
// the active workspace repo.
import "../source-control"
// Web-clone node (`io.webClone`) — snapshot a live page + assets into a
// self-contained file/bundle via the vendored sidecar engine (desktop only).
import "../automation/web-clone"
import "../triggers"
import "../data/flow"
import "../ai/executors"
import "../goals"
import "../plans"
import "../scheduling"
import "../teams"
import "../connectors"
import "../integrations"
import "../mobile/executors"
