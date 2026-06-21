/**
 * @jest-environment jsdom
 */

import { migrateVectorCredentials } from "./credential-migration"

jest.mock("../invoke", () => ({
  vectorCloudInvoke: {
    saveCredentials: jest.fn().mockResolvedValue(undefined),
  },
}))

import { vectorCloudInvoke } from "../invoke"
const saveCredsMock = vectorCloudInvoke.saveCredentials as jest.MockedFunction<
  typeof vectorCloudInvoke.saveCredentials
>

beforeEach(() => {
  jest.clearAllMocks()
  window.localStorage.clear()
})

describe("migrateVectorCredentials", () => {
  test("no-op when migration flag is already set", async () => {
    window.localStorage.setItem("vector-credentials-migrated", "true")
    window.localStorage.setItem(
      "cognia-vector-settings",
      JSON.stringify({ state: { settings: { pineconeApiKey: "k" } } })
    )
    const r = await migrateVectorCredentials()
    expect(r.ran).toBe(false)
    expect(saveCredsMock).not.toHaveBeenCalled()
  })

  test("no settings blob → sets flag, returns ran=true with empty migrated", async () => {
    const r = await migrateVectorCredentials()
    expect(r.ran).toBe(true)
    expect(r.migrated).toEqual([])
    expect(window.localStorage.getItem("vector-credentials-migrated")).toBe("true")
  })

  test("corrupt settings blob → sets flag, no migration", async () => {
    window.localStorage.setItem("cognia-vector-settings", "{not valid json")
    const r = await migrateVectorCredentials()
    expect(r.ran).toBe(true)
    expect(r.migrated).toEqual([])
    expect(window.localStorage.getItem("vector-credentials-migrated")).toBe("true")
  })

  test("migrates pinecone credentials to keyring and strips them from the blob", async () => {
    window.localStorage.setItem(
      "cognia-vector-settings",
      JSON.stringify({
        state: {
          settings: {
            pineconeApiKey: "k",
            pineconeIndexName: "rag",
            pineconeNamespace: "ns",
          },
        },
      })
    )
    const r = await migrateVectorCredentials()
    expect(r.migrated).toContainEqual({ provider: "pinecone", configId: "migrated-pinecone" })
    expect(saveCredsMock).toHaveBeenCalledWith("migrated-pinecone", {
      provider: "pinecone",
      api_key: "k",
      index_name: "rag",
      namespace: "ns",
    })
    const after = JSON.parse(window.localStorage.getItem("cognia-vector-settings") ?? "{}")
    expect(after.state.settings.pineconeApiKey).toBeUndefined()
    expect(after.state.settings.pineconeConfigId).toBe("migrated-pinecone")
  })

  test("idempotent: second run is a no-op", async () => {
    window.localStorage.setItem(
      "cognia-vector-settings",
      JSON.stringify({ state: { settings: { qdrantUrl: "https://q.example.com" } } })
    )
    await migrateVectorCredentials()
    saveCredsMock.mockClear()
    const r2 = await migrateVectorCredentials()
    expect(r2.ran).toBe(false)
    expect(saveCredsMock).not.toHaveBeenCalled()
  })

  test("migrates multiple providers in one pass", async () => {
    window.localStorage.setItem(
      "cognia-vector-settings",
      JSON.stringify({
        state: {
          settings: {
            pineconeApiKey: "k1",
            pineconeIndexName: "rag",
            qdrantUrl: "https://q.example.com",
            qdrantApiKey: "k2",
            weaviateUrl: "https://w.example.com",
          },
        },
      })
    )
    const r = await migrateVectorCredentials()
    expect(r.migrated.length).toBe(3)
    expect(saveCredsMock).toHaveBeenCalledTimes(3)
  })
})
