import { buildErrorOutput, resolveNodeFailure } from "./node-failure"
import type { WorkflowNode } from "@/types/workflow/visual"

function node(
  type: WorkflowNode["type"],
  errorHandling?: WorkflowNode["data"]["errorHandling"]
): WorkflowNode {
  return {
    id: "n1",
    type,
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: "n", params: {}, ...(errorHandling ? { errorHandling } : {}) },
  }
}

describe("resolveNodeFailure", () => {
  it("defers to legacy handling without errorHandling or with onError=fail", () => {
    expect(resolveNodeFailure(node("io.http"))).toEqual({ mode: null })
    expect(resolveNodeFailure(node("io.http", { onError: "fail" }))).toEqual({ mode: null })
  })

  it("returns continue / errorBranch modes for supported kinds", () => {
    expect(resolveNodeFailure(node("io.http", { onError: "continue" }))).toEqual({
      mode: "continue",
    })
    expect(resolveNodeFailure(node("ai.prompt", { onError: "errorBranch" }))).toEqual({
      mode: "errorBranch",
    })
  })

  it("carries the defaultValue for defaultValue mode", () => {
    expect(
      resolveNodeFailure(node("data.code", { onError: "defaultValue", defaultValue: { x: 1 } }))
    ).toEqual({ mode: "defaultValue", defaultValue: { x: 1 } })
  })

  it("ignores onError on kinds that don't support error handling", () => {
    expect(resolveNodeFailure(node("flow.branch", { onError: "continue" }))).toEqual({
      mode: null,
    })
    expect(resolveNodeFailure(node("trigger.manual", { onError: "errorBranch" }))).toEqual({
      mode: null,
    })
  })
})

describe("buildErrorOutput", () => {
  it("shapes an Error into a downstream-readable output", () => {
    const err = new TypeError("boom")
    expect(buildErrorOutput(err)).toEqual({ failed: true, error: "boom", errorType: "TypeError" })
  })

  it("stringifies non-Error throwables", () => {
    expect(buildErrorOutput("raw")).toEqual({ failed: true, error: "raw", errorType: "Error" })
  })
})
