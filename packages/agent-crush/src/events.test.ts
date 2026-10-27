/** @jest-environment node */
import { CrushEventDecoder } from "./events"

describe("Crush snapshot event decoding", () => {
  it("correlates terminal events by run id, not only session", () => {
    const decoder = new CrushEventDecoder("s", "run-1", "m")
    expect(
      decoder.decode({
        type: "run_complete",
        payload: { type: "created", payload: { session_id: "s", run_id: "other", text: "wrong" } },
      })
    ).toEqual([])
    const done = decoder.decode({
      type: "run_complete",
      payload: {
        type: "created",
        payload: { session_id: "s", run_id: "run-1", message_id: "m", text: "ok" },
      },
    })
    expect(done).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message_delta", delta: { type: "text", text: "ok" } }),
        expect.objectContaining({ type: "done", success: true }),
      ])
    )
  })
  it("refuses malformed envelopes", () => {
    expect(() =>
      new CrushEventDecoder("s", "r", "m").decode({ type: "message", payload: null })
    ).toThrow(/Malformed/)
  })
})
