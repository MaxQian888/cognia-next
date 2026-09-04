/**
 * @jest-environment node
 */
import { inlineOverlayRows, overlayIsInline, overlayTakesScreen } from "./overlay-layout"
import type { Overlay } from "./types"

const permission = {
  kind: "permission",
  req: {
    type: "permission_request",
    sessionId: "s",
    requestId: "r",
    toolName: "bash",
    input: {},
  },
  choices: [],
  index: 0,
} as unknown as Overlay

describe("overlayTakesScreen", () => {
  it("keeps the conversation for a prompt the turn raised", () => {
    // The whole point: an approval is read against the transcript above it.
    expect(overlayTakesScreen(permission)).toBe(false)
    expect(overlayIsInline(permission)).toBe(true)
  })

  it("gives the screen to a picker the user navigated to", () => {
    expect(overlayTakesScreen({ kind: "model", options: [], index: 0, query: "" })).toBe(true)
    expect(overlayTakesScreen({ kind: "settings" } as unknown as Overlay)).toBe(true)
  })

  it("treats a closed overlay as neither", () => {
    expect(overlayTakesScreen({ kind: "none" })).toBe(false)
    expect(overlayIsInline({ kind: "none" })).toBe(false)
  })
})

describe("inlineOverlayRows", () => {
  it("keeps a docked prompt to a third of the viewport", () => {
    expect(inlineOverlayRows(60)).toBe(20)
  })

  it("never shrinks below the frame plus its choices", () => {
    // A prompt has to stay answerable on a short terminal, even at the cost of
    // most of the transcript.
    expect(inlineOverlayRows(12)).toBe(9)
    expect(inlineOverlayRows(4)).toBe(9)
  })
})
