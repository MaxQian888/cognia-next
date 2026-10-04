import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"

import {
  CREDENTIAL_BINDING,
  CREDENTIAL_CAPTURE_SCRIPT,
  LOGIN_REGISTRY_KEY,
  OVERLAY_TRANSPORT_SCRIPT,
  clearStorageInPage,
  detectLoginFormsInPage,
  readStorageInPage,
  resolveLoginRegistryEntry,
  writeStorageInPage,
} from "./page-scripts.mjs"

const FOLLOWING = 4

// Minimal DOM: elements are ordered by `index` for compareDocumentPosition.
class Element {
  constructor(tag, attributes = {}, index = 0) {
    this.tagName = tag.toUpperCase()
    this.attributes = attributes
    this.type = attributes.type ?? (tag === "input" ? "text" : "")
    this.autocomplete = attributes.autocomplete ?? ""
    this.name = attributes.name ?? ""
    this.id = attributes.id ?? ""
    this.value = attributes.value ?? ""
    this.disabled = attributes.disabled === true
    this.readOnly = false
    this.hidden = attributes.hidden === true
    this.index = index
    this.form = null
    this.children = []
  }
  getAttribute(name) {
    return this.attributes[name] ?? null
  }
  getBoundingClientRect() {
    return this.hidden ? { width: 0, height: 0 } : { width: 100, height: 20 }
  }
  compareDocumentPosition(other) {
    return other.index > this.index ? FOLLOWING : 2
  }
  closest(selector) {
    if (selector === "form") return this.form
    return this.matches(selector) ? this : null
  }
  matches(selector) {
    return selector
      .split(",")
      .map((part) => part.trim())
      .some((part) => {
        if (part === "button") return this.tagName === "BUTTON"
        if (part === '[role="button"]') return this.attributes.role === "button"
        const match = part.match(/^input\[type="(\w+)"\]$/)
        return Boolean(match) && this.tagName === "INPUT" && this.type === match[1]
      })
  }
  querySelectorAll(selector) {
    return this.children.filter((child) =>
      selector === "input" ? child.tagName === "INPUT" : child.matches(selector)
    )
  }
}

function buildLoginDocument({ hiddenPassword = false } = {}) {
  const form = new Element("form", {}, 0)
  form.action = "/session"
  const email = new Element("input", { type: "email", name: "email", value: "ada@example.com" }, 1)
  const password = new Element(
    "input",
    { type: "password", value: "s3cret", hidden: hiddenPassword },
    2
  )
  const eye = new Element("button", { type: "button" }, 3)
  const submit = new Element("button", { type: "submit" }, 4)
  for (const element of [email, password, eye, submit]) {
    element.form = form
    form.children.push(element)
  }
  const outsidePassword = new Element("input", { type: "password", value: "" }, 5)
  const document = {
    children: [form, email, password, eye, submit, outsidePassword],
    querySelectorAll: (selector) =>
      [email, password, eye, submit, outsidePassword].filter((element) =>
        selector === "input" ? element.tagName === "INPUT" : element.matches(selector)
      ),
  }
  return { document, form, email, password, eye, submit, outsidePassword }
}

