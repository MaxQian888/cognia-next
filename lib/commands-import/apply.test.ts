import { applyCommandsImport } from "./apply"
import type { CommandImportDraft } from "./types"

const command = (name: string): CommandImportDraft => ({
  id: `codex:${name}`,
  source: "codex",
  sourcePath: `/codex/${name}.md`,
  name,
  description: "Imported",
  body: "Run it",
  warnings: [],
  shared: false,
})

describe("applyCommandsImport", () => {
  it("skips conflicts or creates a unique duplicate through the existing writer", async () => {
    const save = jest.fn(async ({ name }: { name: string }) => `/claude/${name}.md`)
    const deps = {
      listExisting: jest.fn(async () => [{ name: "review" }]),
      save,
      refresh: jest.fn(async () => []),
    }
    await expect(
      applyCommandsImport([command("review")], "skip", deps as never)
    ).resolves.toMatchObject({ skipped: 1 })
    await expect(
      applyCommandsImport([command("review")], "duplicate", deps as never)
    ).resolves.toMatchObject({ imported: 1 })
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "review-2", scope: "user" })
    )
    expect(deps.refresh).toHaveBeenCalled()
  })
})
