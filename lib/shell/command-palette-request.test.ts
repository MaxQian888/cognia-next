/** @jest-environment jsdom */

import {
  COMMAND_PALETTE_REQUEST_EVENT,
  onCommandPaletteRequest,
  requestCommandPalette,
} from "./command-palette-request"

describe("command palette request seam", () => {
  it("delivers a request, with its query, to the subscribed palette", () => {
    const handler = jest.fn()
    const off = onCommandPaletteRequest(handler)
    requestCommandPalette({ query: "budget" })
    expect(handler).toHaveBeenCalledWith({ query: "budget" })
    off()
    requestCommandPalette({ query: "after" })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("normalises a bare request to an empty detail", () => {
    const handler = jest.fn()
    const off = onCommandPaletteRequest(handler)
    requestCommandPalette()
    window.dispatchEvent(new Event(COMMAND_PALETTE_REQUEST_EVENT))
    expect(handler).toHaveBeenNthCalledWith(1, {})
    expect(handler).toHaveBeenNthCalledWith(2, {})
    off()
  })
})
