import {
  parseGithubPluginRef,
  fetchGithubFile,
  fetchGithubPluginPreview,
  makeGithubMarketplaceClient,
  type GithubPluginPreview,
} from "./github-source"
import type { PluginManifest } from "@/types/plugin"

const installPluginFromGithub = jest.fn()
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({ installPluginFromGithub }),
}))

const MANIFEST = { id: "demo.plugin", name: "Demo", version: "1.0.0", type: "frontend" }

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64")
}

function fileResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ type: "file", encoding: "base64", content: b64(text) }),
  } as unknown as Response
}

function commitResponse(sha = "0123456789abcdef0123456789abcdef01234567") {
  return { ok: true, status: 200, json: async () => ({ sha }) } as unknown as Response
}

function dirResponse(entries: Array<{ type: string; path: string }>) {
  return { ok: true, status: 200, json: async () => entries } as unknown as Response
}

function notFound() {
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
}

describe("parseGithubPluginRef", () => {
  it("parses owner/repo shorthand", () => {
    expect(parseGithubPluginRef("acme/cool")).toEqual({
      owner: "acme",
      repo: "cool",
      ref: undefined,
      subdir: undefined,
    })
  })

  it("reads @ref and strips .git", () => {
    expect(parseGithubPluginRef("acme/cool.git@v2")).toEqual({
      owner: "acme",
      repo: "cool",
      ref: "v2",
      subdir: undefined,
    })
  })

  it("parses a shorthand subdir", () => {
    expect(parseGithubPluginRef("acme/mono/packages/a")).toEqual({
      owner: "acme",
      repo: "mono",
      ref: undefined,
      subdir: "packages/a",
    })
  })

  it("parses a github tree URL with ref + subdir", () => {
    expect(parseGithubPluginRef("https://github.com/acme/mono/tree/main/packages/a")).toEqual({
      owner: "acme",
      repo: "mono",
      ref: "main",
      subdir: "packages/a",
    })
  })

  it("throws on a bare token", () => {
    expect(() => parseGithubPluginRef("nope")).toThrow()
    expect(() => parseGithubPluginRef("")).toThrow()
  })
})

