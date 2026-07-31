/**
 * @jest-environment jsdom
 *
 * Exercises the action-recording half of the real injected overlay file (the
 * same bytes Rust `include_str!`s). Lives apart from `overlay.injected.test.ts`
 * because the recording listeners are document-wide and install exactly once
 * (guarded by `__cogniaRecordInstalled`): a second `install()` in the same
 * jsdom window hands back a *different* closure whose buffer the already-
 * attached listeners never write to, so the tests would silently observe an
 * empty recording. One file, one install, one closure.
 */
import fs from "node:fs"
import path from "node:path"

const CODE = fs.readFileSync(path.join(__dirname, "overlay.injected.js"), "utf8")

const FLAG_KEY = "__cognia_recording"
const STEPS_KEY = "__cognia_record_steps"

type Target = { selector: string; role: string | null; name: string | null; domPath: string | null }
type Step = {
  act: string
  at: number
  target?: Target
  value?: string
  secret?: boolean
  key?: string
  modifiers?: string[]
  direction?: string
  amount?: number
}

type RecordApi = {
  startRecord: () => void
  stopRecord: () => void
  drainRecord: () => string
  restoreRecord: () => void
  isRecording: () => boolean
  recordedSteps: () => Step[]
  recordTarget: (el: Element) => Target
}

function install(): RecordApi {
  delete (window as unknown as Record<string, unknown>).__cogniaOverlayInstalled
  ;(0, eval)(CODE)
  return (window as unknown as { __cogniaOverlay: RecordApi }).__cogniaOverlay
}

const api = install()

function click(el: Element, init: MouseEventInit = {}) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }))
}

function doubleClick(el: Element, init: MouseEventInit = {}) {
  click(el, init)
  click(el, init)
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, ...init }))
}

function hover(el: Element) {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
}

function wheel(el: Element, init: WheelEventInit) {
  el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ...init }))
}

function change(el: Element) {
  el.dispatchEvent(new Event("change", { bubbles: true }))
}

/** A keystroke, which fires per character while the field is still masked. */
function input(el: Element) {
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

function focusin(el: Element) {
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
}

function keydown(el: Element, init: KeyboardEventInit) {
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }))
}

beforeEach(() => {
  document.body.innerHTML = ""
  window.sessionStorage.clear()
  api.startRecord()
})

afterEach(() => {
  api.stopRecord()
})

describe("recordTarget", () => {
  it("captures the selector, role and accessible name", () => {
    document.body.innerHTML = `<main id="root"><button>Sign in</button></main>`
    const target = api.recordTarget(document.querySelector("button")!)
    expect(target).toEqual({
      selector: "#root > button",
      role: "button",
      name: "Sign in",
      domPath: "main#root > button",
    })
  })

  it("nulls a role the element does not map to, so exports fall back to css", () => {
    document.body.innerHTML = `<div id="plain">text</div>`
    const target = api.recordTarget(document.querySelector("#plain")!)
    expect(target.role).toBeNull()
  })

  it("reads an input's name from its placeholder", () => {
    document.body.innerHTML = `<input id="email" placeholder="Email" />`
    const target = api.recordTarget(document.querySelector("#email")!)
    expect(target).toMatchObject({ role: "textbox", name: "Email", selector: "#email" })
  })
})

describe("arming", () => {
  it("records nothing before start", () => {
    api.stopRecord()
    document.body.innerHTML = `<button>go</button>`
    click(document.querySelector("button")!)
    expect(api.recordedSteps()).toEqual([])
  })

  it("reports its armed state", () => {
    expect(api.isRecording()).toBe(true)
    api.stopRecord()
    expect(api.isRecording()).toBe(false)
  })

  it("clears the previous take on start", () => {
    document.body.innerHTML = `<button>go</button>`
    click(document.querySelector("button")!)
    expect(api.recordedSteps()).toHaveLength(1)
    api.startRecord()
    expect(api.recordedSteps()).toEqual([])
  })
})

