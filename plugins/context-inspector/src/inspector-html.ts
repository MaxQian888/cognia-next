/**
 * The inspector panel's webview documents. Plain template strings (no build
 * step): the webview bridge wraps each with the CSP + `acquireCogniaWebviewApi`
 * polyfill, the host design-token stylesheet (`buildWebviewTokenCss`), and —
 * because this plugin declares the `context-panel` capability — the
 * `acquireCogniaContextPanelApi` client too.
 *
 * The panel is a developer tool and the reference consumer for the mirrored
 * API: it renders the live active context / workbench state / per-frame
 * visibility pushed by the host, surfaces the `ownsActivePanel` gate that
 * `setMode`/`setPinned` are subject to, exercises EVERY mirrored method
 * (including `register`/`dispose`, which render a second declared webview as
 * a dynamic panel), and persists its counters through `setState` so they
 * survive the iframe unmount a workbench collapse causes.
 *
 * `@cognia/plugin-ui` cannot cross an opaque-origin iframe — its components
 * are React. What CAN cross is (a) `motionTokens`, the package's documented
 * constant surface for "a CSS transition on its own markup", baked into the
 * stylesheet below, and (b) the component recipes themselves: the controls
 * here reproduce `secondary`/`outline` Buttons, `Badge` pills and `Card`
 * sections against the same injected `var(--*)` token contract, so the frame
 * reads as a plugin-ui surface.
 *
 * Localization: a webview document is outside the host's i18n pipeline, so the
 * builders take an `InspectorStrings` table the plugin resolves through
 * `ctx.i18n.t` (plugin.json `frame.*` keys) and bake it in — as escaped text in
 * the markup and as a JSON constant (`S`) for the strings the script sets at
 * runtime. API call labels (`register(probe)`, `setBadge(+1)`, …) and the log's
 * RPC traces are code identifiers and stay literal.
 *
 * Touch / motion: controls are ≥ 36px tall except on a wide, fine-pointer
 * screen (the `h-9 sm:h-7` pattern), text is ≥ 11px, hover styles only apply
 * where hover exists, and transitions switch off under reduced motion.
 *
 * Deliberately NOT exercised: `acquireCogniaWebviewApi().postMessage()`. The
 * frame→module channel is only reachable for webviews created through
 * `ctx.webview.create()` (the returned handle owns `onMessage`); nothing
 * subscribes inbound listeners for a manifest-declared webview, so a button
 * here would post into the void. Surfacing that host gap is better than
 * demoing a dead end.
 */

import { motionTokens } from "@cognia/plugin-ui"

export const INSPECTOR_PANEL_ID = "inspector"
/** Webview rendered as a panel by an in-frame `api.register()` call. */
export const PROBE_WEBVIEW_ID = "inspector-probe"
export const PROBE_PANEL_ID = "inspector-probe"

/** Every frame string, by its key under `frame.` in the plugin's i18n bundle. */
export const INSPECTOR_STRING_KEYS = [
  "title",
  "developer",
  "visible",
  "hidden",
  "apiMissing",
  "activeContext",
  "workbenchState",
  "waiting",
  "modeChip",
  "notApplicable",
  "ownsPanel",
  "notOwner",
  "pinned",
  "unpinned",
  "splitChip",
  "actions",
  "badge",
  "clear",
  "reveal",
  "mode",
  "modeGroup",
  "modeCollapsed",
  "modeNarrow",
  "modeWide",
  "modeFocus",
  "workbench",
  "pin",
  "unpin",
  "refresh",
  "panel",
  "panelGroup",
  "gateNote",
  "persisted",
  "persistedHint",
  "log",
  "probeTitle",
  "probeNote",
  "probeUnavailable",
  "probeResolved",
] as const

export type InspectorStringKey = (typeof INSPECTOR_STRING_KEYS)[number]
export type InspectorStrings = Record<InspectorStringKey, string>

/** Resolve the frame table through a translator for `frame.<key>`. */
export function resolveInspectorStrings(t: (key: string) => string): InspectorStrings {
  return Object.fromEntries(
    INSPECTOR_STRING_KEYS.map((key) => [key, t(`frame.${key}`)])
  ) as InspectorStrings
}