describe("fetchGithubPluginPreview", () => {
  afterEach(() => jest.restoreAllMocks())

  it("fetches manifest + README + LICENSE at the repo root", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) return commitResponse()
      if (url.includes("/contents/plugin.json")) return fileResponse(JSON.stringify(MANIFEST))
      if (url.includes("/contents/README.md")) return fileResponse("# Demo")
      if (url.includes("/contents/LICENSE")) return fileResponse("MIT")
      return notFound()
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const preview = await fetchGithubPluginPreview({ owner: "acme", repo: "cool" })
    expect(preview.manifest.id).toBe("demo.plugin")
    expect(preview.readme).toBe("# Demo")
    expect(preview.license).toBe("MIT")
    expect(preview.ref.ref).toBe("0123456789abcdef0123456789abcdef01234567")
  })

  it("probes one directory level when the root has no plugin.json", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) return commitResponse()
      if (url.includes("/contents/plugin.json")) return notFound()
      // root listing
      if (url.includes("/contents/?ref=")) {
        return dirResponse([
          { type: "dir", path: "packages" },
          { type: "file", path: "README.md" },
        ])
      }
      if (url.includes("/contents/packages/plugin.json")) {
        return fileResponse(JSON.stringify(MANIFEST))
      }
      return notFound()
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const preview = await fetchGithubPluginPreview({ owner: "acme", repo: "mono" })
    expect(preview.manifest.id).toBe("demo.plugin")
    expect(preview.ref.subdir).toBe("packages")
    expect(preview.readme).toBeNull()
  })

  it("requires a subdir when multiple immediate plugin roots exist", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) return commitResponse()
      if (url.includes("/contents/?ref=")) {
        return dirResponse([
          { type: "dir", path: "plugin-a" },
          { type: "dir", path: "plugin-b" },
        ])
      }
      if (url.includes("/contents/plugin-a/plugin.json")) {
        return fileResponse(JSON.stringify({ ...MANIFEST, id: "plugin-a" }))
      }
      if (url.includes("/contents/plugin-b/plugin.json")) {
        return fileResponse(JSON.stringify({ ...MANIFEST, id: "plugin-b" }))
      }
      return notFound()
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchGithubPluginPreview({ owner: "acme", repo: "plugin-collection" })
    ).rejects.toThrow(/multiple plugin roots.*plugin-a, plugin-b/i)
  })

  it("throws when no supported plugin manifest is found", async () => {
    global.fetch = jest.fn(async (url: string) =>
      url.includes("/commits/") ? commitResponse() : notFound()
    ) as unknown as typeof fetch
    await expect(fetchGithubPluginPreview({ owner: "a", repo: "b" })).rejects.toThrow(
      /no supported plugin manifest/i
    )
  })

  it("returns null for non-file content responses and reports API errors", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(dirResponse([{ type: "file", path: "nested" }]))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      } as unknown as Response) as unknown as typeof fetch

    await expect(fetchGithubFile({ owner: "a", repo: "b" }, "directory")).resolves.toBeNull()
    await expect(fetchGithubFile({ owner: "a", repo: "b" }, "failure")).rejects.toThrow(
      /GitHub API 503/
    )
  })

  it("rejects an invalid resolved commit and a missing explicit subdir", async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) {
        return { ok: true, status: 200, json: async () => ({ sha: "short" }) } as Response
      }
      return notFound()
    }) as unknown as typeof fetch
    await expect(fetchGithubPluginPreview({ owner: "a", repo: "b" })).rejects.toThrow(
      /invalid commit/
    )

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) return commitResponse()
      return notFound()
    }) as unknown as typeof fetch
    await expect(
      fetchGithubPluginPreview({
        owner: "a",
        repo: "b",
        subdir: "packages/missing",
      })
    ).rejects.toThrow(/under packages\/missing/)
  })

  it("discovers a plugin deeper than one directory", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) return commitResponse()
      if (url.includes("/contents/packages/deep/plugin.json")) {
        return fileResponse(JSON.stringify(MANIFEST))
      }
      if (url.includes("/contents/packages/deep?ref=")) {
        return dirResponse([{ type: "file", path: "packages/deep/plugin.json" }])
      }
      if (url.includes("/contents/?ref=")) {
        return dirResponse([
          { type: "file", path: "packages/deep/plugin.json" },
          { type: "file", path: undefined as unknown as string },
        ])
      }
      return notFound()
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const preview = await fetchGithubPluginPreview({ owner: "a", repo: "deep" })
    expect(preview.ref.subdir).toBe("packages/deep")
  })

  it("rejects oversized text files before conversion", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) return commitResponse()
      if (url.includes("/contents/plugin.json")) {
        return fileResponse(JSON.stringify(MANIFEST))
      }
      if (url.includes("/contents/?ref=")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { type: "file", path: "plugin.json", size: 100 },
            { type: "file", path: "src/huge.ts", size: 1_000_001 },
          ],
        } as Response
      }
      return notFound()
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(fetchGithubPluginPreview({ owner: "a", repo: "large" })).rejects.toThrow(
      /too large/
    )
  })

  it("throws on invalid manifest JSON", async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) return commitResponse()
      return url.includes("plugin.json") ? fileResponse("not json{") : notFound()
    }) as unknown as typeof fetch
    await expect(fetchGithubPluginPreview({ owner: "a", repo: "b" })).rejects.toThrow(/valid JSON/i)
  })

  it("auto-detects and converts a Claude Code plugin for preview and installation", async () => {
    const claudeManifest = {
      name: "claude-review",
      version: "1.0.0",
      description: "Claude review helpers",
      skills: "./skills",
    }
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) return commitResponse()
      if (url.includes("/contents/plugin.json")) return notFound()
      if (url.includes("/contents/.claude-plugin/plugin.json")) {
        return fileResponse(JSON.stringify(claudeManifest))
      }
      if (url.includes("/contents/?ref=")) {
        return dirResponse([
          { type: "dir", path: ".claude-plugin" },
          { type: "dir", path: "skills" },
          { type: "file", path: "README.md" },
        ])
      }
      if (url.includes("/contents/.claude-plugin?ref=")) {
        return dirResponse([{ type: "file", path: ".claude-plugin/plugin.json" }])
      }
      if (url.includes("/contents/skills?ref=")) {
        return dirResponse([{ type: "dir", path: "skills/review" }])
      }
      if (url.includes("/contents/skills/review?ref=")) {
        return dirResponse([{ type: "file", path: "skills/review/SKILL.md" }])
      }
      if (url.includes("/contents/skills/review/SKILL.md")) {
        return fileResponse(
          "---\nname: Review\ndescription: Review changes\n---\nReview every changed line."
        )
      }
      if (url.includes("/contents/README.md")) return fileResponse("# Claude Review")
      return notFound()
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const preview = await fetchGithubPluginPreview({ owner: "acme", repo: "claude-review" })
    expect(preview.sourceFormat).toBe("claude-code")
    expect(preview.manifest).toMatchObject({
      id: "claude-review",
      capabilities: ["skills"],
    })
    expect(preview.conversionReport.fidelity).toBe("structured")
    expect(preview.generatedFiles["plugin.json"]).toContain('"id": "claude-review"')
    expect(preview.generatedFiles["dist/index.js"]).toContain("claude-review")
  })
})

describe("makeGithubMarketplaceClient", () => {
  beforeEach(() => installPluginFromGithub.mockReset())

  const preview: GithubPluginPreview = {
    manifest: MANIFEST as unknown as PluginManifest,
    readme: "# Demo",
    license: "MIT",
    ref: { owner: "acme", repo: "cool", ref: "main", subdir: "packages/a" },
    sourceFormat: "cognia",
    conversionReport: {
      fidelity: "native-exact",
      converted: [],
      warnings: [],
      blocking: [],
    },
    generatedFiles: {},
  }

  it("getPlugin returns the preview manifest", async () => {
    const client = makeGithubMarketplaceClient(preview.ref, preview)
    const entry = await client.getPlugin("demo.plugin")
    expect(entry?.manifest.id).toBe("demo.plugin")
  })

  it("installPlugin delegates to the manager with repo/ref/subdir", async () => {
    installPluginFromGithub.mockResolvedValue({ id: "demo.plugin" })
    const client = makeGithubMarketplaceClient(preview.ref, preview)
    await client.installPlugin("demo.plugin")
    expect(installPluginFromGithub).toHaveBeenCalledWith("acme/cool", "main", "packages/a", {})
  })
})
