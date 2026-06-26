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
