/** @jest-environment jsdom */
import {
  mainEvaluate,
  mainHooksCall,
  mainSetDialogPolicy,
  pageAct,
  pageOverlayAbi,
  pageActingBar,
  pageDrag,
  pageElementRect,
  pageFind,
  pageHas,
  pageScrollMetrics,
  pageScrollTo,
  pageSetFiles,
  pageSnapshot,
  pageStopLoading,
  pageStorage,
} from "./page-functions"

type OverlayGlobals = Record<string, unknown>
const globals = window as unknown as OverlayGlobals

it("reports only an explicit integer overlay ABI", () => {
  delete globals.__cogniaOverlay
  expect(pageOverlayAbi()).toBeNull()
  globals.__cogniaOverlay = { abi: 1 }
  expect(pageOverlayAbi()).toBe(1)
  globals.__cogniaOverlay = { abi: "1" }
  expect(pageOverlayAbi()).toBeNull()
})

function withOverlay(refs: Record<string, Element>) {
  globals.__cogniaSnapshot = (opts: string) =>
    JSON.stringify({ ok: true, error: null, snapshot: { opts } })
  globals.__cogniaAct = (ref: string, action: string, args: string) =>
    JSON.stringify({ ok: true, ref, action, args: JSON.parse(args) })
  globals.__cogniaHasText = (text: string) => document.body.textContent?.includes(text) ?? false
  globals.__cogniaHasSelector = () => {
    throw new Error("bad selector")
  }
  globals.__cogniaFind = (query: string) => ({ matches: query.length, index: 0 })
  globals.__cogniaFindClear = jest.fn()
  globals.__cogniaOverlay = { resolveRef: (ref: string) => refs[ref] ?? null }
}

afterEach(() => {
  for (const key of Object.keys(globals)) if (key.startsWith("__cognia")) delete globals[key]
  document.body.innerHTML = ""
  document.documentElement.querySelector("#__cognia-acting-bar")?.remove()
})

describe("overlay calls", () => {
  it("answer overlay_missing before the overlay is injected", () => {
    expect(pageSnapshot("{}")).toEqual({ ok: false, error: "overlay_missing", snapshot: null })
    expect(pageAct("r1", "click", "{}")).toEqual({
      ok: false,
      error: "overlay_missing",
      generation: 0,
    })
    expect(pageHas("text", "x")).toBeNull()
    expect(pageFind("x", null)).toEqual({ matches: 0, index: -1 })
  })

  it("pass through to the overlay", () => {
    withOverlay({})
    document.body.innerHTML = "<p>Hello</p>"
    expect(pageSnapshot('{"a":1}')).toEqual({
      ok: true,
      error: null,
      snapshot: { opts: '{"a":1}' },
    })
    expect(pageAct("r1", "type", '{"text":"x"}')).toEqual({
      ok: true,
      ref: "r1",
      action: "type",
      args: { text: "x" },
    })
    expect(pageHas("text", "Hello")).toBe(true)
    expect(pageHas("selector", "[")).toBe(false)
    expect(pageFind("abc", null)).toEqual({ matches: 3, index: 0 })
    expect(pageFind(null, null)).toBeNull()
    expect(globals.__cogniaFindClear).toHaveBeenCalled()
  })
})

describe("element work", () => {
  it("drags from one ref onto another with a shared data transfer", () => {
    const source = document.createElement("div")
    const target = document.createElement("div")
    document.body.append(source, target)
    withOverlay({ a: source, b: target })
    // jsdom has neither DataTransfer nor DragEvent.
    ;(globalThis as { DataTransfer?: unknown }).DataTransfer = class {
      items = { add: () => undefined }
      files = []
    }
    ;(globalThis as { DragEvent?: unknown }).DragEvent = class extends Event {}
    const events: string[] = []
    for (const type of ["dragstart", "dragend"])
      source.addEventListener(type, () => events.push(`a:${type}`))
    for (const type of ["dragenter", "dragover", "drop"])
      target.addEventListener(type, () => events.push(`b:${type}`))
    expect(pageDrag("a", "b")).toEqual({ ok: true, error: null })
    expect(events).toEqual(["a:dragstart", "b:dragenter", "b:dragover", "b:drop", "a:dragend"])
    expect(pageDrag("a", "zzz")).toEqual({ ok: false, error: "unknown ref: zzz" })
  })

  it("puts files only into a file input, and one file into a single input", () => {
    const input = document.createElement("input")
    input.type = "file"
    const text = document.createElement("input")
    document.body.append(input, text)
    withOverlay({ file: input, text })
    const added: File[] = []
    ;(globalThis as { DataTransfer?: unknown }).DataTransfer = class {
      items = { add: (file: File) => added.push(file) }
      get files() {
        return added
      }
    }
    Object.defineProperty(input, "files", {
      configurable: true,
      set: () => undefined,
      get: () => added,
    })
    const changes: string[] = []
    input.addEventListener("change", () => changes.push("change"))
    const file = { name: "a.txt", mediaType: "text/plain", dataBase64: btoa("hi") }
    expect(pageSetFiles("text", [file])).toEqual({
      ok: false,
      error: "the element is not a file input",
    })
    expect(pageSetFiles("file", [file, file])).toEqual({
      ok: false,
      error: "this file input accepts one file",
    })
    expect(pageSetFiles("file", [file])).toEqual({ ok: true, error: null })
    expect(added.map((entry) => [entry.name, entry.type])).toEqual([["a.txt", "text/plain"]])
    expect(changes).toEqual(["change"])
    expect(pageSetFiles("gone", [file])).toEqual({ ok: false, error: "unknown ref: gone" })
  })

  it("measures an element after scrolling it into view", () => {
    const element = document.createElement("div")
    element.scrollIntoView = jest.fn()
    element.getBoundingClientRect = () => ({ left: 1, top: 2, width: 3, height: 4 }) as DOMRect
    withOverlay({ e: element })
    expect(pageElementRect("e")).toEqual({ x: 1, y: 2, width: 3, height: 4, dpr: 1 })
    expect(element.scrollIntoView).toHaveBeenCalled()
    expect(pageElementRect("none")).toBeNull()
  })
})

