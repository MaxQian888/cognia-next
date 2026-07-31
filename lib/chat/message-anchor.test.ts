/** @jest-environment jsdom */

import { MESSAGE_ANCHOR_ATTR, findMessageAnchor, messageAnchorSelector } from "./message-anchor"

describe("messageAnchorSelector", () => {
  it("builds an attribute selector on the shared anchor attribute", () => {
    expect(messageAnchorSelector("msg_1")).toBe('[data-msg-id="msg_1"]')
    expect(MESSAGE_ANCHOR_ATTR).toBe("data-msg-id")
  })

  it("escapes ids that would otherwise break the selector", () => {
    // Whatever escape path runs, the result must be a selector the DOM accepts
    // for that exact id — asserting the escaped *string* would pin the
    // CSS.escape-vs-fallback branch rather than the behaviour.
    const id = 'we"ird\\id'
    const host = document.createElement("div")
    const row = document.createElement("div")
    row.setAttribute(MESSAGE_ANCHOR_ATTR, id)
    host.append(row)
    expect(host.querySelector(messageAnchorSelector(id))).toBe(row)
  })

  it("falls back to manual escaping when CSS.escape is unavailable", () => {
    const original = CSS.escape
    // @ts-expect-error -- deliberately removing the API to exercise the fallback
    delete CSS.escape
    try {
      expect(messageAnchorSelector('a"b')).toBe('[data-msg-id="a\\"b"]')
    } finally {
      CSS.escape = original
    }
  })
})

describe("findMessageAnchor", () => {
  function mount(ids: string[]): HTMLDivElement {
    const host = document.createElement("div")
    for (const id of ids) {
      const row = document.createElement("div")
      row.setAttribute(MESSAGE_ANCHOR_ATTR, id)
      host.append(row)
    }
    return host
  }

  it("returns the row carrying the anchor attribute", () => {
    const host = mount(["a", "b", "c"])
    const found = findMessageAnchor(host, "b")
    expect(found?.getAttribute(MESSAGE_ANCHOR_ATTR)).toBe("b")
  })

  it("returns null for a message that is not rendered", () => {
    expect(findMessageAnchor(mount(["a"]), "zzz")).toBeNull()
  })

  it("returns null for a missing root instead of throwing", () => {
    expect(findMessageAnchor(null, "a")).toBeNull()
    expect(findMessageAnchor(undefined, "a")).toBeNull()
  })
})
