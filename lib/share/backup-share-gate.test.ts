import {
  BACKUP_PAYLOAD_DOMAIN,
  BACKUP_SHARE_DOMAINS,
  collectStringLeaves,
  isEncryptedBackupEnvelope,
  scanBackupForShare,
} from "./backup-share-gate"
import type { BackupPackageV3, BackupPayloadV3, EncryptedEnvelopeV1 } from "@/lib/data/types"

function plaintext(payload: Record<string, unknown>): BackupPackageV3 {
  return {
    version: "3.0",
    manifest: {
      version: "3.0",
      schemaVersion: 3,
      traceId: "trace-1",
      exportedAt: "2026-09-02T00:00:00.000Z",
      appVersion: "test",
      backend: "web-dexie",
      integrity: { algorithm: "SHA-256", checksum: "abc" },
    },
    payload: payload as BackupPayloadV3,
  }
}

const encrypted: EncryptedEnvelopeV1 = {
  version: "enc-v1",
  algorithm: "AES-GCM",
  kdf: { algorithm: "PBKDF2", hash: "SHA-256", iterations: 1, salt: "c2FsdA==" },
  iv: "aXY=",
  // A base64 body that would trip the email detector if the gate ever read it.
  ciphertext: "owner@example.com",
  manifest: {
    version: "3.0",
    schemaVersion: 3,
    traceId: "trace-2",
    exportedAt: "2026-09-02T00:00:00.000Z",
    appVersion: "test",
    backend: "web-dexie",
    encryption: { enabled: true, format: "encrypted-envelope-v1" },
  },
  checksum: "abc",
}

describe("scanBackupForShare", () => {
  it("reports plaintext hits grouped by domain, most hits first", () => {
    const result = scanBackupForShare(
      plaintext({
        settings: { userName: "owner", email: "owner@example.com" },
        sessions: [{ id: "s1", title: "Chat", createdAt: 1725264000000 }],
        messages: [
          { id: "m1", content: "reach me at alice@example.com or bob@example.com" },
          { id: "m2", content: "token sk-abcdefghijklmnopqrstuvwxyz0123456789" },
        ],
        mcpServers: [{ id: "srv", url: "https://user:hunter2secret@example.com" }],
      })
    )
    expect(result.kind).toBe("hits")
    if (result.kind !== "hits") return
    expect(result.total).toBe(5)
    expect(result.domains.map((d) => d.domain)).toEqual(["sessions", "settings", "connectors"])
    expect(result.domains[0]).toEqual({
      domain: "sessions",
      hits: 3,
      byKind: { EMAIL: 2, API_KEY: 1 },
    })
    expect(result.domains[1]).toEqual({ domain: "settings", hits: 1, byKind: { EMAIL: 1 } })
    expect(result.domains[2]).toEqual({ domain: "connectors", hits: 1, byKind: { API_KEY: 1 } })
  })

  it("passes a clean plaintext package through without hits", () => {
    const result = scanBackupForShare(
      plaintext({
        settings: { theme: "dark" },
        skills: [{ id: "sk", name: "Review", content: "Look at the diff" }],
        memories: [],
      })
    )
    expect(result).toEqual({ kind: "clean", scannedDomains: 2 })
  })

  it("does not treat numeric timestamps and ids as bank cards or phones", () => {
    const result = scanBackupForShare(
      plaintext({
        sessions: [{ id: "s1", createdAt: 1725264000000, updatedAt: 4111111111111111 }],
        messages: [{ id: "m1", timestamp: 1725264000, content: "hello" }],
      })
    )
    expect(result.kind).toBe("clean")
  })

  it("passes an encrypted envelope through without reading the ciphertext", () => {
    expect(scanBackupForShare(encrypted)).toEqual({ kind: "encrypted" })
    expect(isEncryptedBackupEnvelope(encrypted)).toBe(true)
    expect(isEncryptedBackupEnvelope(plaintext({}))).toBe(false)
  })

  it("scans an unknown additive payload field instead of dropping it", () => {
    const result = scanBackupForShare(
      plaintext({ futureTable: [{ note: "call 13812345678" }] } as Record<string, unknown>)
    )
    expect(result.kind).toBe("hits")
    if (result.kind !== "hits") return
    expect(result.domains[0].domain).toBe("settings")
    expect(result.domains[0].byKind.PHONE).toBe(1)
  })

  it("never mutates the package it scans", () => {
    const pkg = plaintext({ messages: [{ id: "m1", content: "alice@example.com" }] })
    const before = JSON.stringify(pkg)
    scanBackupForShare(pkg)
    expect(JSON.stringify(pkg)).toBe(before)
  })
})

describe("BACKUP_PAYLOAD_DOMAIN", () => {
  it("places every field in a listed domain", () => {
    for (const domain of Object.values(BACKUP_PAYLOAD_DOMAIN)) {
      expect(BACKUP_SHARE_DOMAINS).toContain(domain)
    }
    expect(new Set(Object.values(BACKUP_PAYLOAD_DOMAIN))).toEqual(new Set(BACKUP_SHARE_DOMAINS))
  })
})

describe("collectStringLeaves", () => {
  it("walks arrays and nested objects and skips keys, numbers and empties", () => {
    expect(
      collectStringLeaves({ email: "", nested: { a: ["x", 1, null, { b: "y" }] }, n: 2 })
    ).toEqual(["x", "y"])
  })
})
