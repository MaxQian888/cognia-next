import {
  parseGithubPluginRef,
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
  })

  it("probes one directory level when the root has no plugin.json", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith("/contents/plugin.json")) return notFound()
      // root listing
      if (url.endsWith("/contents/")) {
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

  it("throws when no plugin.json is found", async () => {
    global.fetch = jest.fn(async () => notFound()) as unknown as typeof fetch
    await expect(fetchGithubPluginPreview({ owner: "a", repo: "b" })).rejects.toThrow(
      /no plugin.json/i
    )
  })

  it("throws on invalid manifest JSON", async () => {
    global.fetch = jest.fn(async (url: string) =>
      url.includes("plugin.json") ? fileResponse("not json{") : notFound()
    ) as unknown as typeof fetch
    await expect(fetchGithubPluginPreview({ owner: "a", repo: "b" })).rejects.toThrow(/valid JSON/i)
  })
})

describe("makeGithubMarketplaceClient", () => {
  beforeEach(() => installPluginFromGithub.mockReset())

  const preview: GithubPluginPreview = {
    manifest: MANIFEST as unknown as PluginManifest,
    readme: "# Demo",
    license: "MIT",
    ref: { owner: "acme", repo: "cool", ref: "main", subdir: "packages/a" },
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
    expect(installPluginFromGithub).toHaveBeenCalledWith("acme/cool", "main", "packages/a")
  })
})
