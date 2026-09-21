import { DELEGATE_WORK_POLICY, type DelegateToolContext } from "../workflows/delegate-ports"
import { MemoryArtifactStore } from "./memory-artifacts"
import { MemoryDelegateToolRuntime } from "./memory-delegate-tools"
import { MemoryWorkspace } from "./memory-workspace"

function context(overrides: Partial<DelegateToolContext> = {}): DelegateToolContext {
  return {
    runId: "run-1",
    logicalStepId: "delegate:work:1:turn:1",
    policyId: DELEGATE_WORK_POLICY,
    role: "worker",
    signal: new AbortController().signal,
    revision: "rev-0",
    allowedPaths: ["src"],
    ...overrides,
  }
}

function setup(options: ConstructorParameters<typeof MemoryDelegateToolRuntime>[2] = {}) {
  const workspace = new MemoryWorkspace(
    { "src/a.ts": "a\n", "README.md": "# r\n", "vendor/link": "x" },
    { symlinkEscapes: ["vendor/link"] }
  )
  const store = new MemoryArtifactStore()
  return { runtime: new MemoryDelegateToolRuntime(workspace, store, options), store, workspace }
}

describe("MemoryDelegateToolRuntime", () => {
  it("offers the delegate tools only under their policy", () => {
    const { runtime } = setup({ omit: ["workspace_list"] })
    expect(runtime.describe(DELEGATE_WORK_POLICY).map((t) => t.name)).toEqual([
      "workspace_read",
      "propose_patch",
    ])
    expect(runtime.describe("panel-read-1")).toEqual([])
  })

  it("reads with a content-pinned evidence artifact and replays a repeat", async () => {
    const { runtime, store } = setup({ retrievedAt: "2026-09-19T01:00:00Z" })
    const intent = { id: "t1", name: "workspace_read", arguments: { path: "src/a.ts" } }
    const receipt = await runtime.execute(intent, context())
    expect(receipt).toMatchObject({ status: "succeeded", summary: "a\n" })
    const artifact = await store.get(receipt.evidence[0].artifact_id)
    expect(artifact?.content).toBe("a\n")
    expect(receipt.evidence[0]).toMatchObject({
      locator: "workspace:rev-0:src/a.ts",
      retrieved_at: "2026-09-19T01:00:00Z",
    })
    const again = await runtime.execute({ ...intent, id: "t2" }, context())
    expect(again).toEqual({ ...receipt, toolCallId: "t2" })
    expect(runtime.executed).toHaveLength(1)
    expect(await runtime.execute(intent, context({ revision: "rev-x" }))).toMatchObject({
      status: "failed",
      summary: expect.stringContaining("REVISION_UNKNOWN"),
    })
    expect(
      await runtime.execute({ ...intent, arguments: { path: "src/none.ts" } }, context())
    ).toMatchObject({
      status: "failed",
    })
    const truncated = setup({ readMaxBytes: 1 })
    expect(await truncated.runtime.execute(intent, context())).toMatchObject({
      summary: "a\n… (truncated)",
    })
  })

  it("lists, and refuses what the workspace refuses", async () => {
    const { runtime } = setup({ listLimit: 1 })
    expect(
      await runtime.execute(
        { id: "l", name: "workspace_list", arguments: { prefix: "" } },
        context()
      )
    ).toMatchObject({ status: "succeeded", summary: "README.md\n… (more files)" })
    expect(
      await runtime.execute(
        { id: "l2", name: "workspace_list", arguments: { prefix: "/abs" } },
        context()
      )
    ).toMatchObject({ status: "refused", refusalCode: "PATH_ABSOLUTE" })
    expect(
      await runtime.execute({ id: "l3", name: "workspace_list", arguments: {} }, context())
    ).toMatchObject({ status: "refused", refusalCode: "INVALID_ARGUMENTS" })
    expect(
      await runtime.execute(
        { id: "r", name: "workspace_read", arguments: { path: "../x" } },
        context()
      )
    ).toMatchObject({ status: "refused", refusalCode: "PATH_TRAVERSAL" })
    expect(
      await runtime.execute({ id: "r2", name: "workspace_read", arguments: {} }, context())
    ).toMatchObject({ status: "refused", refusalCode: "INVALID_ARGUMENTS" })
  })

  it("records a patch proposal without writing, inside the write scope only", async () => {
    const { runtime, workspace } = setup()
    const write = {
      id: "p",
      name: "propose_patch",
      arguments: { path: "src/b.ts", action: "write", content: "b\n" },
    }
    expect(await runtime.execute(write, context())).toMatchObject({
      status: "succeeded",
      summary: "proposed: write src/b.ts (2 bytes)",
    })
    expect(workspace.filesAt("rev-0")?.["src/b.ts"]).toBeUndefined()
    expect(
      await runtime.execute(
        { id: "d", name: "propose_patch", arguments: { path: "src/a.ts", action: "delete" } },
        context()
      )
    ).toMatchObject({ status: "succeeded", summary: "proposed: delete src/a.ts" })
    expect(
      await runtime.execute(
        { ...write, id: "o", arguments: { ...write.arguments, path: "README.md" } },
        context()
      )
    ).toMatchObject({ status: "refused", refusalCode: "PATH_OUT_OF_SCOPE" })
    expect(
      await runtime.execute(
        { ...write, id: "s", arguments: { ...write.arguments, path: "vendor/link" } },
        context({ allowedPaths: ["vendor"] })
      )
    ).toMatchObject({ status: "refused", refusalCode: "PATH_ESCAPE" })
    expect(
      await runtime.execute(
        { ...write, id: "t", arguments: { ...write.arguments, path: "/etc/x" } },
        context()
      )
    ).toMatchObject({ status: "refused", refusalCode: "PATH_ABSOLUTE" })
    expect(
      await runtime.execute(
        { id: "i", name: "propose_patch", arguments: { path: "src/x" } },
        context()
      )
    ).toMatchObject({ status: "refused", refusalCode: "INVALID_ARGUMENTS" })
  })

  it("refuses tools the policy does not offer, external writes, and names it does not know", async () => {
    const { runtime } = setup({
      extra: [
        { name: "shell", description: "", parameters: {}, toolClass: "external_write" },
        { name: "mystery", description: "", parameters: {}, toolClass: "read_only" },
      ],
    })
    expect(
      await runtime.execute({ id: "a", name: "approve", arguments: {} }, context())
    ).toMatchObject({
      status: "refused",
      refusalCode: "TOOL_NOT_OFFERED",
    })
    expect(
      await runtime.execute({ id: "b", name: "shell", arguments: {} }, context())
    ).toMatchObject({
      refusalCode: "WRITE_NOT_PERMITTED",
    })
    expect(
      await runtime.execute({ id: "c", name: "mystery", arguments: {} }, context())
    ).toMatchObject({
      refusalCode: "TOOL_NOT_IMPLEMENTED",
    })
  })
})
