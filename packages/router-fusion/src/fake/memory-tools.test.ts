import { MemoryArtifactStore } from "./memory-artifacts"
import { MemoryToolRuntime } from "./memory-tools"

const LOOKUP = {
  name: "lookup",
  description: "Read a source",
  parameters: { type: "object", properties: { q: { type: "string" } } },
  toolClass: "read_only" as const,
}
const PUBLISH = {
  name: "publish",
  description: "Post somewhere",
  parameters: { type: "object" },
  toolClass: "external_write" as const,
}

function runtime() {
  const store = new MemoryArtifactStore()
  const tools = new MemoryToolRuntime(store, {
    read: {
      tools: [LOOKUP, PUBLISH],
      read: (_name, args) =>
        args.q === "tariff"
          ? { locator: "https://example.com/t", content: "4% in 2025" }
          : undefined,
    },
  })
  const context = {
    runId: "run-1",
    logicalStepId: "step",
    policyId: "read",
    role: "panel_a",
    signal: new AbortController().signal,
  }
  return { store, tools, context }
}

describe("MemoryToolRuntime", () => {
  it("offers a policy's tools and nothing for an unknown policy", () => {
    const { tools } = runtime()
    expect(tools.describe("read").map((tool) => tool.name)).toEqual(["lookup", "publish"])
    expect(tools.describe("nope")).toEqual([])
  })

  it("stores what a read found and pins it by content", async () => {
    const { tools, store, context } = runtime()
    const receipt = await tools.execute(
      { id: "c1", name: "lookup", arguments: { q: "tariff" } },
      context
    )
    expect(receipt).toMatchObject({ status: "succeeded", summary: "4% in 2025" })
    const [ref] = receipt.evidence
    expect(store.items.get(ref.artifact_id)).toMatchObject({
      content: "4% in 2025",
      namespace: "runs/run-1/evidence",
    })
    expect(ref.content_sha256).toBe(store.items.get(ref.artifact_id)?.artifact.contentSha256)
  })

  it("refuses a tool the policy does not offer and any write, whatever was asked", async () => {
    const { tools, context } = runtime()
    await expect(
      tools.execute({ id: "c1", name: "start_fusion_run", arguments: {} }, context)
    ).resolves.toMatchObject({ status: "refused", refusalCode: "TOOL_NOT_OFFERED" })
    await expect(
      tools.execute({ id: "c2", name: "publish", arguments: {} }, context)
    ).resolves.toMatchObject({
      status: "refused",
      refusalCode: "WRITE_NOT_PERMITTED",
    })
    await expect(
      tools.execute({ id: "c3", name: "lookup", arguments: {} }, { ...context, policyId: "other" })
    ).resolves.toMatchObject({ status: "refused" })
  })

  it("reports a read that found nothing as failed, and replays a repeated request", async () => {
    const { tools, context } = runtime()
    await expect(
      tools.execute({ id: "c1", name: "lookup", arguments: { q: "x" } }, context)
    ).resolves.toMatchObject({
      status: "failed",
    })
    const first = await tools.execute(
      { id: "c2", name: "lookup", arguments: { q: "tariff" } },
      context
    )
    const again = await tools.execute(
      { id: "c9", name: "lookup", arguments: { q: "tariff" } },
      context
    )
    expect(again).toEqual({ ...first, toolCallId: "c9" })
    expect(tools.executed).toHaveLength(2)
  })
})