/** Escape a string for an HTML text node or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

/**
 * JSON for inlining inside a `<script>`: `<`/`>`/`&` and the JS line
 * separators are escaped so a translated string can never close the script
 * element or break the literal.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
}

/** `{name}` interpolation shared by the build step and (as source) the frames. */
const FMT_SOURCE = `function fmt(template, params) {
    return String(template).replace(/\\{(\\w+)\\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }`

const EASE = `cubic-bezier(${motionTokens.ease.join(", ")})`
const FAST = motionTokens.duration.fast

/**
 * Chrome shared by both documents. Mirrors `@cognia/plugin-ui` recipes —
 * `Card` sections, `secondary`/`outline` `Button`s, `Badge` pills — expressed
 * against the injected design tokens. A token absent from the injected
 * stylesheet (older host) falls back to a neutral value so the panel still
 * renders; a `color-mix` miss (older webview) falls back to the plainer rule
 * declared before it.
 */
const BASE_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 12px;
    line-height: calc(1.5 * var(--line-height-scale, 1));
    letter-spacing: var(--letter-spacing-em, 0em);
    color: var(--foreground, #18181b);
    background: var(--background, #ffffff);
  }
  main { display: flex; flex-direction: column; gap: var(--density-gap, 0.75rem); padding: calc(12px * var(--density-spacing, 1)); }
  /* plugin-ui Card: rounded-xl border bg-card text-card-foreground shadow-sm */
  section {
    background: var(--card, transparent);
    color: var(--card-foreground, var(--foreground, inherit));
    border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
    border-radius: calc(var(--radius, 0.625rem) * 1.4);
    padding: calc(12px * var(--density-spacing, 1));
    box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  }
  h1 { font-size: 13px; font-weight: 600; line-height: 1; margin: 0; }
  h2 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: calc(0.06em + var(--letter-spacing-em, 0em));
    color: var(--muted-foreground, #71717a);
    margin: 0 0 calc(8px * var(--density-spacing, 1));
  }
  h2 .hint { font-weight: 400; text-transform: none; letter-spacing: var(--letter-spacing-em, 0em); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  .json {
    margin: 0;
    padding: 8px;
    border-radius: calc(var(--radius, 0.625rem) * 0.8);
    background: var(--muted, rgba(127, 127, 127, 0.12));
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: auto;
    max-height: 160px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: calc(8px * var(--density-spacing, 1)); }
  .chip[hidden] { display: none; }
  /* plugin-ui Badge: rounded-full border px-2 py-0.5 text-xs font-medium.
     Base reads as the "secondary" variant; [data-on] switches to "success". */
  .chip, .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid transparent;
    background: var(--secondary, rgba(127, 127, 127, 0.12));
    color: var(--secondary-foreground, var(--foreground, inherit));
    white-space: nowrap;
  }
  .pill { border-color: var(--border, rgba(127, 127, 127, 0.35)); background: transparent; color: var(--foreground, inherit); }
  .pill i { font-style: normal; width: 6px; height: 6px; border-radius: 999px; background: var(--muted-foreground, #71717a); }
  .chip[data-on="true"], .pill[data-visible="true"] { background: var(--success, #16a34a); border-color: transparent; color: var(--success-foreground, #ffffff); }
  .chip[data-on="true"] i, .pill[data-visible="true"] i { background: currentColor; }
  .pill[data-visible="false"] { border-color: var(--destructive, #dc2626); color: var(--destructive, #dc2626); }
  .pill[data-visible="false"] i { background: var(--destructive, #dc2626); }
  .group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: calc(6px * var(--density-spacing, 1)); }
  .group-label {
    min-width: 78px;
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted-foreground, #71717a);
  }
  /* plugin-ui Button, variant="secondary" size="xs" — and the "outline"
     variant on [data-variant="outline"], "default" on [data-variant="primary"]. */
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    color: var(--secondary-foreground, var(--foreground, inherit));
    background: var(--secondary, rgba(127, 127, 127, 0.12));
    border: 1px solid transparent;
    border-radius: calc(var(--radius, 0.625rem) * 0.8);
    padding: 0 10px;
    /* Touch-first: >= 36px everywhere a finger may be the pointer. */
    min-height: max(36px, var(--density-input-height, 2.25rem));
    cursor: pointer;
    outline: none;
    transition: background calc(${FAST}s * var(--motion-duration-scale, 1)) ${EASE},
      border-color calc(${FAST}s * var(--motion-duration-scale, 1)) ${EASE},
      color calc(${FAST}s * var(--motion-duration-scale, 1)) ${EASE};
  }
  /* Wide screen with a fine pointer: the compact desktop size (h-9 sm:h-7). */
  @media (hover: hover) and (pointer: fine) and (min-width: 640px) {
    button { min-height: calc(var(--density-input-height, 2.25rem) * 0.78); padding: 0 8px; }
  }
  @media (hover: hover) {
    button:hover:not(:disabled) { background: color-mix(in srgb, var(--secondary, #e4e4e7) 80%, transparent); }
    button[data-variant="outline"]:hover:not(:disabled) { background: var(--accent, var(--muted, rgba(127, 127, 127, 0.12))); color: var(--accent-foreground, var(--foreground, inherit)); }
    button[data-variant="primary"]:hover:not(:disabled) { background: color-mix(in srgb, var(--primary, #6366f1) 90%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) {
    button { transition: none; }
  }
  button[data-variant="outline"] {
    background: var(--background, transparent);
    color: var(--foreground, inherit);
    border-color: var(--border, rgba(127, 127, 127, 0.4));
    border-color: var(--input, rgba(127, 127, 127, 0.4));
    box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  }
  button[data-variant="primary"] { background: var(--primary, #6366f1); color: var(--primary-foreground, #ffffff); }
  button:focus-visible {
    border-color: var(--ring, #6366f1);
    box-shadow: 0 0 0 3px var(--ring, #6366f1);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring, #6366f1) 50%, transparent);
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button[aria-pressed="true"] { border-color: var(--primary, #6366f1); color: var(--primary, #6366f1); }
  .note { font-size: 11px; color: var(--muted-foreground, #71717a); margin: calc(6px * var(--density-spacing, 1)) 0 0; }
  .banner {
    padding: 6px 8px;
    border-radius: calc(var(--radius, 0.625rem) * 0.8);
    border: 1px solid var(--destructive, #dc2626);
    color: var(--destructive, #dc2626);
    font-size: 11px;
  }
  .log { margin: 0; padding: 0; list-style: none; font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 160px; overflow: auto; }
  .log li { padding: 1px 0; border-bottom: 1px dashed var(--border, rgba(127, 127, 127, 0.25)); }
  .log li:last-child { border-bottom: 0; }
  .log .t { color: var(--muted-foreground, #71717a); margin-right: 6px; }
  .log .err { color: var(--destructive, #dc2626); }
  .mini { padding: 0 8px; }
  header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
  header .title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
`

export function buildInspectorHtml(strings: InspectorStrings): string {
  const h = (key: InspectorStringKey) => escapeHtml(strings[key])
  return `
<style>${BASE_CSS}</style>
<main>
  <header>
    <div class="title">
      <h1>${h("title")}</h1>
      <span class="chip">${h("developer")}</span>
    </div>
    <span id="visibility" class="pill" data-visible="true"><i></i>${h("visible")}</span>
  </header>
  <div id="api-banner" class="banner" role="alert" hidden>${h("apiMissing")}</div>
  <section>
    <h2>${h("activeContext")}</h2>
    <pre id="active-context" class="json">${h("waiting")}</pre>
  </section>
  <section>
    <h2>${h("workbenchState")}</h2>
    <pre id="workbench-state" class="json">${h("waiting")}</pre>
    <div class="chips">
      <span id="chip-mode" class="chip"></span>
      <span id="chip-owns" class="chip" data-on="false">${h("notOwner")}</span>
      <span id="chip-pinned" class="chip" data-on="false">${h("unpinned")}</span>
      <span id="chip-split" class="chip" hidden></span>
    </div>
  </section>
  <section>
    <h2>${h("actions")}</h2>
    <div class="group" role="group" aria-label="${h("badge")}">
      <span class="group-label">${h("badge")}</span>
      <button id="badge" type="button">+1</button>
      <button id="badge-clear" type="button" data-variant="outline">${h("clear")}</button>
    </div>
    <div class="group" role="group" aria-label="${h("reveal")}">
      <span class="group-label">${h("reveal")}</span>
      <button type="button" data-reveal="narrow">${h("modeNarrow")}</button>
      <button type="button" data-reveal="wide">${h("modeWide")}</button>
      <button type="button" data-reveal="focus">${h("modeFocus")}</button>
    </div>
    <div class="group" role="group" aria-label="${h("modeGroup")}">
      <span class="group-label">${h("mode")}</span>
      <button type="button" data-mode="collapsed">${h("modeCollapsed")}</button>
      <button type="button" data-mode="narrow">${h("modeNarrow")}</button>
      <button type="button" data-mode="wide">${h("modeWide")}</button>
      <button type="button" data-mode="focus">${h("modeFocus")}</button>
    </div>
    <div class="group" role="group" aria-label="${h("workbench")}">
      <span class="group-label">${h("workbench")}</span>
      <button id="pin" type="button" data-variant="outline" aria-pressed="false">${h("pin")}</button>
      <button id="refresh" type="button" data-variant="outline">${h("refresh")}</button>
    </div>
    <div class="group" role="group" aria-label="${h("panelGroup")}">
      <span class="group-label">${h("panel")}</span>
      <button id="register" type="button" data-variant="primary">register(probe)</button>
      <button id="dispose" type="button" data-variant="outline" disabled>dispose</button>
      <button id="reveal-probe" type="button" data-variant="outline" disabled>reveal(probe)</button>
    </div>
    <p id="gate-note" class="note">${h("gateNote")}</p>
  </section>
  <section>
    <h2><span>${h("persisted")} <span class="hint">${h("persistedHint")}</span></span></h2>
    <pre id="persisted" class="json">{}</pre>
  </section>
  <section>
    <h2><span>${h("log")}</span><button id="log-clear" class="mini" type="button" data-variant="outline">${h("clear")}</button></h2>
    <ol id="log" class="log" role="log" aria-live="polite"></ol>
  </section>
</main>
<script>
  var PANEL_ID = ${JSON.stringify(INSPECTOR_PANEL_ID)};
  var PROBE_WEBVIEW_ID = ${JSON.stringify(PROBE_WEBVIEW_ID)};
  var PROBE_PANEL_ID = ${JSON.stringify(PROBE_PANEL_ID)};
  var LOG_LIMIT = 60;
  var S = ${scriptJson(strings)};
  ${FMT_SOURCE}

  var api = typeof window.acquireCogniaContextPanelApi === "function"
    ? window.acquireCogniaContextPanelApi()
    : null;
  var webview = typeof window.acquireCogniaWebviewApi === "function"
    ? window.acquireCogniaWebviewApi()
    : null;

  var persisted = (webview && webview.getState()) || {};
  var badgeCount = typeof persisted.badgeCount === "number" ? persisted.badgeCount : 0;
  var probeRegistrationId = typeof persisted.probeRegistrationId === "string" ? persisted.probeRegistrationId : null;
  var workbenchState = null;

  function $(id) { return document.getElementById(id); }
  function show(id, value) {
    $(id).textContent =
      value === null || value === undefined ? "null" : JSON.stringify(value, null, 2);
  }
  function log(line, isError) {
    var list = $("log");
    var item = document.createElement("li");
    var time = document.createElement("span");
    time.className = "t";
    time.textContent = new Date().toISOString().slice(11, 19);
    var text = document.createElement("span");
    if (isError) text.className = "err";
    text.textContent = line;
    item.appendChild(time);
    item.appendChild(text);
    list.insertBefore(item, list.firstChild);
    while (list.children.length > LOG_LIMIT) list.removeChild(list.lastChild);
  }
  function errorText(err) { return err && err.message ? err.message : String(err); }
  function run(label, promise) {
    promise
      .then(function (result) { log(label + " -> " + JSON.stringify(result)); })
      .catch(function (err) { log(label + " !! " + errorText(err), true); });
  }
  function renderPersisted() {
    show("persisted", { badgeCount: badgeCount, probeRegistrationId: probeRegistrationId });
  }
  function save() {
    if (!webview) return;
    webview.setState({ badgeCount: badgeCount, probeRegistrationId: probeRegistrationId });
  }
  function syncProbeButtons() {
    $("dispose").disabled = !probeRegistrationId;
    $("register").disabled = !!probeRegistrationId;
    $("reveal-probe").disabled = !probeRegistrationId;
  }
  function applyWorkbenchState(state) {
    workbenchState = state;
    show("workbench-state", state);
    var owns = !!(state && state.ownsActivePanel);
    var pinned = !!(state && state.userPinned);
    $("chip-mode").textContent = fmt(S.modeChip, { mode: state ? state.mode : S.notApplicable });
    var ownsChip = $("chip-owns");
    ownsChip.dataset.on = String(owns);
    ownsChip.textContent = owns ? S.ownsPanel : S.notOwner;
    var pinChip = $("chip-pinned");
    pinChip.dataset.on = String(pinned);
    pinChip.textContent = pinned ? S.pinned : S.unpinned;
    var splitChip = $("chip-split");
    var splitId = state && state.splitPanelId;
    splitChip.hidden = !splitId;
    if (splitId) {
      splitChip.textContent = fmt(S.splitChip, {
        panel: splitId,
        ratio: state.splitRatio ?? "?",
      });
    }
    var pin = $("pin");
    pin.disabled = !owns;
    pin.setAttribute("aria-pressed", String(pinned));
    pin.textContent = pinned ? S.unpin : S.pin;
    var modeButtons = document.querySelectorAll("[data-mode]");
    for (var i = 0; i < modeButtons.length; i++) modeButtons[i].disabled = !owns;
    $("gate-note").hidden = owns;
  }

  if (!api) {
    $("api-banner").hidden = false;
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
  } else {
    api.onDidChangeActiveContext(function (context) { show("active-context", context); });
    api.onDidChangeWorkbenchState(applyWorkbenchState);
    api.onDidChangeVisibility(function (payload) {
      var el = $("visibility");
      el.dataset.visible = String(payload.visible);
      el.childNodes[1].nodeValue = payload.visible ? S.visible : S.hidden;
      log("visibility -> " + payload.visible);
    });

    $("badge").addEventListener("click", function () {
      badgeCount += 1;
      save();
      run("setBadge(" + badgeCount + ")", api.setBadge(PANEL_ID, badgeCount));
    });
    $("badge-clear").addEventListener("click", function () {
      badgeCount = 0;
      save();
      run("setBadge(0)", api.setBadge(PANEL_ID, 0));
    });
    var revealButtons = document.querySelectorAll("[data-reveal]");
    for (var i = 0; i < revealButtons.length; i++) {
      (function (button) {
        button.addEventListener("click", function () {
          var mode = button.getAttribute("data-reveal");
          run("reveal(" + mode + ")", api.reveal(PANEL_ID, mode));
        });
      })(revealButtons[i]);
    }
    var modeButtons = document.querySelectorAll("[data-mode]");
    for (var i = 0; i < modeButtons.length; i++) {
      (function (button) {
        button.addEventListener("click", function () {
          var mode = button.getAttribute("data-mode");
          run("setMode(" + mode + ")", api.setMode(mode));
        });
      })(modeButtons[i]);
    }
    $("pin").addEventListener("click", function () {
      var next = !(workbenchState && workbenchState.userPinned);
      run("setPinned(" + next + ")", api.setPinned(next));
    });
    $("refresh").addEventListener("click", function () {
      run("getActiveContext()", api.getActiveContext());
      run("getWorkbenchState()", api.getWorkbenchState());
    });
    $("register").addEventListener("click", function () {
      // In-flight guard: the button re-enables only when the RPC settles, so a
      // double-click cannot register the same panel twice.
      var button = $("register");
      button.disabled = true;
      api.register({
        id: PROBE_PANEL_ID,
        webview: PROBE_WEBVIEW_ID,
        label: S.probeTitle,
        labelKey: "panel.probe",
        resourceKinds: ["session"],
        activity: "inspect",
        icon: "Activity",
        order: 41,
        retention: "ephemeral",
      })
        .then(function (registrationId) {
          probeRegistrationId = registrationId;
          save();
          log("register(" + PROBE_PANEL_ID + ") -> " + registrationId);
        })
        .catch(function (err) { log("register !! " + errorText(err), true); })
        .then(syncProbeButtons);
    });
    $("dispose").addEventListener("click", function () {
      var id = probeRegistrationId;
      if (!id) return;
      var button = $("dispose");
      button.disabled = true;
      api.dispose(id)
        .then(function (ok) {
          // A stale id (the attachment outlived a frame remount) resolves
          // false — either way the frame stops tracking it.
          probeRegistrationId = null;
          save();
          log("dispose(" + id + ") -> " + JSON.stringify(ok));
        })
        .catch(function (err) { log("dispose !! " + errorText(err), true); })
        .then(syncProbeButtons);
    });
    $("reveal-probe").addEventListener("click", function () {
      // Cross-panel reveal: the RPC qualifies the id under THIS plugin, so the
      // inspector frame can bring the dynamically registered probe forward.
      run("reveal(" + PROBE_PANEL_ID + ", wide)", api.reveal(PROBE_PANEL_ID, "wide"));
    });
    $("log-clear").addEventListener("click", function () { $("log").textContent = ""; });
  }

  if (webview) {
    // A restore can land after this script ran — reconcile instead of ignoring.
    webview.onDidChangeState(function (state) {
      var s = state || {};
      badgeCount = typeof s.badgeCount === "number" ? s.badgeCount : 0;
      probeRegistrationId = typeof s.probeRegistrationId === "string" ? s.probeRegistrationId : null;
      if (api) syncProbeButtons();
      renderPersisted();
    });
  }
  if (api) syncProbeButtons();
  renderPersisted();
  applyWorkbenchState(null);
</script>`
}

/**
 * Body of the webview an in-frame `api.register()` turns into a second panel.
 * Kept deliberately small — it exists to prove a dynamically registered panel
 * gets its own frame with the same mirrored API injected, and that it can act
 * on ITSELF: the badge + reveal controls target its own panel id.
 */
export function buildProbeHtml(strings: InspectorStrings): string {
  const h = (key: InspectorStringKey) => escapeHtml(strings[key])
  // `{api}` marks where the literal `api.register()` code span goes.
  const note = h("probeNote").replace("{api}", "<code>api.register()</code>")
  return `
<style>${BASE_CSS}
  .probe { border-style: dashed; }
</style>
<main>
  <section class="probe">
    <h2><span>${h("probeTitle")}</span></h2>
    <p class="note" style="margin-top: 0;">${note}</p>
    <pre id="probe-context" class="json">${h("waiting")}</pre>
    <div class="group">
      <button id="probe-refresh" type="button">getActiveContext()</button>
      <button id="probe-badge" type="button" data-variant="outline">setBadge(+1)</button>
      <button id="probe-reveal" type="button" data-variant="outline">reveal(self)</button>
      <span id="probe-visibility" class="pill" data-visible="true"><i></i>${h("visible")}</span>
    </div>
    <p id="probe-log" class="note" role="status" aria-live="polite"></p>
  </section>
</main>
<script>
  var PANEL_ID = ${JSON.stringify(PROBE_PANEL_ID)};
  var S = ${scriptJson(strings)};
  var api = typeof window.acquireCogniaContextPanelApi === "function"
    ? window.acquireCogniaContextPanelApi()
    : null;
  var badge = 0;
  function note(line) { document.getElementById("probe-log").textContent = line; }
  function fail(label) {
    return function (err) { note(label + " !! " + (err && err.message ? err.message : String(err))); };
  }
  function showContext(context) {
    document.getElementById("probe-context").textContent =
      context === null || context === undefined ? "null" : JSON.stringify(context, null, 2);
  }
  if (api) {
    api.onDidChangeActiveContext(showContext);
    api.onDidChangeVisibility(function (payload) {
      var el = document.getElementById("probe-visibility");
      el.dataset.visible = String(payload.visible);
      el.childNodes[1].nodeValue = payload.visible ? S.visible : S.hidden;
    });
    document.getElementById("probe-refresh").addEventListener("click", function () {
      api.getActiveContext()
        .then(function (context) {
          showContext(context);
          note(S.probeResolved);
        })
        .catch(fail("getActiveContext()"));
    });
    document.getElementById("probe-badge").addEventListener("click", function () {
      badge += 1;
      api.setBadge(PANEL_ID, badge)
        .then(function (ok) { note("setBadge(" + badge + ") -> " + JSON.stringify(ok)); })
        .catch(fail("setBadge(" + badge + ")"));
    });
    document.getElementById("probe-reveal").addEventListener("click", function () {
      api.reveal(PANEL_ID, "focus")
        .then(function (ok) { note("reveal(self) -> " + JSON.stringify(ok)); })
        .catch(fail("reveal(self)"));
    });
  } else {
    document.getElementById("probe-context").textContent = S.probeUnavailable;
  }
</script>`
}
