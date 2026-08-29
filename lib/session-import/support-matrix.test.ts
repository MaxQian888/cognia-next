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

  it("publishes verification metadata and graph support instead of stale prose counts", () => {
    const rows = buildExternalSessionSupportMatrix().importSources
    expect(rows).toHaveLength(11)
    expect(rows.every((row) => row.verifiedAt === "2026-08-29")).toBe(true)
    expect(rows.every((row) => row.graphImport)).toBe(true)
  })
})
