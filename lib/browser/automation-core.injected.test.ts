/** @jest-environment jsdom */

import fs from "node:fs"
import path from "node:path"

type AutomationCore = {
  version: number
  directText: (element: Element) => string
  implicitRole: (element: Element) => string | null
  accessibleName: (element: Element) => string
  isVisible: (element: Element) => boolean
  receivesEvents: (element: Element) => boolean
  isStable: (
    element: Element,
    options?: { signal?: AbortSignal; timeout?: number }
  ) => Promise<boolean>
  isEditable: (element: Element) => boolean
  setValue: (element: Element, value: string, append?: boolean) => void
  parseKeyChord: (value: string) => { key: string; ctrlKey: boolean; shiftKey: boolean }
}

const source = fs.readFileSync(path.join(__dirname, "automation-core.injected.js"), "utf8")

function core() {
  ;(0, eval)(source)
  return (window as unknown as { __cogniaAutomationCore: AutomationCore }).__cogniaAutomationCore
}

test("shares semantic text, roles, names, editability, and key chords", () => {
  document.body.innerHTML = `
    <label id="query-label" for="query">Search query</label>
    <input id="query" aria-labelledby="query-label" />
    <button>Save <span>now</span></button>
    <div contenteditable="true">Draft</div>
  `
  const api = core()
  const input = document.querySelector("input")!
  const button = document.querySelector("button")!
  const editor = document.querySelector("[contenteditable]")!

  expect(api.version).toBe(3)
  expect(api.implicitRole(input)).toBe("textbox")
  expect(api.accessibleName(input)).toBe("Search query")
  expect(api.directText(button)).toBe("Save")
  expect(api.isEditable(editor)).toBe(true)
  expect(api.parseKeyChord("Control+Shift+K")).toMatchObject({
    key: "K",
    ctrlKey: true,
    shiftKey: true,
  })
})

test("treats opacity as actionable and respects hidden shadow hosts and empty hit tests", () => {
  document.body.innerHTML = `<button id="opaque" style="opacity: 0">Opaque</button><div id="host" hidden></div>`
  const opaque = document.getElementById("opaque")!
  const host = document.getElementById("host")!
  const shadowButton = document.createElement("button")
  host.attachShadow({ mode: "open" }).append(shadowButton)
  for (const element of [opaque, shadowButton])
    Object.defineProperty(element, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }),
    })
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => null,
  })

  const api = core()
  expect(api.isVisible(opaque)).toBe(true)
  expect(api.isVisible(shadowButton)).toBe(false)
  expect(api.receivesEvents(opaque)).toBe(false)
})

test("uses input-specific roles and descendant image names", () => {
  document.body.innerHTML = `
    <input type="number" aria-label="Quantity" />
    <input type="search" aria-label="Search" />
    <button><img alt="Save" /><span aria-hidden="true">Decoration</span></button>
    <button id="split-name"><span>Set</span><span>tings</span></button>
  `
  const api = core()

  expect(api.implicitRole(document.querySelector("input[type=number]")!)).toBe("spinbutton")
  expect(api.implicitRole(document.querySelector("input[type=search]")!)).toBe("searchbox")
  expect(api.accessibleName(document.querySelector("button")!)).toBe("Save")
  expect(api.accessibleName(document.getElementById("split-name")!)).toBe("Settings")
})

test("fills controls in their owning iframe realm and checks hidden ancestors", () => {
  document.body.innerHTML = "<iframe></iframe>"
  const frame = document.querySelector("iframe")!
  const frameDocument = frame.contentDocument!
  frameDocument.body.innerHTML = `
    <textarea></textarea>
    <select><option value="first">First</option><option value="second">Second</option></select>
    <div hidden><input /></div>
  `
  const textarea = frameDocument.querySelector("textarea")!
  const select = frameDocument.querySelector("select")!
  const hiddenInput = frameDocument.querySelector("input")!
  Object.defineProperty(hiddenInput, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 10, height: 10 }),
  })
  const inputEvents: Event[] = []
  textarea.addEventListener("input", (event) => inputEvents.push(event))
  const api = core()

  api.setValue(textarea, "frame value")
  api.setValue(select, "second")

  expect(textarea.value).toBe("frame value")
  expect(select.value).toBe("second")
  expect(inputEvents).toHaveLength(1)
  expect(Object.getPrototypeOf(inputEvents[0])).toBe(
    Object.getPrototypeOf(frameDocument.createEvent("Event"))
  )
  expect(api.isVisible(hiddenInput)).toBe(false)
})

test("hit-tests nested shadow roots and still refuses an actual overlay", () => {
  document.body.innerHTML = '<div id="host"></div><div id="cover"></div>'
  const host = document.getElementById("host")!
  const outerRoot = host.attachShadow({ mode: "open" })
  const innerHost = document.createElement("div")
  outerRoot.append(innerHost)
  const innerRoot = innerHost.attachShadow({ mode: "open" })
  const button = document.createElement("button")
  innerRoot.append(button)
  const cover = document.getElementById("cover")!
  Object.defineProperty(button, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: 10, height: 10 }),
  })
  let covered = false
  const previousHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint")
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => (covered ? cover : host),
  })
  Object.defineProperty(outerRoot, "elementFromPoint", {
    configurable: true,
    value: () => innerHost,
  })
  Object.defineProperty(innerRoot, "elementFromPoint", {
    configurable: true,
    value: () => button,
  })

  try {
    expect(core().receivesEvents(button)).toBe(true)
    covered = true
    expect(core().receivesEvents(button)).toBe(false)
  } finally {
    if (previousHitTest) Object.defineProperty(document, "elementFromPoint", previousHitTest)
    else Reflect.deleteProperty(document, "elementFromPoint")
  }
})

test.each([1, 2])("cancels a suspended stability check at frame %s", async (stage) => {
  jest.useFakeTimers()
  document.body.innerHTML = "<button>Stable</button>"
  const frames = new Map<number, FrameRequestCallback>()
  let nextId = 0
  const request = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextId, callback)
    return nextId
  })
  const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id)
  })
  try {
    const controller = new AbortController()
    const pending = core().isStable(document.querySelector("button")!, {
      signal: controller.signal,
      timeout: 1_000,
    })
    if (stage === 2) {
      const first = frames.get(1)!
      frames.delete(1)
      first(performance.now())
    }
    controller.abort()
    await expect(pending).resolves.toBe(false)
    expect(frames.size).toBe(0)
    expect(cancel).toHaveBeenCalledWith(stage)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    request.mockRestore()
    cancel.mockRestore()
    jest.useRealTimers()
  }
})

test("a stability deadline releases a frame that never arrives", async () => {
  jest.useFakeTimers()
  document.body.innerHTML = "<button>Stable</button>"
  const request = jest.spyOn(window, "requestAnimationFrame").mockReturnValue(42)
  const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
  try {
    const pending = core().isStable(document.querySelector("button")!, { timeout: 25 })
    jest.advanceTimersByTime(25)
    await expect(pending).resolves.toBe(false)
    expect(cancel).toHaveBeenCalledWith(42)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    request.mockRestore()
    cancel.mockRestore()
    jest.useRealTimers()
  }
})
