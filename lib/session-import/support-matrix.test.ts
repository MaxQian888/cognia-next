import { getSessionSources } from "./registry"
import { buildExternalSessionSupportMatrix } from "./support-matrix"

describe("external session support matrix", () => {
  it("derives every import source from the registry and every runtime from the preset catalog", () => {
    const matrix = buildExternalSessionSupportMatrix()
    expect(matrix.importSources.map((row) => row.sourceId)).toEqual(
      getSessionSources().map((source) => source.id)
    )
    expect(matrix.importSources.find((row) => row.sourceId === "codex")?.presetIds).toEqual([
      "codex",
      "codex-app-server",
    ])
    expect(matrix.importSources.find((row) => row.sourceId === "cursor")?.presetIds).toEqual([
      "cursor-cli",
    ])
    expect(matrix.runtimeOnlyPresetIds).toEqual(
      expect.arrayContaining(["kiro", "droid", "deepseek-harness-acp"])
    )
  })

  it("keeps a documented-only preset out of a source's resume candidates", () => {
    // `opencode-v2-preview` says in its own description that current OpenCode
    // V2 builds are not compatible with it. Listing it here would tell a user
    // an imported OpenCode session can resume into something that cannot run.
    const matrix = buildExternalSessionSupportMatrix()
    const opencode = matrix.importSources.find((row) => row.sourceId === "opencode")
    expect(opencode?.presetIds).toEqual(
      expect.arrayContaining(["opencode-server", "opencode-acp", "opencode-remote"])
    )
    expect(opencode?.presetIds).not.toContain("opencode-v2-preview")
    expect(opencode?.nativeResumeCandidate).toBe(true)
  })

  it("leaves a history-only source with no resume candidate", () => {
    const rows = buildExternalSessionSupportMatrix().importSources
    for (const sourceId of ["aider", "cline", "continue-dev"]) {
      const row = rows.find((candidate) => candidate.sourceId === sourceId)
      expect(row?.presetIds).toEqual([])
      expect(row?.nativeResumeCandidate).toBe(false)
    }
  })

  it("publishes verification metadata and graph support instead of stale prose counts", () => {
    const rows = buildExternalSessionSupportMatrix().importSources
    expect(rows).toHaveLength(11)
    expect(rows.every((row) => row.verifiedAt === "2026-08-29")).toBe(true)
    expect(rows.every((row) => row.graphImport)).toBe(true)
  })
})
