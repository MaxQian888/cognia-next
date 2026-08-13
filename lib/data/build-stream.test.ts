/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { PORTABLE_BACKUP_BINDINGS } from "@/lib/data-governance/table-catalog"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { saveSettings } from "@/lib/db/settings"
import { buildBackupSections, buildBackupStream } from "./build-stream"
import { readBackupStream, type BackupStreamReadEvent } from "./stream-format"

async function collect(source: AsyncIterable<BackupStreamReadEvent>) {
  const events: BackupStreamReadEvent[] = []
  for await (const event of source) events.push(event)
  return events
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  const db = getDb()
  await whenSeeded()
  await Promise.all([db.characters.clear(), db.skills.clear(), db.teams.clear()])
})

afterAll(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("buildBackupStream", () => {
  it("emits passphrase-wrapped retrieval keys only for an encrypted stream", async () => {
    const envelope = {
      version: 1 as const,
      profileId: "memory-shared",
      keyId: "dek-memory",
      encryption: {
        enabled: true as const,
        format: "aes-gcm-chunks-v1" as const,
        algorithm: "AES-GCM" as const,
        kdf: {
          algorithm: "PBKDF2" as const,
          hash: "SHA-256" as const,
          iterations: 600_000,
          salt: "salt",
        },
        noncePrefix: "nonce",
      },
      ciphertext: "wrapped",
    }
    const profileDekStore = {
      listProfileIds: jest.fn(async () => ["memory-shared"]),
      exportPortable: jest.fn(async () => envelope),
    }
    const sections = []
    for await (const section of buildBackupSections(
      { includeSessions: false, includeApiKey: false },
      { encryption: { passphrase: "backup-passphrase" }, profileDekStore, storage: null }
    )) {
      sections.push(section)
    }

    expect(sections).toContainEqual({ section: "retrievalProfileDeks", rows: [envelope] })
  })

  it("reads portable data in bounded pages while applying v3 privacy filters", async () => {
    const db = getDb()
    await saveSettings({ apiKey: "raw-secret", defaultModel: "test" })
    await db.characters.bulkPut([
      {
        id: "builtin",
        name: "Builtin",
        avatarColor: "black",
        systemPrompt: "x",
        isBuiltIn: true,
        createdAt: 1,
        updatedAt: 1,
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `user-${index}`,
        name: `User ${index}`,
        avatarColor: "black",
        systemPrompt: "x",
        isBuiltIn: false,
        createdAt: index + 2,
        updatedAt: index + 2,
      })),
    ])
    await db.mcpServers.put({
      id: "mcp-secret",
      name: "Secret MCP",
      transport: "stdio",
      config: { command: "tool", env: { API_KEY: "mcp-raw-secret", COLOR: "blue" } },
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    })

    const events = await collect(
      readBackupStream(
        buildBackupStream(
          {
            includeSessions: false,
            includeApiKey: false,
            includePlugins: false,
            includeMemories: false,
            includeLocalStorage: false,
          },
          { pageSize: 2, maxChunkBytes: 16_384, storage: null }
        )
      )
    )
    const characterChunks = events.filter(
      (event): event is Extract<BackupStreamReadEvent, { kind: "chunk" }> =>
        event.kind === "chunk" && event.section === "characters"
    )
    const settings = events.find((event) => event.kind === "chunk" && event.section === "settings")
    const mcpRows = events.flatMap((event) =>
      event.kind === "chunk" && event.section === "mcpServers" ? event.rows : []
    )
    const mcpManifest = events.flatMap((event) =>
      event.kind === "chunk" && event.section === "mcpCredentialManifest" ? event.rows : []
    )

    expect(characterChunks.every((chunk) => chunk.rows.length <= 2)).toBe(true)
    expect(characterChunks.flatMap((chunk) => chunk.rows)).toEqual(
      expect.arrayContaining(
        Array.from({ length: 5 }, (_, index) => expect.objectContaining({ id: `user-${index}` }))
      )
    )
    expect(characterChunks.flatMap((chunk) => chunk.rows)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "builtin" })])
    )
    expect(settings).toEqual(
      expect.objectContaining({ rows: [expect.not.objectContaining({ apiKey: "raw-secret" })] })
    )
    expect(JSON.stringify(mcpRows)).not.toContain("mcp-raw-secret")
    expect(mcpManifest).toEqual([
      { serverId: "mcp-secret", references: ["mcp/mcp-secret/env/API_KEY"] },
    ])
  })

  it("emits a section for every catalog-bound portable payload field", async () => {
    const events = await collect(
      readBackupStream(
        buildBackupStream(
          { includeSessions: true, includeApiKey: false },
          { pageSize: 2, storage: null }
        )
      )
    )
    const sections = new Set(
      events.flatMap((event) => (event.kind === "chunk" ? [event.section] : []))
    )

    for (const field of new Set(Object.values(PORTABLE_BACKUP_BINDINGS))) {
      expect(sections).toContain(field)
    }
  })

  it("streams provider profile documents as tagged rows instead of one aggregate", async () => {
    const db = getDb()
    await db.providerProfiles.put({
      id: "provider-1",
      displayName: "Provider",
      deploymentRefs: ["deployment-1"],
    })
    await db.deploymentProfiles.put({
      id: "deployment-1",
      providerRef: "provider-1",
      endpoint: "https://example.com",
      transportProfileRef: "transport-1",
      models: [],
    })
    await db.transportProfiles.put({
      id: "transport-1",
      protocol: "openai",
      auth: { scheme: "bearer" },
    })

    const events = await collect(
      readBackupStream(
        buildBackupStream(
          {
            includeSessions: false,
            includeApiKey: false,
            includeCoreData: false,
            includePlugins: false,
            includeLocalStorage: false,
          },
          { pageSize: 1 }
        )
      )
    )
    const rows = events.flatMap((event) =>
      event.kind === "chunk" && event.section === "providerProfileStore" ? event.rows : []
    ) as Array<{ document: string; value: unknown }>

    expect(rows.map((row) => row.document)).toEqual([
      "manifest",
      "providerProfile",
      "deploymentProfile",
      "transportProfile",
    ])
  })
})