function withGlobals(globals, callback) {
  const saved = {}
  for (const [key, value] of Object.entries(globals)) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  try {
    return callback()
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

test("detectLoginFormsInPage parks username and password elements in the registry", () => {
  const { document, form, email, password, outsidePassword } = buildLoginDocument()
  const window = {}
  const forms = withGlobals(
    {
      window,
      document,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      Node: { DOCUMENT_POSITION_FOLLOWING: FOLLOWING },
    },
    () => detectLoginFormsInPage(LOGIN_REGISTRY_KEY)
  )
  // The stray password field outside a form scopes to the whole document.
  assert.deepEqual(forms, [
    { key: "lf1", hasUsername: true },
    { key: "lf2", hasUsername: true },
  ])
  const registry = window[Symbol.for(LOGIN_REGISTRY_KEY)]
  assert.equal(registry.get("lf1"), form)
  assert.equal(registry.get("lf1:u"), email)
  assert.equal(registry.get("lf1:p"), password)
  assert.equal(registry.get("lf2:p"), outsidePassword)
  withGlobals({ window }, () => {
    assert.equal(
      resolveLoginRegistryEntry({ registryKey: LOGIN_REGISTRY_KEY, key: "lf1:p" }),
      password
    )
    assert.equal(resolveLoginRegistryEntry({ registryKey: LOGIN_REGISTRY_KEY, key: "nope" }), null)
  })
})

test("detectLoginFormsInPage ignores invisible password fields", () => {
  const { document, outsidePassword } = buildLoginDocument({ hiddenPassword: true })
  outsidePassword.hidden = true
  const forms = withGlobals(
    {
      window: {},
      document,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      Node: { DOCUMENT_POSITION_FOLLOWING: FOLLOWING },
    },
    () => detectLoginFormsInPage(LOGIN_REGISTRY_KEY)
  )
  assert.deepEqual(forms, [])
})

function runCaptureScript(document) {
  const listeners = new Map()
  document.addEventListener = (type, listener) => listeners.set(type, listener)
  const sent = []
  const window = {
    [CREDENTIAL_BINDING]: (payload) => sent.push(JSON.parse(JSON.stringify(payload))),
  }
  class HTMLFormElement {}
  class HTMLInputElement {}
  vm.runInNewContext(CREDENTIAL_CAPTURE_SCRIPT, {
    window,
    document,
    HTMLFormElement,
    HTMLInputElement,
    Node: { DOCUMENT_POSITION_FOLLOWING: FOLLOWING },
    Set,
  })
  return { listeners, sent, window, HTMLFormElement, HTMLInputElement }
}

test("capture script hides the binding and reports a submitted login once", () => {
  const { document, form, submit, eye } = buildLoginDocument()
  const { listeners, sent, window } = runCaptureScript(document)
  assert.equal(CREDENTIAL_BINDING in window, false)

  // The show-password toggle is not a submission.
  listeners.get("click")({ target: eye })
  assert.deepEqual(sent, [])

  listeners.get("click")({ target: submit })
  listeners.get("click")({ target: submit })
  assert.deepEqual(sent, [{ username: "ada@example.com", password: "s3cret" }])

  // A second attempt with a different password reports again.
  form.children[1].value = "s3cret-2"
  listeners.get("click")({ target: submit })
  assert.deepEqual(sent.at(-1), { username: "ada@example.com", password: "s3cret-2" })
})

test("capture script does nothing without a filled password", () => {
  const { document, form, submit } = buildLoginDocument()
  form.children[1].value = ""
  const { listeners, sent } = runCaptureScript(document)
  listeners.get("click")({ target: submit })
  listeners.get("keydown")({ key: "Enter", target: {} })
  assert.deepEqual(sent, [])
})

function fakeStorage() {
  const map = new Map()
  return {
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    clear: () => map.clear(),
  }
}

test("storage helpers read, write and clear the requested area", () => {
  const localStorage = fakeStorage()
  const sessionStorage = fakeStorage()
  withGlobals(
    {
      window: { localStorage, sessionStorage },
      location: { origin: "https://app.example.com" },
    },
    () => {
      assert.deepEqual(writeStorageInPage({ area: "local", key: "a", value: "1" }), {
        origin: "https://app.example.com",
        key: "a",
      })
      writeStorageInPage({ area: "session", key: "s", value: "2" })
      assert.deepEqual(readStorageInPage({ area: "local" }), {
        origin: "https://app.example.com",
        entries: { a: "1" },
      })
      assert.deepEqual(readStorageInPage({ area: "session", key: "s" }), {
        origin: "https://app.example.com",
        key: "s",
        value: "2",
      })
      assert.deepEqual(clearStorageInPage({ area: "local" }), {
        origin: "https://app.example.com",
        cleared: 1,
      })
      assert.equal(sessionStorage.length, 1)
    }
  )
})

test("the overlay transport script turns every sentinel report hook into a no-op", () => {
  const window = {}
  new Function("window", OVERLAY_TRANSPORT_SCRIPT)(window)
  for (const hook of ["__cogniaSignalNav", "__cogniaSignalLoaded", "__cogniaSignalPush"]) {
    assert.equal(typeof window[hook], "function", hook)
    assert.equal(window[hook]({ url: "https://example.com/" }), undefined)
  }
  // The pick signal is a Playwright binding, not a stub.
  assert.equal(window.__cogniaSignal, undefined)
})
