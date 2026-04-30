/**
 * @jest-environment jsdom
 *
 * Smoke test for the canvas/collaboration barrel — re-exports the
 * CRDT store + websocket provider.
 */

import * as collab from "./index"

describe("canvas/collaboration barrel exports", () => {
  it("re-exports CanvasCRDTStore and CanvasWebSocketProvider", () => {
    expect(typeof collab.CanvasCRDTStore).toBe("function")
    expect(typeof collab.CanvasWebSocketProvider).toBe("function")
  })
})
