/**
 * @jest-environment jsdom
 *
 * Exercises the real injected overlay file (the same bytes Rust `include_str!`s)
 * by evaluating it against jsdom globals — no logic is duplicated here.
 */
import fs from "node:fs"
import path from "node:path"

const CODE = fs.readFileSync(path.join(__dirname, "overlay.injected.js"), "utf8")

type SelectionPayload = {
  selector: string
  domPath: string
  tagName: string
  id: string | null
  rect: { x: number; y: number; width: number; height: number }
  outerHTML: string
  text: string
}

type OverlayApi = {
  cssSelector: (el: Element) => string
  domPath: (el: Element) => string
  buildPayload: (el: Element) => SelectionPayload
  isActive: () => boolean
}

function install(): OverlayApi {
  // Initialization scripts re-run per document load; reset the idempotency flag.
  delete (window as unknown as Record<string, unknown>).__cogniaOverlayInstalled
  // Indirect eval runs in global scope so `window`/`document` bind to jsdom.
  ;(0, eval)(CODE)
  return (window as unknown as { __cogniaOverlay: OverlayApi }).__cogniaOverlay
}

beforeEach(() => {
  document.body.innerHTML = ""
  delete (window as unknown as Record<string, unknown>).__cogniaSignal
  delete (window as unknown as Record<string, unknown>).__cogniaSetSelectMode
})

describe("overlay.injected cssSelector", () => {
  it("anchors on the nearest ancestor id", () => {
    document.body.innerHTML = `<main id="root"><section><button>go</button></section></main>`
    const api = install()
    const btn = document.querySelector("button")!
    expect(api.cssSelector(btn)).toBe("#root > section > button")
  })

  it("uses nth-of-type to disambiguate siblings", () => {
    document.body.innerHTML = `<ul><li>a</li><li>b</li><li>c</li></ul>`
    const api = install()
    const third = document.querySelectorAll("li")[2]
    expect(api.cssSelector(third)).toBe("body > ul > li:nth-of-type(3)")
  })

  it("returns empty string for non-elements", () => {
    const api = install()
    expect(api.cssSelector(document.createTextNode("x") as unknown as Element)).toBe("")
  })
})

describe("overlay.injected domPath", () => {
  it("renders a short readable path with id/class", () => {
    document.body.innerHTML = `<div class="card"><button id="submit">ok</button></div>`
    const api = install()
    const btn = document.querySelector("button")!
    expect(api.domPath(btn)).toBe("div.card > button#submit")
  })
})

describe("overlay.injected buildPayload", () => {
  it("captures selector, dom path, tag, text and truncates html", () => {
    document.body.innerHTML = `<div class="card"><button id="submit">Click me</button></div>`
    const api = install()
    const btn = document.querySelector("button")!
    const payload = api.buildPayload(btn)
    expect(payload.tagName).toBe("button")
    expect(payload.id).toBe("submit")
    expect(payload.selector).toBe("#submit")
    expect(payload.text).toBe("Click me")
    expect(payload.outerHTML).toContain("<button")
  })
})

describe("overlay.injected select mode", () => {
  it("emits a payload through __cogniaSignal on click and auto-disables", () => {
    document.body.innerHTML = `<button id="go">go</button>`
    const api = install()
    const received: SelectionPayload[] = []
    ;(window as unknown as { __cogniaSignal: (p: SelectionPayload) => void }).__cogniaSignal = (
      p
    ) => received.push(p)
    ;(window as unknown as { __cogniaSetSelectMode: (on: boolean) => void }).__cogniaSetSelectMode(
      true
    )
    expect(api.isActive()).toBe(true)

    document.getElementById("go")!.click()

    expect(received).toHaveLength(1)
    expect(received[0].selector).toBe("#go")
    expect(api.isActive()).toBe(false) // disables itself after a pick
  })

  it("does not emit when inactive", () => {
    document.body.innerHTML = `<button id="go">go</button>`
    install()
    const fn = jest.fn()
    ;(window as unknown as { __cogniaSignal: typeof fn }).__cogniaSignal = fn
    document.getElementById("go")!.click()
    expect(fn).not.toHaveBeenCalled()
  })

  it("Escape cancels select mode", () => {
    install()
    const setMode = (window as unknown as { __cogniaSetSelectMode: (on: boolean) => void })
      .__cogniaSetSelectMode
    const api = (window as unknown as { __cogniaOverlay: OverlayApi }).__cogniaOverlay
    setMode(true)
    expect(api.isActive()).toBe(true)
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    expect(api.isActive()).toBe(false)
  })
})

