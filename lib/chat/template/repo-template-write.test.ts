import { parseRepoTemplate } from "./repo-templates"
import { saveChatTemplateToRepository, type RepoTemplateWriteDeps } from "./repo-template-write"

const template = {
  name: "Review a PR",
  body: "Please review {{module}}.",
  params: [{ id: "module", label: "module", required: true, kind: "string" as const }],
}

function deps(overrides: Partial<RepoTemplateWriteDeps> = {}) {
  const written: { root: string; relPath: string; content: string }[] = []
  const dirs: string[] = []
  const resolved: RepoTemplateWriteDeps = {
    isRestricted: async () => false,
    exists: async () => false,
    createDir: async (_root, relPath) => {
      dirs.push(relPath)
    },
    writeFile: async (root, relPath, content) => {
      written.push({ root, relPath, content })
    },
    ...overrides,
  }
  return { resolved, written, dirs }
}

describe("saveChatTemplateToRepository", () => {
  it("writes the same document the picker reads back", async () => {
    const { resolved, written, dirs } = deps()

    const outcome = await saveChatTemplateToRepository("/repo", template, {}, resolved)

    expect(outcome).toEqual({ ok: true, path: ".cognia/templates/review-a-pr.md" })
    expect(dirs).toEqual([".cognia/templates"])
    expect(written).toHaveLength(1)
    expect(written[0].root).toBe("/repo")
    const parsed = parseRepoTemplate(written[0].relPath, written[0].content)
    expect(parsed?.name).toBe("Review a PR")
    expect(parsed?.body).toBe("Please review {{module}}.")
  })

  /**
   * The same verdict the reader asks for, and for a sharper reason: writing
   * into a checkout you have not trusted puts your text where the app treats it
   * as authoritative for everyone who clones it next.
   */
  it("refuses a workspace outside the trust boundary", async () => {
    const { resolved, written } = deps({ isRestricted: async () => true })

    const outcome = await saveChatTemplateToRepository("/repo", template, {}, resolved)

    expect(outcome).toEqual({
      ok: false,
      reason: "restricted",
      path: ".cognia/templates/review-a-pr.md",
    })
    expect(written).toEqual([])
  })

  it("treats a trust question nobody could answer as a refusal", async () => {
    const { resolved, written } = deps({
      isRestricted: async () => {
        throw new Error("no store")
      },
    })

    expect(await saveChatTemplateToRepository("/repo", template, {}, resolved)).toMatchObject({
      ok: false,
      reason: "restricted",
    })
    expect(written).toEqual([])
  })

  it("asks before replacing a file somebody else may have written", async () => {
    const { resolved, written } = deps({ exists: async () => true })

    expect(await saveChatTemplateToRepository("/repo", template, {}, resolved)).toMatchObject({
      ok: false,
      reason: "exists",
    })
    expect(written).toEqual([])
  })

  it("replaces it once the caller says so", async () => {
    const { resolved, written } = deps({ exists: async () => true })

    const outcome = await saveChatTemplateToRepository(
      "/repo",
      template,
      { overwrite: true },
      resolved
    )

    expect(outcome.ok).toBe(true)
    expect(written).toHaveLength(1)
  })

  // One needless question beats silently replacing a teammate's file.
  it("asks when the probe itself fails", async () => {
    const { resolved } = deps({
      exists: async () => {
        throw new Error("host refused")
      },
    })

    expect(await saveChatTemplateToRepository("/repo", template, {}, resolved)).toMatchObject({
      ok: false,
      reason: "exists",
    })
  })

  it("says there is no repository rather than throwing", async () => {
    const { resolved, written } = deps()

    expect(await saveChatTemplateToRepository(null, template, {}, resolved)).toMatchObject({
      ok: false,
      reason: "no-root",
    })
    expect(await saveChatTemplateToRepository("   ", template, {}, resolved)).toMatchObject({
      ok: false,
      reason: "no-root",
    })
    expect(written).toEqual([])
  })

  it("reports a host that refused the write instead of claiming success", async () => {
    const { resolved } = deps({
      writeFile: async () => {
        throw new Error("read-only")
      },
    })

    expect(await saveChatTemplateToRepository("/repo", template, {}, resolved)).toMatchObject({
      ok: false,
      reason: "failed",
    })
  })
})
