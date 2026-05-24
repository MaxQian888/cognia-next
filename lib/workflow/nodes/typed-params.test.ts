/**
 * Type-level tests for the per-kind params inference. The assertions are
 * exercised at runtime (so Jest counts the file as a passing suite), but their
 * real value is compile-time: if `WorkflowNodeParamsFor` stopped inferring the
 * right shape, or `TypedWorkflowNode` stopped narrowing on `type`, this file
 * would fail to type-check under `pnpm build`.
 */

import type { TypedWorkflowNode, WorkflowNodeParamsFor } from "./typed-params"

describe("typed-params", () => {
  it("infers per-kind params from the schema", () => {
    const cron: WorkflowNodeParamsFor<"trigger.cron"> = { cron: "0 9 * * 1-5" }
    expect(cron.cron).toBe("0 9 * * 1-5")

    // optional timezone is allowed by the inferred shape
    const cronTz: WorkflowNodeParamsFor<"trigger.cron"> = { cron: "* * * * *", timezone: "UTC" }
    expect(cronTz.timezone).toBe("UTC")

    const http: WorkflowNodeParamsFor<"io.http"> = { url: "https://example.test/x" }
    expect(http.url).toBe("https://example.test/x")

    // empty-object kinds (e.g. trigger.manual) infer `{}`
    const manual: WorkflowNodeParamsFor<"trigger.manual"> = {}
    expect(manual).toEqual({})
  })

  it("narrows TypedWorkflowNode.data.params by the type discriminant", () => {
    const node: TypedWorkflowNode = {
      id: "n1",
      type: "flow.set",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "Set", params: { variable: "x", value: "1" } },
    }

    if (node.type === "flow.set") {
      // params is narrowed to { variable: string; value: string } here —
      // no cast, full property access.
      expect(node.data.params.variable).toBe("x")
      expect(node.data.params.value).toBe("1")
    } else {
      throw new Error("discriminant narrowing failed")
    }
  })

  it("rejects params that don't match the kind", () => {
    // @ts-expect-error — io.http requires `url`; `cron` is not part of its shape.
    const bad: WorkflowNodeParamsFor<"io.http"> = { cron: "* * * * *" }
    void bad
  })
})