type Win = Record<string, unknown> & {
  __cogniaSnapshot: (optsJson?: string) => string
  __cogniaAct: (ref: string, action: string, argsJson: string) => string
  __cogniaDrainConsole: () => string
  __cogniaDrainNetwork: () => string
  __cogniaHasText: (text: string) => boolean
  __cogniaHasSelector: (selector: string) => boolean
  __cogniaOverlay: {
    resolveRef: (ref: string) => unknown
    installNetworkHook: () => void
    hasText: (text: string) => boolean
    parseKeyChord: (raw: string) => {
      ctrlKey: boolean
      shiftKey: boolean
      altKey: boolean
      metaKey: boolean
      key: string
    }
    networkState: () => { pending: number; completed: number }
    absoluteHttpUrl: (u: string) => string | null
    navTo: (u: string) => boolean
    makeWindowStub: () => {
      closed: boolean
      close: () => void
      location: { href: string; assign: (u: string) => boolean }
    }
    scheduleNavReport: () => void
    signalLoaded: () => void
    installLoadHook: () => void
  }
}

function win(): Win {
  return window as unknown as Win
}

describe("__cogniaSnapshot", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="go">Go</button>
      <input type="text" value="hi" />
      <a href="#">link</a>
    `
    install()
  })

  it("emits a generation + ref'd interactive nodes", () => {
    const parsed = JSON.parse(win().__cogniaSnapshot())
    expect(parsed.ok).toBe(true)
    expect(parsed.snapshot.generation).toBeGreaterThan(0)
    const roles = parsed.snapshot.nodes.map((n: { role: string }) => n.role)
    expect(roles).toEqual(expect.arrayContaining(["button", "textbox", "link"]))
    const button = parsed.snapshot.nodes.find((n: { role: string }) => n.role === "button")
    expect(button.name).toBe("Go")
    expect(typeof button.ref).toBe("string")
  })

  it("resolves a ref back to its element", () => {
    const parsed = JSON.parse(win().__cogniaSnapshot())
    const ref = parsed.snapshot.nodes[0].ref
    expect(win().__cogniaOverlay.resolveRef(ref)).toBeInstanceOf(HTMLElement)
  })
})

describe("__cogniaAct", () => {
  beforeEach(() => {
    document.body.innerHTML = `<input id="n" type="text" /><button id="b">B</button>`
    install()
  })
  function refFor(role: string) {
    const snap = JSON.parse(win().__cogniaSnapshot()).snapshot
    return snap.nodes.find((n: { role: string }) => n.role === role).ref
  }
  it("fills an input via the native setter and fires input/change", () => {
    const fired: string[] = []
    const input = document.getElementById("n") as HTMLInputElement
    input.addEventListener("input", () => fired.push("input"))
    input.addEventListener("change", () => fired.push("change"))
    const res = JSON.parse(
      win().__cogniaAct(refFor("textbox"), "fill", JSON.stringify({ text: "abc" }))
    )
    expect(res.ok).toBe(true)
    expect(input.value).toBe("abc")
    expect(fired).toEqual(["input", "change"])
  })
  it("clicks a button", () => {
    let clicked = false
    document.getElementById("b")!.addEventListener("click", () => (clicked = true))
    const res = JSON.parse(win().__cogniaAct(refFor("button"), "click", "{}"))
    expect(res.ok).toBe(true)
    expect(clicked).toBe(true)
  })
  it("returns an error for an unknown ref", () => {
    const res = JSON.parse(win().__cogniaAct("e999", "click", "{}"))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/ref/i)
  })

  it("applies modifier flags to a click", () => {
    let mods: { ctrl: boolean; shift: boolean } | null = null
    document.getElementById("b")!.addEventListener("click", (e) => {
      mods = { ctrl: (e as MouseEvent).ctrlKey, shift: (e as MouseEvent).shiftKey }
    })
    JSON.parse(
      win().__cogniaAct(refFor("button"), "click", JSON.stringify({ modifiers: ["ctrl", "shift"] }))
    )
    expect(mods).toEqual({ ctrl: true, shift: true })
  })
})

describe("__cogniaAct key", () => {
  beforeEach(() => {
    document.body.innerHTML = `<input id="n" type="text" />`
    install()
  })
  function refFor(role: string) {
    const snap = JSON.parse(win().__cogniaSnapshot()).snapshot
    return snap.nodes.find((n: { role: string }) => n.role === role).ref
  }

  it("dispatches a named key with keydown/keyup on the ref'd element", () => {
    const seen: Array<{ type: string; key: string }> = []
    const input = document.getElementById("n")!
    input.addEventListener("keydown", (e) =>
      seen.push({ type: "down", key: (e as KeyboardEvent).key })
    )
    input.addEventListener("keyup", (e) => seen.push({ type: "up", key: (e as KeyboardEvent).key }))
    const res = JSON.parse(
      win().__cogniaAct(refFor("textbox"), "key", JSON.stringify({ key: "Enter" }))
    )
    expect(res.ok).toBe(true)
    expect(seen).toEqual([
      { type: "down", key: "Enter" },
      { type: "up", key: "Enter" },
    ])
  })

  it("sets modifier flags for a chord", () => {
    let mod: { ctrl: boolean; key: string } | null = null
    document.addEventListener("keydown", (e) => {
      mod = { ctrl: (e as KeyboardEvent).ctrlKey, key: (e as KeyboardEvent).key }
    })
    JSON.parse(win().__cogniaAct("", "key", JSON.stringify({ key: "ctrl+a" })))
    expect(mod).toEqual({ ctrl: true, key: "a" })
  })

  it("emits keypress for a printable char without modifiers", () => {
    const types: string[] = []
    document.addEventListener("keypress", () => types.push("keypress"))
    JSON.parse(win().__cogniaAct("", "key", JSON.stringify({ key: "x" })))
    expect(types).toEqual(["keypress"])
  })

  it("returns an error for an unparseable chord", () => {
    const res = JSON.parse(win().__cogniaAct("", "key", JSON.stringify({ key: "ctrl+" })))
    expect(res.ok).toBe(false)
  })
})

describe("__cogniaAct scroll", () => {
  beforeEach(() => {
    document.body.innerHTML = `<button id="b">B</button>`
    install()
  })
  it("scrolls a ref'd element into view", () => {
    const snap = JSON.parse(win().__cogniaSnapshot()).snapshot
    const ref = snap.nodes[0].ref
    let scrolled = false
    ;(win().__cogniaOverlay.resolveRef(ref) as HTMLElement).scrollIntoView = () => {
      scrolled = true
    }
    const res = JSON.parse(win().__cogniaAct(ref, "scroll", "{}"))
    expect(res.ok).toBe(true)
    expect(scrolled).toBe(true)
  })
  it("page-scrolls by direction without a ref", () => {
    const calls: Array<[number, number]> = []
    ;(window as unknown as { scrollBy: (x: number, y: number) => void }).scrollBy = (x, y) =>
      calls.push([x, y])
    const res = JSON.parse(
      win().__cogniaAct("", "scroll", JSON.stringify({ direction: "down", amount: 300 }))
    )
    expect(res.ok).toBe(true)
    expect(calls).toEqual([[0, 300]])
  })
  it("rejects an unknown direction", () => {
    const res = JSON.parse(
      win().__cogniaAct("", "scroll", JSON.stringify({ direction: "sideways" }))
    )
    expect(res.ok).toBe(false)
  })
})

describe("parseKeyChord", () => {
  it("canonicalizes modifier aliases and a main key", () => {
    install()
    const chord = win().__cogniaOverlay.parseKeyChord("control+shift+t")
    expect(chord).toMatchObject({ ctrlKey: true, shiftKey: true, key: "t" })
  })
  it("maps named keys", () => {
    install()
    expect(win().__cogniaOverlay.parseKeyChord("pgdn")).toMatchObject({ key: "PageDown" })
    expect(win().__cogniaOverlay.parseKeyChord("F5")).toMatchObject({ key: "F5" })
  })
  it("throws on two main keys", () => {
    install()
    expect(() => win().__cogniaOverlay.parseKeyChord("a+b")).toThrow(/more than one/)
  })
})

describe("snapshot richness", () => {
  it("descends shadow DOM", () => {
    install()
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = host.attachShadow({ mode: "open" })
    root.innerHTML = `<button>Shadow Btn</button>`
    const snap = JSON.parse(win().__cogniaSnapshot()).snapshot
    const names = snap.nodes.map((n: { name: string }) => n.name)
    expect(names).toContain("Shadow Btn")
  })

  it("includes salient text only when includeText is set", () => {
    document.body.innerHTML = `<h1>Title Here</h1><button>Go</button>`
    install()
    const lean = JSON.parse(win().__cogniaSnapshot()).snapshot
    expect(lean.nodes.some((n: { role: string }) => n.role === "heading")).toBe(false)
    const rich = JSON.parse(win().__cogniaSnapshot(JSON.stringify({ includeText: true }))).snapshot
    const heading = rich.nodes.find((n: { role: string }) => n.role === "heading")
    expect(heading.name).toBe("Title Here")
  })
})

describe("hasSelector + networkState", () => {
  it("reports selector presence", () => {
    document.body.innerHTML = `<div class="ready"></div>`
    install()
    expect(win().__cogniaHasSelector(".ready")).toBe(true)
    expect(win().__cogniaHasSelector(".missing")).toBe(false)
  })

  it("tracks pending and completed fetch counts", async () => {
    install()
    let resolveFetch: (v: { status: number; ok: boolean }) => void = () => {}
    ;(window as unknown as { fetch: unknown }).fetch = () =>
      new Promise((r) => {
        resolveFetch = r
      })
    win().__cogniaOverlay.installNetworkHook()
    const p = (window as unknown as { fetch: () => Promise<unknown> }).fetch()
    expect(win().__cogniaOverlay.networkState().pending).toBe(1)
    resolveFetch({ status: 200, ok: true })
    await p
    const st = win().__cogniaOverlay.networkState()
    expect(st.pending).toBe(0)
    expect(st.completed).toBe(1)
  })
})

describe("console + network capture", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    install()
  })
  it("buffers console.error and drains it", () => {
    console.error("boom", 42)
    const entries = JSON.parse(win().__cogniaDrainConsole())
    const last = entries[entries.length - 1]
    expect(last.level).toBe("error")
    expect(last.text).toContain("boom")
    expect(JSON.parse(win().__cogniaDrainConsole())).toHaveLength(0)
  })
  it("detects visible page text via __cogniaHasText", () => {
    document.body.innerHTML = `<p>Loading complete</p>`
    install()
    expect(win().__cogniaHasText("Loading complete")).toBe(true)
    expect(win().__cogniaHasText("nope")).toBe(false)
  })

  it("records a fetch call", async () => {
    ;(window as unknown as { fetch: unknown }).fetch = () =>
      Promise.resolve({ status: 200, ok: true })
    win().__cogniaOverlay.installNetworkHook()
    await (window as unknown as { fetch: (u: string, i: unknown) => Promise<unknown> }).fetch(
      "https://x.test/api",
      { method: "POST" }
    )
    const net = JSON.parse(win().__cogniaDrainNetwork())
    expect(net[net.length - 1]).toMatchObject({
      url: "https://x.test/api",
      method: "POST",
      status: 200,
      ok: true,
    })
  })
})

describe("navigation plumbing", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    delete (window as unknown as Record<string, unknown>).__cogniaNavTo
    delete (window as unknown as Record<string, unknown>).__cogniaSignalNav
    install()
  })

  it("absoluteHttpUrl resolves relative urls and rejects non-http schemes", () => {
    const api = win().__cogniaOverlay
    expect(api.absoluteHttpUrl("/next")).toBe("http://localhost/next")
    expect(api.absoluteHttpUrl("https://example.com/a")).toBe("https://example.com/a")
    expect(api.absoluteHttpUrl("javascript:alert(1)")).toBeNull()
    expect(api.absoluteHttpUrl("file:///etc/passwd")).toBeNull()
  })

  it("window.open navigates in-view and returns a live stub", () => {
    const navTo = jest.fn()
    ;(window as unknown as Record<string, unknown>).__cogniaNavTo = navTo
    const stub = window.open("https://example.com/popup") as unknown as {
      closed: boolean
      close: () => void
      location: { href: string }
    }
    expect(navTo).toHaveBeenCalledWith("https://example.com/popup")
    expect(stub).not.toBeNull()
    // Deferred-popup pattern: writing the stub's location navigates in-view.
    stub.location.href = "https://example.com/deferred"
    expect(navTo).toHaveBeenCalledWith("https://example.com/deferred")
    stub.close()
    expect(stub.closed).toBe(true)
  })

  it("window.open without a url only returns the stub", () => {
    const navTo = jest.fn()
    ;(window as unknown as Record<string, unknown>).__cogniaNavTo = navTo
    const stub = window.open()
    expect(stub).not.toBeNull()
    expect(navTo).not.toHaveBeenCalled()
  })

  it("rewrites target=_blank anchor clicks to in-view navigation", () => {
    const navTo = jest.fn()
    ;(window as unknown as Record<string, unknown>).__cogniaNavTo = navTo
    document.body.innerHTML = `<a href="https://example.com/out" target="_blank"><span>out</span></a>`
    const span = document.querySelector("span")!
    span.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(navTo).toHaveBeenCalledWith("https://example.com/out")
  })

  it("leaves _blank clicks alone when the page already handled them", () => {
    const navTo = jest.fn()
    ;(window as unknown as Record<string, unknown>).__cogniaNavTo = navTo
    document.body.innerHTML = `<a href="https://example.com/out" target="_blank">out</a>`
    const a = document.querySelector("a")!
    a.addEventListener("click", (e) => e.preventDefault())
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(navTo).not.toHaveBeenCalled()
  })

  it("ignores normal (non-_blank) anchor clicks", () => {
    const navTo = jest.fn()
    ;(window as unknown as Record<string, unknown>).__cogniaNavTo = navTo
    document.body.innerHTML = `<a href="https://example.com/self">self</a>`
    document
      .querySelector("a")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(navTo).not.toHaveBeenCalled()
  })

  it("reports SPA pushState url changes (debounced, deduped)", () => {
    jest.useFakeTimers()
    try {
      const signal = jest.fn()
      ;(window as unknown as Record<string, unknown>).__cogniaSignalNav = signal
      window.history.pushState({}, "", "/spa-page")
      window.history.replaceState({}, "", "/spa-page-2")
      jest.advanceTimersByTime(200)
      expect(signal).toHaveBeenCalledTimes(1)
      expect(signal).toHaveBeenCalledWith({ url: "http://localhost/spa-page-2" })
      // No further URL change → no further report.
      jest.advanceTimersByTime(500)
      expect(signal).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("load-complete signal", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    delete (window as unknown as Record<string, unknown>).__cogniaLoadHookInstalled
    delete (window as unknown as Record<string, unknown>).__cogniaSignalLoaded
  })

  it("reports the page url once the document is already complete", () => {
    jest.useFakeTimers()
    try {
      const signal = jest.fn()
      ;(window as unknown as Record<string, unknown>).__cogniaSignalLoaded = signal
      // jsdom documents report readyState "complete" → immediate (deferred) fire.
      install()
      expect(signal).not.toHaveBeenCalled() // deferred a tick
      jest.advanceTimersByTime(1)
      expect(signal).toHaveBeenCalledWith({ url: window.location.href })
    } finally {
      jest.useRealTimers()
    }
  })

  it("waits for the window load event while the document is still loading", () => {
    jest.useFakeTimers()
    const readyState = Object.getOwnPropertyDescriptor(Document.prototype, "readyState")
    try {
      Object.defineProperty(document, "readyState", { value: "loading", configurable: true })
      const signal = jest.fn()
      ;(window as unknown as Record<string, unknown>).__cogniaSignalLoaded = signal
      install()
      jest.advanceTimersByTime(1)
      expect(signal).not.toHaveBeenCalled() // not loaded yet
      window.dispatchEvent(new Event("load"))
      jest.advanceTimersByTime(1)
      expect(signal).toHaveBeenCalledWith({ url: window.location.href })
    } finally {
      if (readyState) Object.defineProperty(document, "readyState", readyState)
      else delete (document as unknown as Record<string, unknown>).readyState
      jest.useRealTimers()
    }
  })

  it("installs the window load listener only once per document", () => {
    const addSpy = jest.spyOn(window, "addEventListener")
    try {
      Object.defineProperty(document, "readyState", { value: "loading", configurable: true })
      install()
      install() // second init-script run against the same window
      const loadListeners = addSpy.mock.calls.filter(([type]) => (type as string) === "load")
      expect(loadListeners).toHaveLength(1)
    } finally {
      addSpy.mockRestore()
      Object.defineProperty(document, "readyState", { value: "complete", configurable: true })
    }
  })
})

// --- Component-aware enrichment (React fiber) -------------------------------

type Fiber = {
  type: unknown
  memoizedProps?: Record<string, unknown>
  return: Fiber | null
}
type RichOverlay = {
  buildPayload: (el: Element) => Record<string, unknown>
  componentInfo: (
    el: Element
  ) => { name: string | null; stack: string | null; props: Record<string, string> | null } | null
  shallowProps: (props: unknown) => Record<string, string> | null
  readSourceHint: (el: Element) => { path: string; line: number; column?: number } | null
  showSelection: (el: Element, payload: unknown) => void
  clearSelection: () => void
  selectedElement: () => Element | null
}
const rich = () => install() as unknown as RichOverlay

/** Attach a fake React fiber to a DOM node the way React does (`__reactFiber$…`). */
function attachFiber(el: Element, fiber: Fiber) {
  ;(el as unknown as Record<string, unknown>)["__reactFiber$test"] = fiber
}

function fiberChain(el: Element) {
  const app: Fiber = { type: function App() {}, memoizedProps: {}, return: null }
  const form: Fiber = { type: function CheckoutForm() {}, memoizedProps: {}, return: app }
  const submit: Fiber = {
    type: function SubmitButton() {},
    memoizedProps: {
      variant: "primary",
      disabled: false,
      label: "提交订单",
      onClick: () => {},
      user: { id: 1 },
    },
    return: form,
  }
  const host: Fiber = { type: "button", memoizedProps: { className: "btn" }, return: submit }
  attachFiber(el, host)
}

describe("overlay.injected componentInfo", () => {
  it("walks the fiber tree for the owning component name, stack and shallow props", () => {
    document.body.innerHTML = `<button id="go">go</button>`
    const api = rich()
    const btn = document.getElementById("go")!
    fiberChain(btn)
    const info = api.componentInfo(btn)!
    expect(info.name).toBe("SubmitButton")
    expect(info.stack).toBe("App > CheckoutForm > SubmitButton")
    // functions + React elements dropped; nested object flattened to a marker.
    expect(info.props).toEqual({
      variant: "primary",
      disabled: "false",
      label: "提交订单",
      user: "[Object]",
    })
  })

  it("resolves memo / forwardRef display names", () => {
    document.body.innerHTML = `<span id="x">x</span>`
    const api = rich()
    const el = document.getElementById("x")!
    const inner = { displayName: "Fancy" }
    attachFiber(el, { type: { $$typeof: Symbol.for("react.memo"), type: inner }, return: null })
    expect(api.componentInfo(el)!.name).toBe("Fancy")
  })

  it("returns null when the node has no fiber (non-React page)", () => {
    document.body.innerHTML = `<button id="go">go</button>`
    const api = rich()
    expect(api.componentInfo(document.getElementById("go")!)).toBeNull()
  })
})

describe("overlay.injected shallowProps", () => {
  it("caps the number of keys and truncates long values", () => {
    const api = rich()
    const props: Record<string, unknown> = { long: "x".repeat(200) }
    for (let i = 0; i < 20; i++) props["k" + i] = i
    const out = api.shallowProps(props)!
    expect(Object.keys(out).length).toBeLessThanOrEqual(10)
    expect((out.long as string).length).toBeLessThanOrEqual(81) // 80 + ellipsis
  })

  it("drops children, functions and React elements", () => {
    const api = rich()
    const out = api.shallowProps({
      children: "ignored",
      onClick: () => {},
      node: { $$typeof: Symbol.for("react.element") },
      keep: 3,
    })
    expect(out).toEqual({ keep: "3" })
  })
})

describe("overlay.injected readSourceHint", () => {
  it("reads react-dev-inspector attributes off the node", () => {
    document.body.innerHTML = `<button id="go" data-inspector-relative-path="src/App.tsx" data-inspector-line="42" data-inspector-column="6">go</button>`
    const api = rich()
    expect(api.readSourceHint(document.getElementById("go")!)).toEqual({
      path: "src/App.tsx",
      line: 42,
      column: 6,
    })
  })

  it("falls back to a near ancestor and omits a missing column", () => {
    document.body.innerHTML = `<div data-inspector-relative-path="src/Card.tsx" data-inspector-line="7"><button id="go">go</button></div>`
    const api = rich()
    expect(api.readSourceHint(document.getElementById("go")!)).toEqual({
      path: "src/Card.tsx",
      line: 7,
    })
  })

  it("returns null when no inspector attributes are present", () => {
    document.body.innerHTML = `<button id="go">go</button>`
    const api = rich()
    expect(api.readSourceHint(document.getElementById("go")!)).toBeNull()
  })
})

describe("overlay.injected buildPayload enrichment", () => {
  it("attaches component fields + framework when a fiber is present", () => {
    document.body.innerHTML = `<button id="go">go</button>`
    const api = rich()
    const btn = document.getElementById("go")!
    fiberChain(btn)
    const payload = api.buildPayload(btn)
    expect(payload.componentName).toBe("SubmitButton")
    expect(payload.componentStack).toBe("App > CheckoutForm > SubmitButton")
    expect(payload.framework).toBe("react")
    expect(payload.props).toMatchObject({ variant: "primary" })
  })

  it("omits component fields on a non-React node", () => {
    document.body.innerHTML = `<button id="go">go</button>`
    const api = rich()
    const payload = api.buildPayload(document.getElementById("go")!)
    expect(payload.componentName).toBeUndefined()
    expect(payload.framework).toBeUndefined()
  })
})

// --- In-page info panel ----------------------------------------------------

const PANEL = "#__cognia-info-panel"
const BOX = "#__cognia-select-box"

describe("overlay.injected info panel", () => {
  it("draws the selection box + basic panel on pick, and clears it", () => {
    document.body.innerHTML = `<button id="go">go</button>`
    const api = rich()
    ;(window as unknown as { __cogniaSignal: () => void }).__cogniaSignal = () => {}
    const btn = document.getElementById("go")!
    fiberChain(btn)
    ;(window as unknown as { __cogniaSetSelectMode: (on: boolean) => void }).__cogniaSetSelectMode(
      true
    )
    btn.click()

    const panel = document.querySelector(PANEL)!
    expect(panel).toBeTruthy()
    expect(document.querySelector(BOX)).toBeTruthy()
    expect(panel.textContent).toContain("<SubmitButton>")
    // Basic view: no detail lines yet.
    expect(panel.textContent).not.toContain("selector:")

    ;(window as unknown as { __cogniaClearSelection: () => void }).__cogniaClearSelection()
    expect(document.querySelector(PANEL)).toBeNull()
    expect(document.querySelector(BOX)).toBeNull()
    expect(api.selectedElement()).toBeNull()
  })

  it("expands to detailed fields when the toggle is clicked", () => {
    document.body.innerHTML = `<button id="go">go</button>`
    rich()
    ;(window as unknown as { __cogniaSignal: () => void }).__cogniaSignal = () => {}
    const btn = document.getElementById("go")!
    fiberChain(btn)
    ;(window as unknown as { __cogniaSetSelectMode: (on: boolean) => void }).__cogniaSetSelectMode(
      true
    )
    btn.click()

    const toggle = document.querySelector("[data-cognia-toggle]") as HTMLButtonElement
    toggle.click()
    const panel = document.querySelector(PANEL)!
    expect(panel.textContent).toContain("selector:")
    expect(panel.textContent).toContain("stack:")
    expect(panel.textContent).toContain("props:")
  })

  it("shows localized toggle labels once React pushes them", () => {
    document.body.innerHTML = `<button id="go">go</button>`
    const api = rich()
    api.showSelection(document.getElementById("go")!, {
      tagName: "button",
      selector: "#go",
      rect: { width: 10, height: 10 },
    })
    // Pre-label fallback is the bare chevron.
    expect(document.querySelector("[data-cognia-toggle]")!.textContent).toBe("▾")
    ;(window as unknown as { __cogniaSetPanelLabels: (j: string) => void }).__cogniaSetPanelLabels(
      JSON.stringify({ details: "详情", collapse: "收起" })
    )
    expect(document.querySelector("[data-cognia-toggle]")!.textContent).toContain("详情")
  })

  it("drops the overlay when the tracked element unmounts, on the next scroll", () => {
    const raf = jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0)
        return 0
      })
    try {
      document.body.innerHTML = `<button id="go">go</button>`
      const api = rich()
      api.showSelection(document.getElementById("go")!, {
        tagName: "button",
        selector: "#go",
        rect: { width: 10, height: 10 },
      })
      expect(document.querySelector(BOX)).toBeTruthy()
      // Element unmounts, then a scroll fires: the stale overlay is torn down.
      document.body.innerHTML = ""
      document.dispatchEvent(new Event("scroll", { bubbles: true }))
      expect(api.selectedElement()).toBeNull()
      expect(document.querySelector(BOX)).toBeNull()
    } finally {
      raf.mockRestore()
    }
  })

  it("never selects overlay chrome while picking", () => {
    document.body.innerHTML = `<div data-cognia-chrome="1"><button id="chrome-btn">x</button></div><button id="go">go</button>`
    rich()
    const received: unknown[] = []
    ;(window as unknown as { __cogniaSignal: (p: unknown) => void }).__cogniaSignal = (p) =>
      received.push(p)
    ;(window as unknown as { __cogniaSetSelectMode: (on: boolean) => void }).__cogniaSetSelectMode(
      true
    )
    // A click inside our own chrome is ignored…
    document.getElementById("chrome-btn")!.click()
    expect(received).toHaveLength(0)
    // …a real element still emits.
    document.getElementById("go")!.click()
    expect(received).toHaveLength(1)
  })
})
