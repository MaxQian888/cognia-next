/** @jest-environment jsdom */

import { WORKSPACE_INSTRUCTIONS_MAX_CHARS } from "@/lib/workspace/workspace-instructions"
import { useProjectStore } from "@/stores/project/project-store"
import { resourceKey } from "../resources"
import { workspaceInstructionsPromptAdapter as adapter } from "./workspace-instructions"

const KEY = resourceKey("workspace-instructions", "ws-1")
const ctx = { workspace: { id: "ws-1", name: "Repo", roots: ["/repo"] } }

function seed(customInstructions?: string) {
  useProjectStore.setState({
    projects: [{ id: "ws-1", name: "Repo (store)", customInstructions, roots: ["/repo"] }],
  } as never)
}

beforeEach(() => seed())

describe("workspaceInstructionsPromptAdapter", () => {
  it("lists nothing without a workspace and one entry with one", async () => {
    expect(await adapter.list({})).toEqual([])
    seed("Use pnpm.")
    expect(await adapter.list(ctx)).toEqual([
      {
        key: KEY,
        source: "workspace-instructions",
        kind: "project-rule",
        operation: "append-rules",
        name: "Repo (store)",
        builtIn: false,
        modified: true,
        edit: "source",
      },
    ])
  })

  it("saves through the project store, clearing on blank text", async () => {
    expect(await adapter.save!(KEY, "  Use pnpm.  ", undefined, ctx)).toEqual({
      key: KEY,
      text: "Use pnpm.",
    })
    expect(useProjectStore.getState().projects[0].customInstructions).toBe("Use pnpm.")
    await adapter.save!(KEY, "   ", undefined, ctx)
    expect(useProjectStore.getState().projects[0].customInstructions).toBeUndefined()
    expect((await adapter.read(KEY, ctx))?.text).toBe("")
  })

  it("refuses text over the workspace limit and an unknown workspace", async () => {
    await expect(
      adapter.save!(KEY, "x".repeat(WORKSPACE_INSTRUCTIONS_MAX_CHARS + 1), undefined, ctx)
    ).rejects.toThrow("limited")
    const other = resourceKey("workspace-instructions", "ws-2")
    await expect(adapter.save!(other, "x", undefined, ctx)).rejects.toThrow("not found")
    expect(await adapter.read(other, ctx)).toBeUndefined()
  })

  it("reads a workspace the store does not hold from the context", async () => {
    useProjectStore.setState({ projects: [] } as never)
    expect(
      await adapter.read(KEY, { workspace: { ...ctx.workspace, customInstructions: "From ctx." } })
    ).toEqual({ key: KEY, text: "From ctx." })
  })
})
