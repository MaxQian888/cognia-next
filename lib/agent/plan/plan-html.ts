/**
 * Interactive plan HTML generator — the "enhanced plan mode" document. (ADR-0045)
 *
 * `buildPlanHtml` is a pure function that renders an `AgentPlan` snapshot into
 * a fully self-contained HTML document (inline CSS + JS, zero external
 * requests) meant to run inside a sandboxed `allow-scripts` iframe hosted by
 * `components/agent/plan/plan-html-view.tsx`. Inside the document the user can
 * modify or adjust the proposed plan before approving it:
 *
 *   - edit the plan title and any step title inline
 *   - reorder steps by dragging the handle, or with the ▲ / ▼ buttons
 *   - add and remove steps
 *   - reset back to the captured snapshot, or save the adjustment
 *
 * The document talks to its host exclusively via `parent.postMessage` using
 * the {@link PLAN_HTML_MSG} protocol; plan data is baked in as a JSON island
 * (`<script type="application/json">`) so no fetch / same-origin access is
 * ever needed. All plan-derived text is HTML-escaped or injected through
 * `textContent` / `value`, so a malicious step title cannot script the frame
 * (and the frame is sandboxed without `allow-same-origin` regardless).
 *
 * User-facing strings are supplied by the host through {@link PlanHtmlLabels}
 * (sourced from next-intl) — nothing here is hard-coded English.
 */

// Direct module import (not the `@/lib/artifacts` barrel) so this stays a
// lean pure-string module usable from the node-env jest project.
import { escapeHtml } from "@/lib/artifacts/preview-utils"
import type { PlanStepStatus } from "@/types/agent/plan"

/** postMessage protocol between the plan document and its host. */
export const PLAN_HTML_MSG = {
  /** iframe → host: document booted and rendered. */
  ready: "cognia-plan-ready",
  /** iframe → host: `{ height }` content height for auto-sizing. */
  resize: "cognia-plan-resize",
  /** iframe → host: `{ title, stepTitles, stepsChanged }` save request. */
  save: "cognia-plan-save",
} as const

/** Payload of a {@link PLAN_HTML_MSG.save} message. */
export interface PlanHtmlSavePayload {
  type: typeof PLAN_HTML_MSG.save
  title: string
  stepTitles: string[]
  /** False when only the title changed — lets the host preserve a rich markdown body. */
  stepsChanged: boolean
}

/** Step snapshot rendered into the document. */
export interface PlanHtmlStep {
  id: string
  title: string
  status: PlanStepStatus
}

/**
 * Built-in visual style presets for the plan document. Pure CSS variations —
 * the DOM and postMessage protocol are identical across presets:
 *
 *   default  — bordered row per step (the original look)
 *   compact  — dense rows for long plans
 *   timeline — numbered nodes on a vertical rail
 *   cards    — roomy card per step with an accent rail
 */
export const PLAN_HTML_STYLES = ["default", "compact", "timeline", "cards"] as const
export type PlanHtmlStyle = (typeof PLAN_HTML_STYLES)[number]

/** Coerce an arbitrary persisted value to a valid style (default fallback). */
export function resolvePlanHtmlStyle(value: unknown): PlanHtmlStyle {
  return PLAN_HTML_STYLES.includes(value as PlanHtmlStyle) ? (value as PlanHtmlStyle) : "default"
}

/** Localised strings the document renders (host supplies via next-intl). */
export interface PlanHtmlLabels {
  titleLabel: string
  stepsLabel: string
  addStep: string
  deleteStep: string
  moveUp: string
  moveDown: string
  dragHint: string
  save: string
  reset: string
  empty: string
  originalPlan: string
  stepPlaceholder: string
}

export interface BuildPlanHtmlInput {
  title: string
  steps: PlanHtmlStep[]
  /** Original markdown body of an `exit_plan_mode` capture — shown read-only. */
  planText?: string
  labels: PlanHtmlLabels
  theme: "light" | "dark"
  /** Built-in visual preset. Defaults to `"default"`. */
  style?: PlanHtmlStyle
}

