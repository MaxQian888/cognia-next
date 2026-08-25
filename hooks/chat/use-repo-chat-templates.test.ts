import { loadRepoChatTemplates } from "./use-repo-chat-templates"

const FILES: Record<string, string> = {
  ".cognia/templates/review.md": "---\nname: Review\n---\nReview {{module}}",
  ".cognia/templates/bug.md": "Report {{what}}",
}

function deps(over: Partial<Parameters<typeof loadRepoChatTemplates>[1]> = {}) {
  return {
    isRestricted: async () => false,
    listDir: async () => Object.keys(FILES).map((relPath) => ({ relPath, isDir: false })),
    readFile: async (_root: string, relPath: string) => {
      const text = FILES[relPath]
      if (text === undefined) throw new Error("not found")
      return text
    },
    ...over,
  }
}

describe("loadRepoChatTemplates", () => {
  it("reads every markdown file in the templates directory", async () => {
    const templates = await loadRepoChatTemplates("/repo", deps())
    expect(templates.map((t) => t.id)).toEqual(["repo:review", "repo:bug"])
    expect(templates[0].source).toBe("repo")
  })

  // The same verdict the send path uses — not a kinder one written for a picker.
  it("reads nothing at all from an untrusted checkout", async () => {
    const listDir = jest.fn()
    const templates = await loadRepoChatTemplates(
      "/repo",
      deps({ isRestricted: async () => true, listDir })
    )
    expect(templates).toEqual([])
    expect(listDir).not.toHaveBeenCalled()
  })

  // A trust check that throws must not be read as "trusted".
  it("treats a failed trust check as untrusted", async () => {
    const listDir = jest.fn()
    const templates = await loadRepoChatTemplates(
      "/repo",
      deps({
        isRestricted: async () => {
          throw new Error("db down")
        },
        listDir,
      })
    )
    expect(templates).toEqual([])
    expect(listDir).not.toHaveBeenCalled()
  })

  it("says nothing when the directory is absent, which is most repositories", async () => {
    const templates = await loadRepoChatTemplates(
      "/repo",
      deps({
        listDir: async () => {
          throw new Error("no such file or directory")
        },
      })
    )
    expect(templates).toEqual([])
  })

  it("skips a file it cannot read without losing the others", async () => {
    const templates = await loadRepoChatTemplates(
      "/repo",
      deps({
        listDir: async () => [
          { relPath: ".cognia/templates/broken.md", isDir: false },
          { relPath: ".cognia/templates/review.md", isDir: false },
        ],
      })
    )
    expect(templates.map((t) => t.id)).toEqual(["repo:review"])
  })

  it("ignores subdirectories and non-markdown files", async () => {
    const templates = await loadRepoChatTemplates(
      "/repo",
      deps({
        listDir: async () => [
          { relPath: ".cognia/templates/nested", isDir: true },
          { relPath: ".cognia/templates/notes.txt", isDir: false },
          { relPath: ".cognia/templates/review.md", isDir: false },
        ],
      })
    )
    expect(templates.map((t) => t.id)).toEqual(["repo:review"])
  })

  // Two files whose ids collide would leave a draft unable to say which it quoted.
  it("keeps only the first of two files that share an id", async () => {
    const templates = await loadRepoChatTemplates(
      "/repo",
      deps({
        listDir: async () => [
          { relPath: ".cognia/templates/review.md", isDir: false },
          { relPath: ".cognia/templates/review.mdx", isDir: false },
        ],
        readFile: async () => "Review {{module}}",
      })
    )
    expect(templates).toHaveLength(1)
    expect(templates[0].sourcePath).toBe(".cognia/templates/review.md")
  })

  it("has nothing to read without a workspace", async () => {
    const isRestricted = jest.fn()
    expect(await loadRepoChatTemplates(null, deps({ isRestricted }))).toEqual([])
    expect(isRestricted).not.toHaveBeenCalled()
  })
})
