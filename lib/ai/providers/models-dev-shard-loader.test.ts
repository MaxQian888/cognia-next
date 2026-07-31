/**
 * @jest-environment node
 */
import { createHash, webcrypto } from "node:crypto"

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