describe("page state", () => {
  it("reports scroll metrics and scrolls", () => {
    window.scrollTo = jest.fn() as never
    expect(pageScrollMetrics()).toMatchObject({
      viewportWidth: window.innerWidth,
      scrollY: 0,
      dpr: 1,
    })
    expect(pageScrollTo(100)).toBe(window.scrollY)
    expect(window.scrollTo).toHaveBeenCalledWith(0, 100)
  })

  it("reads, writes and clears web storage", () => {
    localStorage.clear()
    expect(pageStorage("set", "local", "a", "1")).toMatchObject({ ok: true, entries: { a: "1" } })
    expect(pageStorage("get", "local", "a", null)).toMatchObject({
      entries: { a: "1" },
      exists: true,
    })
    expect(pageStorage("get", "local", "b", null)).toMatchObject({
      entries: { b: null },
      exists: false,
    })
    expect(pageStorage("get", "local", null, null)).toMatchObject({ entries: { a: "1" } })
    expect(pageStorage("clear", "local", null, null)).toMatchObject({ ok: true, entries: {} })
    expect(localStorage.length).toBe(0)
    expect(pageStorage("get", "session", null, null).origin).toBe(location.origin)
  })

  it("stops loading", () => {
    window.stop = jest.fn()
    expect(pageStopLoading()).toBe(true)
    expect(window.stop).toHaveBeenCalled()
  })
})

describe("main world", () => {
  it("answers neutral values without the hooks, and calls them once installed", () => {
    expect(mainHooksCall("networkState")).toEqual({ pending: 0, completed: 0 })
    expect(mainHooksCall("lastDialog")).toBeNull()
    expect(mainHooksCall("drainConsole")).toEqual([])
    expect(mainSetDialogPolicy({ accept: true })).toBe(false)
    const setDialogPolicy = jest.fn()
    globals.__cogniaPageHooks = {
      drainConsole: () => ["line"],
      drainNetwork: () => [],
      networkState: () => ({ pending: 1, completed: 2 }),
      setDialogPolicy,
      lastDialog: () => ({ type: "alert" }),
    }
    expect(mainHooksCall("drainConsole")).toEqual(["line"])
    expect(mainSetDialogPolicy({ accept: false, promptText: "x" })).toBe(true)
    expect(setDialogPolicy).toHaveBeenCalledWith({ accept: false, promptText: "x" })
  })

  it("evaluates to JSON, describing what JSON cannot carry", () => {
    expect(mainEvaluate("1 + 1")).toEqual({ ok: true, value: 2 })
    expect(mainEvaluate("undefined")).toEqual({ ok: true, value: null })
    const value = mainEvaluate(
      "(() => { const a = { n: 10n, f: function named() {}, el: document.body }; a.self = a; return a })()"
    )
    expect(value).toEqual({
      ok: true,
      value: { n: "10", f: "[function named]", el: "[element body]", self: "[circular]" },
    })
    expect(mainEvaluate("throw new Error('boom')")).toMatchObject({ ok: false })
    expect(mainEvaluate("(() => { throw new Error('inner') })()")).toMatchObject({
      ok: false,
      error: "Error: inner",
    })
  })

  it("names a refusal by the page's content security policy", () => {
    const original = globalThis.Function
    ;(globalThis as { Function: unknown }).Function = function () {
      throw new EvalError(
        "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not allowed"
      )
    }
    try {
      expect(mainEvaluate("1")).toMatchObject({
        ok: false,
        code: "browser_evaluate_blocked_by_csp",
      })
    } finally {
      ;(globalThis as { Function: unknown }).Function = original
    }
  })
})

describe("pageActingBar", () => {
  const labels = {
    acting: "Acting",
    paused: "Paused",
    stop: "Stop",
    takeOver: "Take over",
    resume: "Resume",
  }

  it("shows, updates and removes one bar, sending only a person's clicks", () => {
    const sendMessage = jest.fn(async () => undefined)
    ;(globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } }
    const shadows: ShadowRoot[] = []
    const attach = HTMLElement.prototype.attachShadow
    HTMLElement.prototype.attachShadow = function (init) {
      const root = attach.call(this, { ...init, mode: "open" })
      shadows.push(root)
      return root
    }
    try {
      expect(pageActingBar({ session: "s1", takenOver: false, labels })).toBe(true)
      expect(pageActingBar({ session: "s1", takenOver: true, labels })).toBe(true)
      expect(document.querySelectorAll("#__cognia-acting-bar")).toHaveLength(1)
      expect(shadows).toHaveLength(1)
      const buttons = shadows[0]!.querySelectorAll("button")
      expect(shadows[0]!.textContent).toContain("Paused")
      // A synthetic click — the page's, or the agent's own — is ignored; only
      // a trusted click from the person messages the worker, which jsdom
      // cannot produce.
      buttons[0]!.click()
      buttons[1]!.click()
      expect(sendMessage).not.toHaveBeenCalled()
      expect(pageActingBar(null)).toBe(true)
      expect(document.querySelector("#__cognia-acting-bar")).toBeNull()
    } finally {
      HTMLElement.prototype.attachShadow = attach
      delete (globalThis as { chrome?: unknown }).chrome
    }
  })
})
