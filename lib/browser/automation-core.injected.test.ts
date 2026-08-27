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
  isEditable: (element: Element) => boolean
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

  expect(api.version).toBe(1)
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