describe("click capture", () => {
  it("records a click with its target", () => {
    document.body.innerHTML = `<button>Sign in</button>`
    click(document.querySelector("button")!)
    const steps = api.recordedSteps()
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ act: "click", target: { role: "button", name: "Sign in" } })
  })

  it("records held modifiers", () => {
    document.body.innerHTML = `<button>go</button>`
    click(document.querySelector("button")!, { ctrlKey: true, shiftKey: true })
    expect(api.recordedSteps()[0].modifiers).toEqual(["ctrl", "shift"])
  })

  it("omits modifiers when none were held", () => {
    document.body.innerHTML = `<button>go</button>`
    click(document.querySelector("button")!)
    expect(api.recordedSteps()[0].modifiers).toBeUndefined()
  })

  it("ignores a click on our own overlay chrome", () => {
    document.body.innerHTML = `<div data-cognia-chrome><button>details</button></div>`
    click(document.querySelector("button")!)
    expect(api.recordedSteps()).toEqual([])
  })

  it("does not record the pick while select mode owns the click", () => {
    document.body.innerHTML = `<button>go</button>`
    ;(window as unknown as { __cogniaSetSelectMode: (on: boolean) => void }).__cogniaSetSelectMode(
      true
    )
    click(document.querySelector("button")!)
    ;(window as unknown as { __cogniaSetSelectMode: (on: boolean) => void }).__cogniaSetSelectMode(
      false
    )
    expect(api.recordedSteps()).toEqual([])
  })

  it("does not record a click on a select — its change step already covers it", () => {
    document.body.innerHTML = `<select><option value="a">A</option></select>`
    click(document.querySelector("select")!)
    expect(api.recordedSteps()).toEqual([])
  })

  it("shows a pointer at the click coordinates", () => {
    document.body.innerHTML = `<button>go</button>`
    click(document.querySelector("button")!, { clientX: 120, clientY: 80 })

    const pointer = document.querySelector<HTMLElement>("#__cognia-click-pointer")
    expect(pointer).not.toBeNull()
    expect(pointer).toHaveStyle({ left: "120px", top: "80px" })
  })

  it("collapses the native click-click-dblclick sequence into one double click", () => {
    document.body.innerHTML = `<button>Open</button>`
    doubleClick(document.querySelector("button")!)

    expect(api.recordedSteps()).toHaveLength(1)
    expect(api.recordedSteps()[0]).toMatchObject({
      act: "double_click",
      target: { role: "button", name: "Open" },
    })
  })
})

describe("pointer and scroll capture", () => {
  it("records hover targets without duplicating a consecutive hover", () => {
    document.body.innerHTML = `<button>Preview</button>`
    const button = document.querySelector("button")!
    hover(button)
    hover(button)

    expect(api.recordedSteps()).toHaveLength(1)
    expect(api.recordedSteps()[0]).toMatchObject({
      act: "hover",
      target: { role: "button", name: "Preview" },
    })
  })

  it("records vertical and horizontal wheel gestures", () => {
    document.body.innerHTML = `<main>Content</main>`
    const main = document.querySelector("main")!
    wheel(main, { deltaY: 180 })
    wheel(main, { deltaX: -60 })

    expect(api.recordedSteps()).toEqual([
      expect.objectContaining({ act: "scroll", direction: "down", amount: 180 }),
      expect.objectContaining({ act: "scroll", direction: "left", amount: 60 }),
    ])
  })
})

describe("value capture", () => {
  it("records the settled value of a text input", () => {
    document.body.innerHTML = `<input id="email" placeholder="Email" />`
    const input = document.querySelector("input")!
    input.value = "a@b.c"
    change(input)
    expect(api.recordedSteps()[0]).toMatchObject({ act: "fill", value: "a@b.c" })
  })

  it("records a textarea", () => {
    document.body.innerHTML = `<textarea id="bio"></textarea>`
    const area = document.querySelector("textarea")!
    area.value = "hello"
    change(area)
    expect(api.recordedSteps()[0]).toMatchObject({ act: "fill", value: "hello" })
  })

  it("records a select's chosen value", () => {
    document.body.innerHTML = `<select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>`
    const select = document.querySelector("select")!
    select.value = "pro"
    change(select)
    expect(api.recordedSteps()[0]).toMatchObject({ act: "select", value: "pro" })
  })

  it("skips a checkbox — the click step already carries the state change", () => {
    document.body.innerHTML = `<input type="checkbox" id="tos" />`
    change(document.querySelector("input")!)
    expect(api.recordedSteps().filter((s) => s.act === "fill")).toEqual([])
  })

  it("skips a radio for the same reason", () => {
    document.body.innerHTML = `<input type="radio" id="r" />`
    change(document.querySelector("input")!)
    expect(api.recordedSteps().filter((s) => s.act === "fill")).toEqual([])
  })

  it("skips a file input — a synthetic event can never replay it", () => {
    document.body.innerHTML = `<input type="file" id="upload" />`
    change(document.querySelector("input")!)
    expect(api.recordedSteps()).toEqual([])
  })

  it("ignores a change on a non-field element", () => {
    document.body.innerHTML = `<div id="d"></div>`
    change(document.querySelector("#d")!)
    expect(api.recordedSteps()).toEqual([])
  })
})

