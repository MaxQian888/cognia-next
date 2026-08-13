import type { PerformanceCaptureRow } from "./capture-types"

describe("performance capture plaintext metadata", () => {
  it("contains structural lifecycle and accounting fields", () => {
    const row: PerformanceCaptureRow = {
      id: "capture-a",
      status: "recording",
      purpose: "capture",
      sourceKind: "renderer",
      sourceId: "renderer:doc-a",
      hostInstanceId: "doc-a",
      targetId: "target-a",
      routingGeneration: 1,
      wireVersion: 1,
      metricSchemaVersion: 1,
      capabilityBits: "renderer.fps",
      startedAt: 1,
      updatedAt: 1,
      pinned: 0,
      payloadBytes: 0,
      attachmentBytes: 0,
      frameCount: 0,
      gapCount: 0,
    }
    expect(Object.keys(row)).not.toEqual(
      expect.arrayContaining(["name", "notes", "tags", "summary"])
    )
  })
})
