import { applyMigrationArtifact, previewMigrationArtifact } from "./artifacts"
import type { MigrationPlan, MigrationPreviewCell } from "./types"

describe("migration artifact delegation", () => {
  it("previews settings and sessions through their existing subsystems", async () => {
    const deps = {
      previewSettings: jest.fn(async () => [{ id: "setting" }]),
      previewCommands: jest.fn(),
      previewSessions: jest.fn(async () => [
        { ref: { sourceId: "codex", originalSessionId: "s", locator: "x" } },
      ]),
      previewMcp: jest.fn(),
      previewSubagents: jest.fn(),
      previewSkills: jest.fn(),
      previewMemory: jest.fn(),
    }
    await expect(
      previewMigrationArtifact("codex", "settings", undefined, deps as never)
    ).resolves.toMatchObject({ items: [{ id: "setting" }] })
    await expect(
      previewMigrationArtifact("codex", "sessions", undefined, deps as never)
    ).resolves.toMatchObject({ items: [expect.anything()] })
  })

  it("applies project MCP together with Claude user MCP", async () => {
    const applyMcp = jest.fn(async () => ({ imported: 2, skipped: 0, warnings: [] }))
    const applyProjectMcp = jest.fn(async () => ({ imported: 1, skipped: 0, warnings: [] }))
    const cell: MigrationPreviewCell = {
      artifact: "mcp",
      status: "ready",
      count: 3,
      warnings: [],
      items: [],
    }
    const plan = { vendor: "claude-code", cwd: "/repo", strategy: "overwrite" } as MigrationPlan
    const result = await applyMigrationArtifact("claude-code", "mcp", cell, plan, undefined, {
      applySettings: jest.fn(),
      applyCommands: jest.fn(),
      applySessions: jest.fn(),
      applyMcp,
      applyProjectMcp,
      applySubagents: jest.fn(),
      applySkills: jest.fn(),
    } as never)
    expect(applyMcp).toHaveBeenCalledWith("claude-code", "overwrite")
    expect(applyProjectMcp).toHaveBeenCalledWith("/repo", "overwrite")
    expect(result.imported).toBe(3)
  })
})
