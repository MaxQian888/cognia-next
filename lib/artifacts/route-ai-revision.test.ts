import { routeAiRevision } from "./route-ai-revision"
import type { DetectedArtifact } from "@/lib/ai/generation/artifact-detector"

const block = (over: Partial<DetectedArtifact> = {}): DetectedArtifact => ({
  type: "code",
  language: "javascript",
  content: "console.log(1)",
  title: "Snippet",
  startIndex: 0,
  endIndex: 10,
  lineCount: 1,
  confidence: 0.7,
  ...over,
})

const target = { artifactId: "art1", requestId: "req1" }

describe("routeAiRevision", () => {
  it("auto-creates when the review gate is off", () => {
    expect(routeAiRevision({ reviewEnabled: false, target, detected: [block()] }).action).toBe(
      "autoCreate"
    )
  })

  it("auto-creates when there is no edit target", () => {
    expect(routeAiRevision({ reviewEnabled: true, target: null, detected: [block()] }).action).toBe(
      "autoCreate"
    )
  })

  it("auto-creates when no artifacts were detected", () => {
    expect(routeAiRevision({ reviewEnabled: true, target, detected: [] }).action).toBe("autoCreate")
  })

  it("proposes the exact type match when present", () => {
    const route = routeAiRevision({
      reviewEnabled: true,
      target,
      targetArtifactType: "mermaid",
      detected: [
        block({ type: "code", content: "code-block" }),
        block({ type: "mermaid", content: "graph TD" }),
      ],
    })
    expect(route).toEqual({
      action: "propose",
      artifactId: "art1",
      requestId: "req1",
      content: "graph TD",
    })
  })

  it("falls back to the first code-ish block when target is code-ish and no exact match", () => {
    const route = routeAiRevision({
      reviewEnabled: true,
      target,
      targetArtifactType: "react",
      detected: [block({ type: "html", content: "<div/>" })],
    })
    expect(route).toMatchObject({ action: "propose", content: "<div/>" })
  })

  it("falls back to the first detected block when nothing else matches", () => {
    const route = routeAiRevision({
      reviewEnabled: true,
      target,
      targetArtifactType: "math",
      detected: [
        block({ type: "chart", content: "first" }),
        block({ type: "document", content: "second" }),
      ],
    })
    expect(route).toMatchObject({ action: "propose", content: "first" })
  })

  it("proposes the first block when the target type is unknown", () => {
    const route = routeAiRevision({
      reviewEnabled: true,
      target,
      detected: [block({ content: "only" })],
    })
    expect(route).toMatchObject({ action: "propose", content: "only" })
  })
})
