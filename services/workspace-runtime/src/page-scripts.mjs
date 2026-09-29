// Functions and init scripts that run inside browsed pages. Each exported
// function is serialized by Playwright (`frame.evaluate(fn, arg)`), so it must
// be self-contained: no closures over module scope.

export const CREDENTIAL_BINDING = "__cogniaCredentialSubmitted"
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

export function clearStorageInPage({ area }) {
  const storage = area === "session" ? window.sessionStorage : window.localStorage
  const cleared = storage.length
  storage.clear()
  return { origin: location.origin, cleared }
}