// The single most security-relevant behavior here: a recorded flow is persisted
// to Dexie and its agent export is written into a model prompt.
describe("password capture", () => {
  it("flags the field but never captures its value", () => {
    document.body.innerHTML = `<input type="password" id="pw" placeholder="Password" />`
    const input = document.querySelector("input")!
    input.value = "hunter2"
    change(input)
    const step = api.recordedSteps()[0]
    expect(step).toMatchObject({ act: "fill", secret: true, value: "" })
    expect(JSON.stringify(step)).not.toContain("hunter2")
  })

  it("keeps the credential out of sessionStorage too", () => {
    document.body.innerHTML = `<input type="password" id="pw" />`
    const input = document.querySelector("input")!
    input.value = "hunter2"
    change(input)
    expect(window.sessionStorage.getItem(STEPS_KEY)).not.toContain("hunter2")
  })

  it("does not flag a normal text field as secret", () => {
    document.body.innerHTML = `<input type="text" id="email" />`
    const field = document.querySelector("input")!
    field.value = "a@b.c"
    change(field)
    expect(api.recordedSteps()[0].secret).toBeUndefined()
  })

  // `change` fires on BLUR, so reading the live `type` there sees whatever the
  // reveal toggle left behind — by then the field says `text` and the value is
  // the real password.
  it("stays secret after a reveal toggle flips the field to type=text", () => {
    document.body.innerHTML = `<input type="password" id="pw" />`
    const field = document.querySelector("input")!
    // Typed while still masked — this is the only moment secrecy is observable.
    field.value = "hunter2-REAL"
    input(field)
    // The eye icon: sites set `type="text"`, which reflects to the attribute.
    field.setAttribute("type", "text")
    field.value = "hunter2-REAL-PASSWORD"
    change(field)
    const step = api.recordedSteps()[0]
    expect(step).toMatchObject({ act: "fill", secret: true, value: "" })
    expect(window.sessionStorage.getItem(STEPS_KEY)).not.toContain("hunter2")
  })

  it("latches on focus alone, before any reveal can happen", () => {
    document.body.innerHTML = `<input type="password" id="pw" />`
    const field = document.querySelector("input")!
    focusin(field)
    field.setAttribute("type", "text")
    field.value = "hunter2-REAL-PASSWORD"
    change(field)
    expect(api.recordedSteps()[0]).toMatchObject({ secret: true, value: "" })
    expect(window.sessionStorage.getItem(STEPS_KEY)).not.toContain("hunter2")
  })

  // `autocomplete` is a space-separated token list and is case-insensitive.
  it.each([
    "current-password",
    "new-password",
    "section-blue current-password",
    "billing shipping new-password",
    "CURRENT-PASSWORD",
    "one-time-code",
  ])("treats a text field autocompleted as %s as secret", (autocomplete) => {
    document.body.innerHTML = `<input type="text" id="pw" autocomplete="${autocomplete}" />`
    const field = document.querySelector("input")!
    field.value = "hunter2-REAL-PASSWORD"
    change(field)
    expect(api.recordedSteps()[0]).toMatchObject({ act: "fill", secret: true, value: "" })
    expect(window.sessionStorage.getItem(STEPS_KEY)).not.toContain("hunter2")
  })

  it.each([
    ['name="otp"', "otp"],
    ['id="verification-code"', "verification-code"],
    ['aria-label="Access token"', "Access token"],
  ])("redacts and visually masks credential-like field %s", (attribute) => {
    document.body.innerHTML = `<input type="text" ${attribute} />`
    const field = document.querySelector("input")!
    focusin(field)
    field.value = "credential-value"
    change(field)
    expect(field).toHaveAttribute("data-cognia-secret", "1")
    expect(api.recordedSteps()[0]).toMatchObject({ act: "fill", secret: true, value: "" })
    expect(document.getElementById("__cognia-credential-mask")?.textContent).toContain(
      "-webkit-text-security:disc"
    )
  })

  it("still flags a field switched to password via the JS property", () => {
    document.body.innerHTML = `<input type="text" id="pw" />`
    const field = document.querySelector("input")!
    field.type = "password"
    field.value = "hunter2-REAL-PASSWORD"
    change(field)
    expect(api.recordedSteps()[0]).toMatchObject({ act: "fill", secret: true, value: "" })
  })

  // Over-latching is not a safe failure: it would silently blank ordinary fields
  // and break replay of every flow that fills one.
  it("does not latch an ordinary field that was merely typed into", () => {
    document.body.innerHTML = `<input type="text" id="email" autocomplete="username" />`
    const field = document.querySelector("input")!
    focusin(field)
    field.value = "a@b.c"
    input(field)
    change(field)
    const step = api.recordedSteps()[0]
    expect(step).toMatchObject({ act: "fill", value: "a@b.c" })
    expect(step.secret).toBeUndefined()
  })
})

