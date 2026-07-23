/**
 * The inspector panel's webview document. A plain template string (no build
 * step): the webview bridge wraps it with the CSP + `acquireCogniaWebviewApi`
 * polyfill, and — because a `contextPanels[].webview` references it — the
 * `acquireCogniaContextPanelApi` client too.
 *
 * The panel is a developer tool: it renders the live active context /
 * workbench state / per-frame visibility pushed by the host, and exposes one
 * button per write method so a plugin author can watch each RPC round-trip.
 * Strings stay English-only on purpose — webview documents are outside the
 * host's next-intl pipeline; the user-facing panel label goes through the
 * manifest `i18n` block instead.
 */

export const INSPECTOR_PANEL_ID = "inspector"

export function buildInspectorHtml(): string {
  return `
<style>
  :root { color-scheme: light dark; }
  body { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 12px; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; margin: 12px 0 4px; }
  pre { margin: 0; padding: 8px; border-radius: 6px; background: rgba(127, 127, 127, 0.12); overflow: auto; max-height: 180px; white-space: pre-wrap; word-break: break-all; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  button { font: inherit; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(127, 127, 127, 0.4); background: transparent; cursor: pointer; }
  #visibility[data-visible="true"] { color: #16a34a; }
  #visibility[data-visible="false"] { color: #dc2626; }
</style>
<main>
  <div>Context Inspector <span id="visibility" data-visible="true">visible</span></div>
  <h2>Active context</h2>
  <pre id="active-context">(waiting for host)</pre>
  <h2>Workbench state</h2>
  <pre id="workbench-state">(waiting for host)</pre>
  <div class="row">
    <button id="badge">setBadge +1</button>
    <button id="badge-clear">setBadge 0</button>
    <button id="reveal">reveal(wide)</button>
    <button id="mode-focus">setMode(focus)</button>
    <button id="mode-narrow">setMode(narrow)</button>
    <button id="pin">setPinned(toggle)</button>
    <button id="refresh">getActiveContext()</button>
  </div>
  <h2>Log</h2>
  <pre id="log"></pre>
</main>
<script>
  var api = window.acquireCogniaContextPanelApi();
  var PANEL_ID = ${JSON.stringify(INSPECTOR_PANEL_ID)};
  var badgeCount = 0;
  var pinned = false;

  function show(id, value) {
    document.getElementById(id).textContent =
      value === null || value === undefined ? "null" : JSON.stringify(value, null, 2);
  }
  function log(line) {
    var el = document.getElementById("log");
    el.textContent = new Date().toISOString().slice(11, 19) + " " + line + "\\n" + el.textContent;
  }
  function run(label, promise) {
    promise
      .then(function (result) { log(label + " -> " + JSON.stringify(result)); })
      .catch(function (err) { log(label + " !! " + err.message); });
  }

  api.onDidChangeActiveContext(function (context) { show("active-context", context); });
  api.onDidChangeWorkbenchState(function (state) { show("workbench-state", state); });
  api.onDidChangeVisibility(function (payload) {
    var el = document.getElementById("visibility");
    el.dataset.visible = String(payload.visible);
    el.textContent = payload.visible ? "visible" : "hidden";
    log("visibility -> " + payload.visible);
  });

  document.getElementById("badge").addEventListener("click", function () {
    badgeCount += 1;
    run("setBadge(" + badgeCount + ")", api.setBadge(PANEL_ID, badgeCount));
  });
  document.getElementById("badge-clear").addEventListener("click", function () {
    badgeCount = 0;
    run("setBadge(0)", api.setBadge(PANEL_ID, 0));
  });
  document.getElementById("reveal").addEventListener("click", function () {
    run("reveal(wide)", api.reveal(PANEL_ID, "wide"));
  });
  document.getElementById("mode-focus").addEventListener("click", function () {
    run("setMode(focus)", api.setMode("focus"));
  });
  document.getElementById("mode-narrow").addEventListener("click", function () {
    run("setMode(narrow)", api.setMode("narrow"));
  });
  document.getElementById("pin").addEventListener("click", function () {
    pinned = !pinned;
    run("setPinned(" + pinned + ")", api.setPinned(pinned));
  });
  document.getElementById("refresh").addEventListener("click", function () {
    run("getActiveContext()", api.getActiveContext());
    run("getWorkbenchState()", api.getWorkbenchState());
  });
</script>`
}
