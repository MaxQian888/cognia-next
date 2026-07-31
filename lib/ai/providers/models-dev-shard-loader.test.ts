/**
 * @jest-environment node
 */
import { createHash, webcrypto } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { loadBundledModelsDevShards } from "./models-dev-shard-loader"

const shard = '{"openai":{"models":{"gpt-test":{"id":"gpt-test"}}}}\n'
const checksum = `sha256:${createHash("sha256").update(shard).digest("hex")}`

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
}

describe("loadBundledModelsDevShards", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  })

  it("loads checksummed provider shards through bounded static requests", async () => {
    const fetcher = jest.fn(async (url: string | URL | Request) =>
      String(url).endsWith("manifest.json")
        ? response({
            schemaVersion: 1,
            providers: [
              {
                id: "openai",
                path: "providers/openai.json",
                models: 1,
                bytes: shard.length,
                gzipBytes: shard.length,
                checksum,
              },
            ],
          })
        : response(shard)
    ) as unknown as typeof fetch

    const catalog = await loadBundledModelsDevShards({
      basePath: "/catalog/models-dev",
      fetcher,
    })

    expect(catalog.openai.models).toHaveProperty("gpt-test")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("loads every checked-in bundled provider shard", async () => {
    const catalogRoot = resolve(process.cwd(), "public/catalog/models-dev")
    const fetcher = jest.fn(async (url: string | URL | Request) => {
      const relativePath = String(url)
        .replace(/^\/catalog\/models-dev\//, "")
        .split("?", 1)[0]
      return response(await readFile(resolve(catalogRoot, relativePath), "utf8"))
    }) as unknown as typeof fetch

    const catalog = await loadBundledModelsDevShards({ fetcher })

    expect(catalog).toHaveProperty("abacus")
  })

  it("does not reuse a stale unversioned shard from the browser cache", async () => {
    const shardUrl = "/catalog/models-dev/providers/openai.json"
    const versionedShardUrl = `${shardUrl}?v=${encodeURIComponent(checksum)}`
    const staleShard = `${JSON.stringify(JSON.parse(shard), null, 2)}\n`
    const fetcher = jest.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl.endsWith("manifest.json")) {
        return response({
          schemaVersion: 1,
          providers: [
            {
              id: "openai",
              path: "providers/openai.json",
              models: 1,
              bytes: shard.length,
              gzipBytes: shard.length,
              checksum,
            },
          ],
        })
      }
      if (requestUrl === shardUrl) return response(staleShard)
      if (requestUrl === versionedShardUrl) return response(shard)
      return response("", 404)
    }) as unknown as typeof fetch

    await expect(loadBundledModelsDevShards({ fetcher })).resolves.toHaveProperty("openai")
    expect(fetcher).toHaveBeenCalledWith(
      versionedShardUrl,
      expect.objectContaining({ cache: "force-cache" })
    )
  })

  it("rejects a corrupt shard before returning a partial catalog", async () => {
    const fetcher = jest.fn(async (url: string | URL | Request) =>
      String(url).endsWith("manifest.json")
        ? response({
            schemaVersion: 1,
            providers: [
              {
                id: "openai",
                path: "providers/openai.json",
                models: 1,
                bytes: shard.length,
                gzipBytes: shard.length,
                checksum: "sha256:deadbeef",
              },
            ],
          })
        : response(shard)
    ) as unknown as typeof fetch

    await expect(loadBundledModelsDevShards({ fetcher })).rejects.toThrow(
      'checksum mismatch for "openai"'
    )
  })

  it("rejects unsafe shard paths in the manifest", async () => {
    const fetcher = jest.fn(async () =>
      response({
        schemaVersion: 1,
        providers: [
          {
            id: "openai",
            path: "../private.json",
            checksum,
          },
        ],
      })
    ) as unknown as typeof fetch

    await expect(loadBundledModelsDevShards({ fetcher })).rejects.toThrow("invalid provider entry")
  })
})
