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
        version: 1,
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
    expect(after.version).toBe(2)
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

  test("preserves credentials and leaves migration retryable when a keyring write fails", async () => {
    saveCredsMock.mockRejectedValueOnce(new Error("keyring locked"))
    window.localStorage.setItem(
      "cognia-vector-settings",
      JSON.stringify({
        state: {
          settings: {
            qdrantUrl: "https://q.example.com",
            qdrantApiKey: "secret",
          },
        },
      })
    )

    const result = await migrateVectorCredentials()

    expect(result.migrated).toEqual([])
    expect(window.localStorage.getItem("vector-credentials-migrated")).toBeNull()
    const after = JSON.parse(window.localStorage.getItem("cognia-vector-settings") ?? "{}")
    expect(after.state.settings.qdrantUrl).toBe("https://q.example.com")
    expect(after.state.settings.qdrantApiKey).toBe("secret")
    expect(after.state.settings.qdrantConfigId).toBeUndefined()
  })

  test("completes even when an incomplete legacy record can never be migrated", async () => {
    // `qdrantApiKey` with no `qdrantUrl` cannot satisfy the qdrant guard, so it
    // is never attempted and its cleartext is never deleted. That is NOT a
    // retryable state: holding the flag back for it re-runs the whole migration
    // on every boot forever. The orphan is preserved, the migration is done.
    window.localStorage.setItem(
      "cognia-vector-settings",
      JSON.stringify({ state: { settings: { qdrantApiKey: "orphaned-secret" } } })
    )

    await migrateVectorCredentials()

    expect(window.localStorage.getItem("vector-credentials-migrated")).toBe("true")
    const after = JSON.parse(window.localStorage.getItem("cognia-vector-settings") ?? "{}")
    expect(after.state.settings.qdrantApiKey).toBe("orphaned-secret")
  })

  test("commits successful providers while keeping a failed provider retryable", async () => {
    saveCredsMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("qdrant keyring failed"))
    window.localStorage.setItem(
      "cognia-vector-settings",
      JSON.stringify({
        version: 1,
        state: {
          settings: {
            pineconeApiKey: "pinecone-secret",
            pineconeIndexName: "docs",
            qdrantUrl: "https://q.example.com",
            qdrantApiKey: "qdrant-secret",
          },
        },
      })
    )

    const result = await migrateVectorCredentials()

    expect(result.migrated).toEqual([{ provider: "pinecone", configId: "migrated-pinecone" }])
    const after = JSON.parse(window.localStorage.getItem("cognia-vector-settings") ?? "{}")
    // The version stamp travels with the flag: the record is NOT upgraded while
    // qdrant cleartext is still on disk waiting for a retry. Claiming v2 here
    // would make a later v1 to v2 fixup skip exactly this record.
    expect(after.version).toBe(1)
    expect(after.state.settings.pineconeApiKey).toBeUndefined()
    expect(after.state.settings.pineconeConfigId).toBe("migrated-pinecone")
    expect(after.state.settings.qdrantApiKey).toBe("qdrant-secret")
    expect(window.localStorage.getItem("vector-credentials-migrated")).toBeNull()
  })

  test("an incomplete legacy record still completes the migration", async () => {
    // `pineconeApiKey` with no `pineconeIndexName` can never satisfy the
    // pinecone guard, so its cleartext is never deleted. That must not hold the
    // flag back forever — otherwise every boot re-runs the whole migration.
    window.localStorage.setItem(
      "cognia-vector-settings",
      JSON.stringify({
        version: 1,
        state: { settings: { pineconeApiKey: "orphan", qdrantUrl: "http://q" } },
      })
    )

    const r = await migrateVectorCredentials()

    expect(r.migrated).toEqual([{ provider: "qdrant", configId: "migrated-qdrant" }])
    expect(window.localStorage.getItem("vector-credentials-migrated")).toBe("true")
  })
})
