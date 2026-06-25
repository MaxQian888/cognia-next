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
  __cogniaSnapshot: () => string
  __cogniaAct: (ref: string, action: string, argsJson: string) => string
  __cogniaDrainConsole: () => string
  __cogniaDrainNetwork: () => string
  __cogniaOverlay: { resolveRef: (ref: string) => unknown; installNetworkHook: () => void }
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
