/**
 * `.cognia-pack.json` schema validation tests (ADR-0030).
 */

import {
  CHARACTER_PACK_FILE_SCHEMA_VERSION,
  parseLocalPackFile,
  serializeLocalPackFile,
} from "./schema"
import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"

function makePack(overrides: Partial<PluginCharacterPackDef> = {}): PluginCharacterPackDef {
  return {
    id: "workplace",
    name: "Workplace Suite",
    version: "1.0.0",
    characters: [
      {
        localId: "alice",
        name: "Alice",
        avatarColor: "oklch(0.7 0.15 250)",
        systemPrompt: "Hello",
      },
    ],
    ...overrides,
  }
}

describe("parseLocalPackFile", () => {
  it("accepts a well-formed schema v1 file with no signature", () => {
    const result = parseLocalPackFile({
      schemaVersion: CHARACTER_PACK_FILE_SCHEMA_VERSION,
      pack: makePack(),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.file.pack.id).toBe("workplace")
      expect(result.file.signature).toBeUndefined()
    }
  })

  it("accepts a well-formed schema v1 file with an ed25519 signature", () => {
    const result = parseLocalPackFile({
      schemaVersion: CHARACTER_PACK_FILE_SCHEMA_VERSION,
      pack: makePack(),
      signature: { algo: "ed25519", pubKey: "abc", sig: "def" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.file.signature?.algo).toBe("ed25519")
    }
  })

  it("rejects non-object input", () => {
    expect(parseLocalPackFile(null).ok).toBe(false)
    expect(parseLocalPackFile("string").ok).toBe(false)
    expect(parseLocalPackFile(42).ok).toBe(false)
  })

  it("rejects a missing schemaVersion", () => {
    const result = parseLocalPackFile({ pack: makePack() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/schemaVersion/)
  })

  it("rejects a future schemaVersion with an actionable error", () => {
    const result = parseLocalPackFile({ schemaVersion: 99, pack: makePack() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Upgrade Cognia/)
  })

  it("rejects an outdated schemaVersion with an actionable error", () => {
    const result = parseLocalPackFile({ schemaVersion: 0, pack: makePack() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/re-export the pack/)
  })

  it("rejects missing pack field", () => {
    const result = parseLocalPackFile({ schemaVersion: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/pack/)
  })

  it("rejects pack missing id / name / version", () => {
    expect(parseLocalPackFile({ schemaVersion: 1, pack: { ...makePack(), id: "" } }).ok).toBe(false)
    expect(parseLocalPackFile({ schemaVersion: 1, pack: { ...makePack(), name: "  " } }).ok).toBe(
      false
    )
    expect(parseLocalPackFile({ schemaVersion: 1, pack: { ...makePack(), version: "" } }).ok).toBe(
      false
    )
  })

  it("rejects pack with no characters or empty array", () => {
    const empty = parseLocalPackFile({ schemaVersion: 1, pack: { ...makePack(), characters: [] } })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error).toMatch(/at least one character/)
  })

  it("rejects characters missing required fields", () => {
    const noLocalId = parseLocalPackFile({
      schemaVersion: 1,
      pack: { ...makePack(), characters: [{ name: "X", avatarColor: "x", systemPrompt: "x" }] },
    })
    expect(noLocalId.ok).toBe(false)

    const noPrompt = parseLocalPackFile({
      schemaVersion: 1,
      pack: { ...makePack(), characters: [{ localId: "a", name: "X", avatarColor: "x" }] },
    })
    expect(noPrompt.ok).toBe(false)
  })

  it("rejects duplicate localIds within a single pack", () => {
    const result = parseLocalPackFile({
      schemaVersion: 1,
      pack: {
        ...makePack(),
        characters: [
          { localId: "alice", name: "A", avatarColor: "x", systemPrompt: "x" },
          { localId: "alice", name: "B", avatarColor: "x", systemPrompt: "x" },
        ],
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Duplicate localId/)
  })

  it("rejects malformed signature shapes", () => {
    const badAlgo = parseLocalPackFile({
      schemaVersion: 1,
      pack: makePack(),
      signature: { algo: "rsa", pubKey: "x", sig: "y" },
    })
    expect(badAlgo.ok).toBe(false)
    if (!badAlgo.ok) expect(badAlgo.error).toMatch(/Unsupported signature algo/)

    const noSig = parseLocalPackFile({
      schemaVersion: 1,
      pack: makePack(),
      signature: { algo: "ed25519", pubKey: "x", sig: "" },
    })
    expect(noSig.ok).toBe(false)
  })

  it("rejects packs exceeding the soft character limit", () => {
    const huge = parseLocalPackFile({
      schemaVersion: 1,
      pack: {
        ...makePack(),
        characters: Array.from({ length: 51 }, (_, i) => ({
          localId: `c-${i}`,
          name: `C${i}`,
          avatarColor: "x",
          systemPrompt: "x",
        })),
      },
    })
    expect(huge.ok).toBe(false)
    if (!huge.ok) expect(huge.error).toMatch(/soft limit/)
  })
})

describe("serializeLocalPackFile", () => {
  it("round-trips through parseLocalPackFile", () => {
    const pack = makePack()
    const body = serializeLocalPackFile(pack)
    const parsed = JSON.parse(body)
    expect(parsed.schemaVersion).toBe(CHARACTER_PACK_FILE_SCHEMA_VERSION)
    expect(parsed.pack.id).toBe("workplace")

    const result = parseLocalPackFile(parsed)
    expect(result.ok).toBe(true)
  })

  it("emits a trailing newline + 2-space indent for diff readability", () => {
    const body = serializeLocalPackFile(makePack())
    expect(body.endsWith("\n")).toBe(true)
    expect(body).toContain('  "schemaVersion"')
  })

  it("includes signature when provided", () => {
    const body = serializeLocalPackFile(makePack(), {
      algo: "ed25519",
      pubKey: "abc",
      sig: "def",
    })
    const parsed = JSON.parse(body)
    expect(parsed.signature).toEqual({ algo: "ed25519", pubKey: "abc", sig: "def" })
  })
})
