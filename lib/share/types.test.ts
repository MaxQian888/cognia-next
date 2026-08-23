import type { SharePayload } from "./types"

describe("SharePayload", () => {
  it("accepts the workflow result discriminator used by published workflow shares", () => {
    const payload = {
      kind: "workflow-result",
      mime: "application/json",
      data: '{"ok":true}',
      encoding: "utf8",
    } satisfies SharePayload

    expect(payload.kind).toBe("workflow-result")
  })
})