describe("key capture", () => {
  it.each(["Enter", "Tab", "Escape", "ArrowDown"])("records the bare %s key", (key) => {
    document.body.innerHTML = `<input id="q" />`
    keydown(document.querySelector("input")!, { key })
    expect(api.recordedSteps()[0]).toMatchObject({ act: "press_key", key })
  })

  it("ignores plain typing — the change step carries the settled value", () => {
    document.body.innerHTML = `<input id="q" />`
    keydown(document.querySelector("input")!, { key: "a" })
    expect(api.recordedSteps()).toEqual([])
  })

  it("records a real chord", () => {
    document.body.innerHTML = `<input id="q" />`
    keydown(document.querySelector("input")!, { key: "a", ctrlKey: true })
    expect(api.recordedSteps()[0]).toMatchObject({ act: "press_key", key: "ctrl+a" })
  })

  it("ignores shift+letter — that is capitalisation, not a chord", () => {
    document.body.innerHTML = `<input id="q" />`
    keydown(document.querySelector("input")!, { key: "A", shiftKey: true })
    expect(api.recordedSteps()).toEqual([])
  })

  it("attaches the focused element to the key step", () => {
    document.body.innerHTML = `<input id="q" placeholder="Search" />`
    keydown(document.querySelector("input")!, { key: "Enter" })
    expect(api.recordedSteps()[0].target).toMatchObject({ selector: "#q", name: "Search" })
  })

  it("ignores a keydown with no key", () => {
    document.body.innerHTML = `<input id="q" />`
    keydown(document.querySelector("input")!, {})
    expect(api.recordedSteps()).toEqual([])
  })

  // Browsers report AltGr as ctrl+alt, so on German/Polish/Nordic layouts the
  // characters `@ { } [ ] \ | € ~` — all common in passwords — arrive here as
  // chords. Each one recorded is a credential character leaked verbatim.
  it.each([
    { key: "@", ctrlKey: true, altKey: true },
    { key: "{", ctrlKey: true, altKey: true },
    { key: "€", ctrlKey: true, altKey: true },
    { key: "å", altKey: true },
  ])("drops the AltGr chord %o typed into a password field", (init) => {
    document.body.innerHTML = `<input type="password" id="pw" />`
    keydown(document.querySelector("input")!, init)
    expect(api.recordedSteps()).toEqual([])
    expect(window.sessionStorage.getItem(STEPS_KEY)).not.toContain(init.key)
  })

  it("drops a chord in a password field revealed to type=text", () => {
    document.body.innerHTML = `<input type="password" id="pw" />`
    const field = document.querySelector("input")!
    focusin(field)
    field.setAttribute("type", "text")
    keydown(field, { key: "@", ctrlKey: true, altKey: true })
    expect(api.recordedSteps()).toEqual([])
  })

  // Enter/Tab submit the form and matter for replay; they carry no character,
  // so they survive the drop.
  it.each(["Enter", "Tab"])("keeps the character-free %s key in a password field", (key) => {
    document.body.innerHTML = `<input type="password" id="pw" />`
    keydown(document.querySelector("input")!, { key })
    expect(api.recordedSteps()[0]).toMatchObject({ act: "press_key", key })
  })

  it("still records a chord in an ordinary field", () => {
    document.body.innerHTML = `<input type="text" id="q" />`
    keydown(document.querySelector("input")!, { key: "a", ctrlKey: true })
    expect(api.recordedSteps()[0]).toMatchObject({ act: "press_key", key: "ctrl+a" })
  })
})