/** Serialize a JSON island safely (`</script>` can never terminate the block). */
function jsonIsland(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

const STYLE = `
:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #6b7280; --border: #e5e7eb;
  --card: #f7f7f8; --primary: #4f46e5; --primary-fg: #ffffff;
  --danger: #dc2626; --ok: #16a34a; --warn: #d97706;
}
body.theme-dark {
  --bg: #101114; --fg: #e6e6e9; --muted: #9ca3af; --border: #2b2d33;
  --card: #1a1c21; --primary: #818cf8; --primary-fg: #101114;
  --danger: #f87171; --ok: #4ade80; --warn: #fbbf24;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 3px; }
input[type="text"] {
  width: 100%; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--fg); font-size: 13px; outline: none;
}
input[type="text"]:focus { border-color: var(--primary); }
.steps-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px; }
.steps-head .count { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
ul#steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
li.step {
  display: flex; align-items: center; gap: 6px; padding: 4px 6px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--card);
}
li.step.dragging { opacity: 0.5; }
.handle { cursor: grab; color: var(--muted); user-select: none; font-size: 14px; padding: 0 2px; }
.dot { width: 8px; height: 8px; border-radius: 999px; flex: none; border: 1px solid var(--muted); }
.dot[data-status="completed"] { background: var(--ok); border-color: var(--ok); }
.dot[data-status="in_progress"] { background: var(--warn); border-color: var(--warn); }
.dot[data-status="failed"], .dot[data-status="blocked"] { background: var(--danger); border-color: var(--danger); }
.dot[data-status="skipped"] { background: var(--muted); border-color: var(--muted); }
li.step input { flex: 1; border: none; background: transparent; padding: 3px 4px; }
li.step input:focus { background: var(--bg); border-radius: 4px; }
button {
  border: 1px solid var(--border); background: var(--card); color: var(--fg);
  border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: default; }
button.icon { padding: 2px 5px; font-size: 11px; line-height: 1.2; color: var(--muted); }
button.icon:hover:not(:disabled) { color: var(--fg); }
button.danger:hover:not(:disabled) { color: var(--danger); border-color: var(--danger); }
button#save { background: var(--primary); border-color: var(--primary); color: var(--primary-fg); }
#add-step { align-self: flex-start; }
footer { display: flex; justify-content: flex-end; gap: 8px; }
.empty { font-size: 12px; color: var(--muted); font-style: italic; padding: 4px 2px; }
details { border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; }
summary { font-size: 11px; color: var(--muted); cursor: pointer; user-select: none; }
details pre {
  margin: 6px 0 2px; white-space: pre-wrap; word-break: break-word;
  font: 11px/1.5 ui-monospace, "Cascadia Mono", monospace; color: var(--fg);
}

/* ── Built-in style presets (CSS-only; DOM + protocol identical) ── */

/* compact — dense rows for long plans */
body.style-compact main { padding: 6px 8px; gap: 6px; }
body.style-compact ul#steps { gap: 2px; }
body.style-compact li.step { padding: 1px 4px; gap: 4px; border-radius: 6px; }
body.style-compact li.step input { font-size: 12px; padding: 2px 3px; }
body.style-compact button.icon { padding: 1px 4px; }

/* timeline — numbered nodes on a vertical rail */
body.style-timeline ul#steps { counter-reset: step; position: relative; }
body.style-timeline ul#steps::before {
  content: ""; position: absolute; left: 16px; top: 12px; bottom: 12px;
  width: 2px; background: var(--border);
}
body.style-timeline li.step {
  counter-increment: step; background: transparent; border-color: transparent;
}
body.style-timeline li.step:hover, body.style-timeline li.step:focus-within {
  background: var(--card);
}
body.style-timeline li.step::before {
  content: counter(step); flex: none; width: 20px; height: 20px;
  border-radius: 999px; background: var(--card); border: 1px solid var(--border);
  color: var(--muted); font-size: 10px; line-height: 18px; text-align: center;
  position: relative; z-index: 1;
}
body.style-timeline li.step .dot { display: none; }

/* cards — roomy card per step with an accent rail */
body.style-cards ul#steps { gap: 8px; }
body.style-cards li.step {
  padding: 8px 10px; border-radius: 10px;
  border-left: 3px solid var(--primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
body.style-cards li.step input { padding: 4px 6px; }
`

/**
 * The document script. Kept as a static string (no plan data interpolated —
 * data arrives through the JSON island) so the only dynamic HTML is escaped
 * label/plan text.
 */
const SCRIPT = `
(function () {
  "use strict";
  var data = JSON.parse(document.getElementById("plan-data").textContent);
  var original = JSON.parse(JSON.stringify(data));
  var listEl = document.getElementById("steps");
  var titleEl = document.getElementById("plan-title");
  var countEl = document.getElementById("step-count");
  var emptyEl = document.getElementById("steps-empty");
  var saveBtn = document.getElementById("save");
  var resetBtn = document.getElementById("reset");
  var dragIndex = -1;

  function post(msg) { try { parent.postMessage(msg, "*"); } catch (e) {} }

  function titles(steps) {
    return steps.map(function (s) { return s.title.trim(); }).filter(function (t) { return t.length > 0; });
  }

  function stepsChanged() {
    return JSON.stringify(titles(data.steps)) !== JSON.stringify(titles(original.steps));
  }

  function dirty() {
    return data.title.trim() !== original.title.trim() || stepsChanged();
  }

  function syncDirty() {
    var d = dirty();
    saveBtn.disabled = !d || titles(data.steps).length === 0;
    resetBtn.disabled = !d;
  }

  function reportHeight() {
    post({ type: "cognia-plan-resize", height: document.documentElement.scrollHeight });
  }

  function domOrderToState() {
    var byId = {};
    data.steps.forEach(function (s) { byId[s.id] = s; });
    var next = [];
    listEl.querySelectorAll("li.step").forEach(function (li) {
      var s = byId[li.dataset.id];
      if (s) next.push(s);
    });
    data.steps = next;
  }

  function render() {
    titleEl.value = data.title;
    listEl.textContent = "";
    countEl.textContent = String(data.steps.length);
    emptyEl.style.display = data.steps.length === 0 ? "" : "none";
    data.steps.forEach(function (step, i) {
      var li = document.createElement("li");
      li.className = "step";
      li.dataset.id = step.id;

      var handle = document.createElement("span");
      handle.className = "handle";
      handle.textContent = "⠿";
      handle.title = data.labels.dragHint;
      handle.addEventListener("mousedown", function () { li.draggable = true; });
      li.addEventListener("dragend", function () {
        li.draggable = false;
        li.classList.remove("dragging");
        dragIndex = -1;
        domOrderToState();
        render();
        syncDirty();
        reportHeight();
      });
      li.addEventListener("dragstart", function (e) {
        dragIndex = i;
        li.classList.add("dragging");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      li.addEventListener("dragover", function (e) {
        e.preventDefault();
        var dragging = listEl.querySelector("li.dragging");
        if (!dragging || dragging === li) return;
        var rect = li.getBoundingClientRect();
        var before = e.clientY < rect.top + rect.height / 2;
        listEl.insertBefore(dragging, before ? li : li.nextSibling);
      });

      var dot = document.createElement("span");
      dot.className = "dot";
      dot.dataset.status = step.status;

      var input = document.createElement("input");
      input.type = "text";
      input.maxLength = 200;
      input.value = step.title;
      input.placeholder = data.labels.stepPlaceholder;
      input.setAttribute("aria-label", data.labels.stepsLabel);
      input.addEventListener("input", function () {
        step.title = input.value;
        syncDirty();
      });

      var up = document.createElement("button");
      up.className = "icon";
      up.type = "button";
      up.textContent = "▲";
      up.title = data.labels.moveUp;
      up.disabled = i === 0;
      up.addEventListener("click", function () {
        data.steps.splice(i - 1, 0, data.steps.splice(i, 1)[0]);
        render(); syncDirty(); reportHeight();
      });

      var down = document.createElement("button");
      down.className = "icon";
      down.type = "button";
      down.textContent = "▼";
      down.title = data.labels.moveDown;
      down.disabled = i === data.steps.length - 1;
      down.addEventListener("click", function () {
        data.steps.splice(i + 1, 0, data.steps.splice(i, 1)[0]);
        render(); syncDirty(); reportHeight();
      });

      var del = document.createElement("button");
      del.className = "icon danger";
      del.type = "button";
      del.textContent = "✕";
      del.title = data.labels.deleteStep;
      del.addEventListener("click", function () {
        data.steps.splice(i, 1);
        render(); syncDirty(); reportHeight();
      });

      li.appendChild(handle);
      li.appendChild(dot);
      li.appendChild(input);
      li.appendChild(up);
      li.appendChild(down);
      li.appendChild(del);
      listEl.appendChild(li);
    });
  }

  titleEl.addEventListener("input", function () {
    data.title = titleEl.value;
    syncDirty();
  });

  document.getElementById("add-step").addEventListener("click", function () {
    data.steps.push({ id: "new-" + Date.now() + "-" + data.steps.length, title: "", status: "pending" });
    render(); syncDirty(); reportHeight();
    var inputs = listEl.querySelectorAll("input");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  resetBtn.addEventListener("click", function () {
    data = JSON.parse(JSON.stringify(original));
    render(); syncDirty(); reportHeight();
  });

  saveBtn.addEventListener("click", function () {
    var t = titles(data.steps);
    if (t.length === 0) return;
    post({
      type: "cognia-plan-save",
      title: data.title.trim() || original.title,
      stepTitles: t,
      stepsChanged: stepsChanged()
    });
  });

  render();
  syncDirty();
  post({ type: "cognia-plan-ready" });
  reportHeight();
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(function () { reportHeight(); }).observe(document.body);
  }
})();
`

/** Render the interactive plan editor document. Pure; no DOM required. */
export function buildPlanHtml(input: BuildPlanHtmlInput): string {
  const { title, steps, planText, labels, theme } = input
  const style = resolvePlanHtmlStyle(input.style)
  const data = {
    title,
    steps: steps.map((s) => ({ id: s.id, title: s.title, status: s.status })),
    labels,
  }
  const planTextBlock = planText?.trim()
    ? `<details>
      <summary>${escapeHtml(labels.originalPlan)}</summary>
      <pre>${escapeHtml(planText)}</pre>
    </details>`
    : ""

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}</style>
</head>
<body class="${theme === "dark" ? "theme-dark" : "theme-light"} style-${style}">
<main>
  <section>
    <label for="plan-title">${escapeHtml(labels.titleLabel)}</label>
    <input id="plan-title" type="text" maxlength="120">
  </section>
  <section>
    <div class="steps-head">
      <label for="steps" style="margin:0">${escapeHtml(labels.stepsLabel)}</label>
      <span class="count" id="step-count"></span>
    </div>
    <p class="empty" id="steps-empty" style="display:none">${escapeHtml(labels.empty)}</p>
    <ul id="steps"></ul>
  </section>
  <button id="add-step" type="button">+ ${escapeHtml(labels.addStep)}</button>
  ${planTextBlock}
  <footer>
    <button id="reset" type="button" disabled>${escapeHtml(labels.reset)}</button>
    <button id="save" type="button" disabled>${escapeHtml(labels.save)}</button>
  </footer>
</main>
<script type="application/json" id="plan-data">${jsonIsland(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>`
}
