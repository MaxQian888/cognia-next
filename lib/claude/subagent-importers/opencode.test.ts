import {
  enabledToolsFromMap,
  looksLikeOpencodeAgentPath,
  opencodeAdapter,
  splitNamespacedModel,
} from "./opencode"
import type { ImportFile } from "./types"

function file(path: string, content: string, filename?: string): ImportFile {
  const fname = filename ?? path.split("/").pop() ?? path
  return { filename: fname, sourcePath: path, content }
}

const REVIEWER = `---
description: Reviews code for quality and correctness.
mode: subagent
model: anthropic/claude-sonnet-4-20250514
temperature: 0.1
tools:
  write: false
  edit: false
  bash: true
  read: true
---

You are a meticulous code reviewer.
`

const GLOBAL_PATH = "/home/u/.config/opencode/agents/code-reviewer.md"
const PROJECT_PATH = "/repo/.opencode/agents/planner.md"

describe("opencodeAdapter.detect", () => {
  it("matches when every file sits in an opencode agent dir", () => {
    expect(opencodeAdapter.detect({ files: [file(GLOBAL_PATH, REVIEWER)] })).toBe("match")
    expect(opencodeAdapter.detect({ files: [file(PROJECT_PATH, REVIEWER)] })).toBe("match")
  })

  it("is a maybe when only some files carry the path hint", () => {
    const files = [file(GLOBAL_PATH, REVIEWER), file("/tmp/notes.md", "# hi")]
    expect(opencodeAdapter.detect({ files })).toBe("maybe")
  })

  it("falls back to the frontmatter fingerprint when the path gives nothing away", () => {
    // No path hint, no `name:`, but `mode:` is present → OpenCode-shaped.
    expect(opencodeAdapter.detect({ files: [file("/tmp/reviewer.md", REVIEWER)] })).toBe("maybe")
  })

  it("fingerprints a tools MAP even without a mode key", () => {
    const content = `---
description: x
tools:
  bash: true
---
Body.
`
    expect(opencodeAdapter.detect({ files: [file("/tmp/agent.md", content)] })).toBe("maybe")
  })

  it("declines a Claude Code agent (it has a name and a tools list)", () => {
    const claude = `---
name: code-reviewer
description: Reviews code.
tools: Read, Grep
---
Body.
`
    expect(opencodeAdapter.detect({ files: [file("/home/u/.claude/agents/r.md", claude)] })).toBe(
      "no"
    )
  })

  it("declines when there are no markdown files at all", () => {
    expect(opencodeAdapter.detect({ files: [file("/a/b.json", "{}")] })).toBe("no")
    expect(opencodeAdapter.detect({ files: [] })).toBe("no")
  })

  it("declines rather than throwing on malformed YAML with no path hint", () => {
    expect(opencodeAdapter.detect({ files: [file("/tmp/bad.md", "---\n: :\n---\nx")] })).toBe("no")
  })
})

