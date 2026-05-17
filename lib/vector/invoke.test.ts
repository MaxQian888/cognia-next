/**
 * @jest-environment jsdom
 */

import { vectorCloudInvoke, isHealthy, healthReason } from "./invoke"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

import { invoke } from "@tauri-apps/api/core"
const invokeMock = invoke as jest.MockedFunction<typeof invoke>

beforeEach(() => invokeMock.mockReset())

describe("vectorCloudInvoke", () => {
  test("saveCredentials calls vector_save_credentials with configId+credentials", async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await vectorCloudInvoke.saveCredentials("cfg1", {
      provider: "pinecone",
      api_key: "k",
      index_name: "rag",
    })
    expect(invokeMock).toHaveBeenCalledWith("vector_save_credentials", {
      configId: "cfg1",
      credentials: { provider: "pinecone", api_key: "k", index_name: "rag" },
    })
  })

  test("listConfigured returns Promise<string[]>", async () => {
    invokeMock.mockResolvedValueOnce(["pinecone-default", "qdrant-eu"])
    const ids = await vectorCloudInvoke.listConfigured()
    expect(ids).toEqual(["pinecone-default", "qdrant-eu"])
    expect(invokeMock).toHaveBeenCalledWith("vector_list_configured_providers")
  })

  test("createCollection passes the request payload", async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await vectorCloudInvoke.createCollection(
      { provider: "pinecone", configId: "cfg1" },
      {
        name: "rag",
        dimension: 1536,
        embedding_model: "text-embedding-3-small",
      }
    )
    expect(invokeMock).toHaveBeenCalledWith("vector_cloud_create_collection", {
      provider: "pinecone",
      configId: "cfg1",
      request: {
        name: "rag",
        dimension: 1536,
        embedding_model: "text-embedding-3-small",
      },
    })
  })

  test("query passes provider, configId, collection, queryVector, options", async () => {
    invokeMock.mockResolvedValueOnce({
      results: [],
      total: 0,
      offset: 0,
      limit: 10,
    })
    await vectorCloudInvoke.query({ provider: "qdrant", configId: "cfg2" }, "docs", [0.1, 0.2], {
      limit: 5,
      include_payload: true,
    })
    expect(invokeMock).toHaveBeenCalledWith("vector_cloud_query", {
      provider: "qdrant",
      configId: "cfg2",
      collection: "docs",
      queryVector: [0.1, 0.2],
      options: { limit: 5, include_payload: true },
    })
  })

  test("count returns the unwrapped number", async () => {
    invokeMock.mockResolvedValueOnce(42)
    const n = await vectorCloudInvoke.count(
      { provider: "chroma", configId: "cfg3" },
      "docs",
      undefined
    )
    expect(n).toBe(42)
  })
})

describe("HealthStatus helpers", () => {
  test("isHealthy detects the simple variant", () => {
    expect(isHealthy("healthy")).toBe(true)
    expect(isHealthy({ degraded: { reason: "slow" } })).toBe(false)
    expect(isHealthy({ unreachable: { reason: "down" } })).toBe(false)
  })

  test("healthReason extracts the reason from non-healthy variants", () => {
    expect(healthReason("healthy")).toBeUndefined()
    expect(healthReason({ degraded: { reason: "slow" } })).toBe("slow")
    expect(healthReason({ unreachable: { reason: "down" } })).toBe("down")
  })
})
