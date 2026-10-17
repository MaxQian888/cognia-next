// Functions and init scripts that run inside browsed pages. Each exported
// function is serialized by Playwright (`frame.evaluate(fn, arg)`), so it must
// be self-contained: no closures over module scope.

export const CREDENTIAL_BINDING = "__cogniaCredentialSubmitted"

/**
 * Runs before the injected overlay in every Chromium page. The overlay was
 * written for the system webview, which it reports to by navigating to
 * `https://cognia.invalid/...` sentinel URLs that Rust intercepts: load
 * complete, SPA navigations, and console / network / DOM-change pushes. Nothing
 * intercepts those in Chromium, so each report navigated the page to an error
 * page. The runtime already learns all of it from Playwright, so the overlay's
 * report hooks are no-ops here. (Element picks report through the
 * `__cogniaSignal` binding instead.)
 */
export const OVERLAY_TRANSPORT_SCRIPT =
  "window.__cogniaSignalNav=function(){};" +
  "window.__cogniaSignalLoaded=function(){};" +
  "window.__cogniaSignalPush=function(){};"
export const LOGIN_REGISTRY_KEY = "cognia.loginRegistry"

/**
 * Find visible login forms in the current document. Elements are parked in a
 * page-side registry keyed `<formKey>`, `<formKey>:u`, `<formKey>:p` so the
 * runtime can fill them by handle without ever sending values to the page
 * through a string.
 */
export function detectLoginFormsInPage(registryKey) {
  const registry = new Map()
  window[Symbol.for(registryKey)] = registry
  const visible = (element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return (
      rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
    )
  }
  const usernameTypes = new Set(["text", "email", "tel", ""])
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(
    (input) => !input.disabled && visible(input)
  )
  const scopes = new Set()
  const forms = []
  let index = 0
  for (const password of passwords) {
    const scope = password.form ?? password.closest("form") ?? document
    if (scopes.has(scope)) continue
    scopes.add(scope)
    const candidates = [...scope.querySelectorAll("input")].filter(
      (input) =>
        usernameTypes.has(input.type) && !input.disabled && !input.readOnly && visible(input)
    )
    const username =
      candidates.find((input) => /username|email/i.test(input.autocomplete ?? "")) ??
      candidates
        .filter(
          (input) => input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING
        )
        .pop() ??
      null
    index += 1
    const key = `lf${index}`
    registry.set(key, scope)
    registry.set(`${key}:p`, password)
    if (username) registry.set(`${key}:u`, username)
    forms.push({ key, hasUsername: Boolean(username) })
  }
  return forms
}

export function resolveLoginRegistryEntry({ registryKey, key }) {
  return window[Symbol.for(registryKey)]?.get(key) ?? null
}

/**
 * Init script for launched local Chromium: when a form holding a filled
 * password is submitted (form submit, a submit button click, or Enter in the
 * form), hand `{username, password}` to the Playwright binding. The binding
 * reference is captured and the global deleted before page scripts run.
 */
export const CREDENTIAL_CAPTURE_SCRIPT = `(() => {
  const name = ${JSON.stringify(CREDENTIAL_BINDING)};
  const send = window[name];
  try { delete window[name]; } catch {}
  if (typeof send !== "function") return;
  const usernameTypes = new Set(["text", "email", "tel", ""]);
  const extract = (root) => {
    if (!root || typeof root.querySelectorAll !== "function") return null;
    const passwords = [...root.querySelectorAll('input[type="password"]')].filter((i) => i.value);
    if (passwords.length === 0) return null;
    const password =
      passwords.find((i) => /new-password/i.test(i.autocomplete || "")) ?? passwords[0];
    const scope = password.form ?? root;
    const inputs = [...scope.querySelectorAll("input")].filter(
      (i) => usernameTypes.has(i.type) && i.value
    );
    const user =
      inputs.find((i) => /username|email/i.test((i.autocomplete || "") + " " + (i.name || "") + " " + (i.id || ""))) ??
      inputs.filter((i) => i.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).pop() ??
      inputs[0];
    return { username: user ? String(user.value) : "", password: String(password.value) };
  };
  let last = "";
  const report = (root) => {
    const credential = extract(root);
    if (!credential) return;
    const signature = credential.username + "\\u0000" + credential.password;
    if (signature === last) return;
    last = signature;
    try { send(credential); } catch {}
  };
  document.addEventListener("submit", (event) => {
    report(event.target instanceof HTMLFormElement ? event.target : document);
  }, true);
  document.addEventListener("click", (event) => {
    const target = event.target;
    const button = target && typeof target.closest === "function"
      ? target.closest('button, input[type="submit"], input[type="image"], [role="button"]')
      : null;
    if (!button) return;
    const form = button.form ?? button.closest("form");
    const type = (button.getAttribute("type") || "").toLowerCase();
    let submits = false;
    if (button.tagName === "INPUT") submits = type === "submit" || type === "image";
    else if (form) submits = button.tagName === "BUTTON" && (type === "" || type === "submit");
    else submits = true;
    if (!submits) return;
    report(form ?? document);
  }, true);
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (event.key !== "Enter" || !(target instanceof HTMLInputElement)) return;
    if (target.type !== "password" && !target.form) return;
    report(target.form ?? document);
  }, true);
})();`

