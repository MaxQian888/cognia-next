import path from "node:path"

import {
  BUILTIN_ASSET_URL_PREFIX,
  makeNodeBuiltinAssetFetcher,
  resolveBuiltinAssetRoot,
} from "./builtin-asset-fetcher"

const CHUNK_URL = `${BUILTIN_ASSET_URL_PREFIX}cognia-visualize/abc.cjs`

describe("resolveBuiltinAssetRoot", () => {
  it("prefers an explicit override even when it holds no chunks", () => {
    expect(
      resolveBuiltinAssetRoot({
        env: { COGNIA_BUILTIN_PLUGIN_ASSETS: "/opt/chunks" },
        exists: () => false,
      })
    ).toBe("/opt/chunks")
  })

  it("finds the tree staged next to the executable", () => {
    const root = resolveBuiltinAssetRoot({
      env: {},
      execPath: path.join("/app", "brain", "node"),
      exists: (candidate) => candidate === path.join("/app", "brain", "_cognia", "builtin-plugins"),
    })

    expect(root).toBe(path.join("/app", "brain"))
  })

  it("walks up from the bundle and accepts the repo's own public/ tree", () => {
    const repo = path.join("/repo")
    const root = resolveBuiltinAssetRoot({
      env: {},
      execPath: "/usr/bin/node",
      moduleDir: path.join(repo, "cli", "dist", "chunks"),
      exists: (candidate) => candidate === path.join(repo, "public", "_cognia", "builtin-plugins"),
    })

    expect(root).toBe(path.join(repo, "public"))
  })

  it("returns undefined when no tree is reachable", () => {
    expect(
      resolveBuiltinAssetRoot({
        env: {},
        execPath: "/usr/bin/node",
        moduleDir: "/nowhere/deep/inside",
        exists: () => false,
      })
    ).toBeUndefined()
  })
})

describe("makeNodeBuiltinAssetFetcher", () => {
  const stagedExists = (candidate: string) =>
    candidate === path.join("/layout", "_cognia", "builtin-plugins")

  it("reads the chunk off disk and returns exactly its bytes", async () => {
    const bytes = Buffer.from("module.exports = {}\n")
    // A pooled Buffer whose `.buffer` is a larger slab — the fetcher must copy
    // the view, or the digest check downstream hashes unrelated bytes.
    const pooled = Buffer.from(new Uint8Array([...Buffer.alloc(8), ...bytes])).subarray(8)
    const fetcher = makeNodeBuiltinAssetFetcher({
      env: {},
      execPath: path.join("/layout", "node"),
      exists: stagedExists,
      readFile: () => pooled,
    })

    const response = await fetcher(CHUNK_URL)

    expect(response.ok).toBe(true)
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it("names the missing tree and the command that produces it", async () => {
    const fetcher = makeNodeBuiltinAssetFetcher({
      env: {},
      execPath: "/usr/bin/node",
      moduleDir: "/nowhere",
      exists: () => false,
    })

    await expect(fetcher(CHUNK_URL)).rejects.toThrow("pnpm plugin:builtin:build")
  })

  it("reports the path when the chunk itself is unreadable", async () => {
    const fetcher = makeNodeBuiltinAssetFetcher({
      env: {},
      execPath: path.join("/layout", "node"),
      exists: stagedExists,
      readFile: () => {
        throw new Error("ENOENT")
      },
    })

    await expect(fetcher(CHUNK_URL)).rejects.toThrow(
      path.join("/layout", "_cognia", "builtin-plugins", "cognia-visualize", "abc.cjs")
    )
  })

  it("refuses a traversing chunk path", async () => {
    const fetcher = makeNodeBuiltinAssetFetcher({
      env: {},
      execPath: path.join("/layout", "node"),
      exists: stagedExists,
      readFile: () => Buffer.from(""),
    })

    await expect(fetcher(`${BUILTIN_ASSET_URL_PREFIX}../../etc/passwd`)).rejects.toThrow(
      "unsafe path"
    )
  })

  it("delegates every other URL to the host fetch", async () => {
    const fallbackFetch = jest.fn().mockResolvedValue(new Response("ok"))
    const fetcher = makeNodeBuiltinAssetFetcher({
      env: {},
      fallbackFetch: fallbackFetch as unknown as typeof fetch,
    })

    await fetcher("https://example.test/thing.js")

    expect(fallbackFetch).toHaveBeenCalledWith("https://example.test/thing.js", undefined)
  })
})