describe("opencodeAdapter.parse", () => {
  it("takes the name from the filename, since OpenCode has no name key", () => {
    const { drafts } = opencodeAdapter.parse({ files: [file(GLOBAL_PATH, REVIEWER)] })
    expect(drafts).toHaveLength(1)
    expect(drafts[0].name).toBe("code reviewer")
    expect(drafts[0].sourceKey).toBe("opencode:code-reviewer")
    expect(drafts[0].sourceFile).toBe(GLOBAL_PATH)
    expect(drafts[0].description).toBe("Reviews code for quality and correctness.")
    expect(drafts[0].systemPrompt).toBe("You are a meticulous code reviewer.")
  })

  it("honours an explicit name when a user hand-added one", () => {
    const content = REVIEWER.replace("mode: subagent", "mode: subagent\nname: Custom Name")
    const { drafts } = opencodeAdapter.parse({ files: [file(GLOBAL_PATH, content)] })
    expect(drafts[0].name).toBe("Custom Name")
  })

  it("keeps only the ENABLED tools from the tools map", () => {
    const { drafts } = opencodeAdapter.parse({ files: [file(GLOBAL_PATH, REVIEWER)] })
    expect(drafts[0].tools).toEqual(["bash", "read"])
  })

  it("splits the namespaced model into a bare id + provider hint", () => {
    const { drafts } = opencodeAdapter.parse({ files: [file(GLOBAL_PATH, REVIEWER)] })
    expect(drafts[0].model).toBe("claude-sonnet-4-20250514")
    expect(drafts[0].providerHint).toBe("anthropic")
  })

  it("retains the raw frontmatter for round-tripping", () => {
    const { drafts } = opencodeAdapter.parse({ files: [file(GLOBAL_PATH, REVIEWER)] })
    expect(drafts[0].rawFrontmatter?.temperature).toBe(0.1)
  })

  it("warns — but still imports — a primary agent", () => {
    const content = REVIEWER.replace("mode: subagent", "mode: primary")
    const { drafts } = opencodeAdapter.parse({ files: [file(GLOBAL_PATH, content)] })
    expect(drafts).toHaveLength(1)
    expect(drafts[0].warnings.join(" ")).toMatch(/primary agent/)
  })

  it("warns when every tool is disabled and inherits instead", () => {
    const content = `---
description: x
tools:
  write: false
---
Body.
`
    const { drafts } = opencodeAdapter.parse({ files: [file(GLOBAL_PATH, content)] })
    expect(drafts[0].tools).toBeUndefined()
    expect(drafts[0].warnings.join(" ")).toMatch(/Every tool is disabled/)
  })

  it("warns that OpenCode permission rules are not imported", () => {
    const content = `---
description: x
permission:
  edit: deny
---
Body.
`
    const { drafts } = opencodeAdapter.parse({ files: [file(GLOBAL_PATH, content)] })
    expect(drafts[0].warnings.join(" ")).toMatch(/permission rules/)
  })

  it("reports malformed YAML as a non-fatal error", () => {
    const { drafts, errors } = opencodeAdapter.parse({
      files: [file(GLOBAL_PATH, "---\n: :\n---\nbody"), file(PROJECT_PATH, REVIEWER)],
    })
    expect(errors).toHaveLength(1)
    expect(errors[0].filename).toBe("code-reviewer.md")
    // A bad file never sinks the good ones.
    expect(drafts).toHaveLength(1)
  })

  it("rejects an empty body", () => {
    const { drafts, errors } = opencodeAdapter.parse({
      files: [file(GLOBAL_PATH, "---\ndescription: x\n---\n")],
    })
    expect(drafts).toHaveLength(0)
    expect(errors[0].error).toMatch(/Empty body/)
  })

  it("skips non-markdown files entirely", () => {
    const { drafts, errors } = opencodeAdapter.parse({ files: [file("/a/opencode.json", "{}")] })
    expect(drafts).toHaveLength(0)
    expect(errors).toHaveLength(0)
  })
})

describe("enabledToolsFromMap", () => {
  it("keeps only true values and trims the keys", () => {
    expect(enabledToolsFromMap({ " bash ": true, edit: false, read: true })).toEqual([
      "bash",
      "read",
    ])
  })

  it("returns undefined for a non-map, an array, or an all-false map", () => {
    expect(enabledToolsFromMap(undefined)).toBeUndefined()
    expect(enabledToolsFromMap("bash, read")).toBeUndefined()
    expect(enabledToolsFromMap(["bash"])).toBeUndefined()
    expect(enabledToolsFromMap({ bash: false })).toBeUndefined()
    // Truthy-but-not-true values are not an opt-in.
    expect(enabledToolsFromMap({ bash: "yes" })).toBeUndefined()
  })
})

describe("splitNamespacedModel", () => {
  it("maps known provider prefixes", () => {
    expect(splitNamespacedModel("anthropic/claude-x")).toEqual({
      model: "claude-x",
      providerHint: "anthropic",
    })
    expect(splitNamespacedModel("github-copilot/gpt-4o")).toEqual({
      model: "gpt-4o",
      providerHint: "openai",
    })
    expect(splitNamespacedModel("google-vertex/gemini-pro")).toEqual({
      model: "gemini-pro",
      providerHint: "gemini",
    })
  })

  it("keeps the full id when the provider is unknown or absent", () => {
    expect(splitNamespacedModel("someprovider/x")).toEqual({ model: "someprovider/x" })
    expect(splitNamespacedModel("gpt-4o")).toEqual({ model: "gpt-4o" })
    expect(splitNamespacedModel("/leading-slash")).toEqual({ model: "/leading-slash" })
    expect(splitNamespacedModel(undefined)).toEqual({})
  })

  it("falls back to the namespaced id when the model half is empty", () => {
    expect(splitNamespacedModel("anthropic/")).toEqual({
      model: "anthropic/",
      providerHint: "anthropic",
    })
  })
})

describe("looksLikeOpencodeAgentPath", () => {
  it("recognizes both layouts and normalizes Windows separators", () => {
    expect(looksLikeOpencodeAgentPath(GLOBAL_PATH)).toBe(true)
    expect(looksLikeOpencodeAgentPath(PROJECT_PATH)).toBe(true)
    expect(looksLikeOpencodeAgentPath("C:\\Users\\u\\.config\\opencode\\agents\\x.md")).toBe(true)
    expect(looksLikeOpencodeAgentPath("/home/u/.config/opencode/agent/legacy.md")).toBe(true)
    expect(looksLikeOpencodeAgentPath("/home/u/.claude/agents/x.md")).toBe(false)
  })
})