export function readStorageInPage({ area, key }) {
  const storage = area === "session" ? window.sessionStorage : window.localStorage
  if (typeof key === "string") {
    return { origin: location.origin, key, value: storage.getItem(key) }
  }
  const entries = {}
  for (let index = 0; index < storage.length; index += 1) {
    const name = storage.key(index)
    if (name !== null) entries[name] = storage.getItem(name)
  }
  return { origin: location.origin, entries }
}

export function writeStorageInPage({ area, key, value }) {
  const storage = area === "session" ? window.sessionStorage : window.localStorage
  storage.setItem(key, value)
  return { origin: location.origin, key }
}

/**
 * Fit fixed-width documents without enlarging pages that already reflow.
 *
 * Shrinking is a cheap read: a page wider than the viewport at its current
 * zoom is zoomed down to fit. Growing back needs the page's natural width,
 * which only a layout at 100% reveals — so after the document changed (DOM
 * mutations, a window resize, `load`; at most once a second) or on `reset`,
 * the page is laid out at 100%, measured and given its fit within one task,
 * before anything paints. Without that, a responsive page that overflowed for
 * a moment while loading stayed shrunk for good.
 *
 * A page whose viewport clips sideways (`overflow-x: hidden`/`clip` on the
 * root, or on the body, which the viewport takes over) has chosen to cut what
 * sticks out — a decorative backdrop, an off-screen carousel slide — and no
 * browser would let the user scroll to it. There only the page's own layout
 * width counts (`body { min-width: 1280px }` still fits), measured at 100%.
 */
export function fitPageToWidth({ width, reset, now = Date.now() }) {
  const root = document.documentElement
  const body = document.body
  const state = (globalThis.__cogniaFitState ??= { dirty: true, measuredAt: -Infinity })
  if (!state.watching && typeof MutationObserver === "function" && body) {
    state.watching = true
    const changed = () => {
      state.dirty = true
    }
    // The body subtree, not the root: the root's own `style.zoom` is ours.
    new MutationObserver(changed).observe(body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    globalThis.addEventListener?.("resize", changed)
    globalThis.addEventListener?.("load", changed)
  }
  const overflowX = (element) =>
    element && typeof getComputedStyle === "function"
      ? getComputedStyle(element).overflowX
      : "visible"
  const rootOverflow = overflowX(root)
  const viewportOverflow = rootOverflow !== "visible" ? rootOverflow : overflowX(body)
  const clipsSideways = viewportOverflow === "hidden" || viewportOverflow === "clip"
  const current = Number(root.style.zoom) || 1
  if (reset || (state.dirty && now - state.measuredAt >= 1000)) {
    root.style.zoom = "1"
    const layoutWidth = clipsSideways
      ? Math.max(root.getBoundingClientRect().width, body ? body.getBoundingClientRect().width : 0)
      : root.scrollWidth
    const zoom = layoutWidth > root.clientWidth + 1 ? Math.min(1, width / layoutWidth) : 1
    root.style.zoom = String(zoom)
    state.dirty = false
    state.measuredAt = now
    return { zoom }
  }
  // Clipped overflow is never fitted by the cheap read; the next full measure
  // decides (`pending` tells the caller one is waiting).
  const zoom =
    !clipsSideways && root.scrollWidth > root.clientWidth + 1
      ? Math.min(1, width / root.scrollWidth)
      : current
  if (zoom !== current) root.style.zoom = String(zoom)
  // A change waiting for its full measure: the caller checks again shortly.
  return { zoom, pending: state.dirty }
}

export function clearStorageInPage({ area }) {
  const storage = area === "session" ? window.sessionStorage : window.localStorage
  const cleared = storage.length
  storage.clear()
  return { origin: location.origin, cleared }
}
