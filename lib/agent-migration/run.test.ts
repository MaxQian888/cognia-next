import { applyMigration, buildMigrationPreview } from "./run"
import { MIGRATION_ARTIFACTS } from "./types"

describe("migration orchestration", () => {
  it("normalizes ready, empty, and shared preview cells", async () => {
    const previewArtifact = jest.fn(async (_vendor, artifact) => ({
      items: artifact === "settings" ? [{ id: "one" }] : [],
      warnings: artifact === "mcp" ? ["parse warning"] : [],
    }))
    const preview = await buildMigrationPreview("claude-code", MIGRATION_ARTIFACTS, {
      previewArtifact,
    })
    expect(preview.artifacts.settings).toMatchObject({ status: "ready", count: 1 })
    expect(preview.artifacts.commands).toMatchObject({ status: "shared" })
    expect(preview.artifacts.sessions).toMatchObject({ status: "empty" })
  })

  it("applies artifacts sequentially, reports progress, and stops on abort", async () => {
    const controller = new AbortController()
    const applyArtifact = jest.fn(async (_vendor, artifact) => {
      if (artifact === "settings") controller.abort()
      return { imported: 1, warnings: [] }
    })
    const onProgress = jest.fn()
    const result = await applyMigration(
      {
        vendor: "codex",
        artifacts: ["settings", "sessions"],
        strategy: "overwrite",
        preview: {
          vendor: "codex",
          artifacts: {
            settings: {
              artifact: "settings",
              status: "ready",
              count: 1,
              warnings: [],
              items: [{}],
            },
            sessions: {
              artifact: "sessions",
              status: "ready",
              count: 1,
              warnings: [],
              items: [{}],
            },
          },
        },
      },
      { applyArtifact },
      onProgress,
      controller.signal
    )
    expect(applyArtifact).toHaveBeenCalledTimes(1)
    expect(result.aborted).toBe(true)
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ artifact: "settings", phase: "completed" })
    )
  })
})