describe("drainRecord", () => {
  it("returns the buffered steps as json and empties the buffer", () => {
    document.body.innerHTML = `<button>go</button>`
    click(document.querySelector("button")!)
    const drained = JSON.parse(api.drainRecord()) as Step[]
    expect(drained).toHaveLength(1)
    expect(api.recordedSteps()).toEqual([])
  })

  it("returns an empty array when nothing was recorded", () => {
    expect(JSON.parse(api.drainRecord())).toEqual([])
  })

  it("orders steps by a monotonic counter", () => {
    document.body.innerHTML = `<button id="a">a</button><button id="b">b</button>`
    click(document.querySelector("#a")!)
    click(document.querySelector("#b")!)
    const [first, second] = api.recordedSteps()
    expect(second.at).toBeGreaterThan(first.at)
  })
})

// A navigation destroys this JS context, taking the click that caused it. The
// sessionStorage mirror is what carries a same-origin flow across that seam.
describe("surviving a navigation", () => {
  it("mirrors each step to sessionStorage as it happens", () => {
    document.body.innerHTML = `<button>Sign in</button>`
    click(document.querySelector("button")!)
    const mirrored = JSON.parse(window.sessionStorage.getItem(STEPS_KEY) ?? "[]") as Step[]
    expect(mirrored).toHaveLength(1)
    expect(mirrored[0]).toMatchObject({ act: "click" })
  })

  it("re-arms and restores the buffer on the next document", () => {
    api.stopRecord()
    window.sessionStorage.setItem(FLAG_KEY, "1")
    window.sessionStorage.setItem(
      STEPS_KEY,
      JSON.stringify([{ act: "click", at: 1, target: { selector: "#a" } }])
    )
    api.restoreRecord()
    expect(api.isRecording()).toBe(true)
    expect(api.recordedSteps()).toHaveLength(1)
  })

  it("stays disarmed when the flag says recording was stopped", () => {
    api.stopRecord()
    window.sessionStorage.setItem(FLAG_KEY, "0")
    api.restoreRecord()
    expect(api.isRecording()).toBe(false)
  })

  it("starts clean rather than failing to install on a corrupt buffer", () => {
    api.stopRecord()
    window.sessionStorage.setItem(FLAG_KEY, "1")
    window.sessionStorage.setItem(STEPS_KEY, "{{{not json")
    expect(() => api.restoreRecord()).not.toThrow()
    expect(api.isRecording()).toBe(true)
    expect(api.recordedSteps()).toEqual([])
  })

  it("clears the armed flag on stop so the next document does not re-arm", () => {
    api.stopRecord()
    expect(window.sessionStorage.getItem(FLAG_KEY)).toBe("0")
  })

  // `FlowRecorder.stop()` drains before calling this, but `poll()` swallows its
  // errors — so a stop against a dead JS context would otherwise park the take
  // in the visited site's OWN sessionStorage for the rest of the tab session.
  it("clears the mirror on stop so the visited site is not left holding the take", () => {
    document.body.innerHTML = `<input id="q" />`
    const field = document.querySelector("input")!
    field.value = "a@b.c"
    change(field)
    expect(window.sessionStorage.getItem(STEPS_KEY)).toContain("a@b.c")
    api.stopRecord()
    expect(window.sessionStorage.getItem(STEPS_KEY)).toBeNull()
  })
})

describe("bounds", () => {
  it("keeps the head of a pathological recording rather than beheading it", () => {
    document.body.innerHTML = `<button id="first">first</button><button id="rest">rest</button>`
    const first = document.querySelector("#first")!
    const rest = document.querySelector("#rest")!
    click(first)
    for (let i = 0; i < 520; i++) click(rest)
    const steps = api.recordedSteps()
    expect(steps).toHaveLength(500)
    // The opening step — the one that defines the flow — must still be there.
    expect(steps[0].target?.selector).toBe("#first")
  })
})
