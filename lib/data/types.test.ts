import {
  EXPORT_SCHEMA_VERSION,
  IsEncryptedError,
  UnsupportedSchemaVersionError,
  IntegrityCheckFailedError,
  emptySummary,
} from "./types"
import type { EncryptedEnvelopeV1 } from "./types"

describe("EXPORT_SCHEMA_VERSION", () => {
  it("is 3", () => {
    expect(EXPORT_SCHEMA_VERSION).toBe(3)
  })
})

describe("emptySummary", () => {
  it("returns a fully populated summary with empty maps", () => {
    const s = emptySummary()
    expect(s.added).toEqual({})
    expect(s.overwritten).toEqual({})
    expect(s.skipped).toEqual({})
    expect(s.builtInsSkipped).toEqual({})
  })

  it("returns independent objects on each call", () => {
    const a = emptySummary()
    const b = emptySummary()
    a.added.foo = 1
    expect(b.added.foo).toBeUndefined()
  })
})

describe("IsEncryptedError", () => {
  it("attaches the envelope and uses the canonical name", () => {
    const env = { version: "enc-v1" } as unknown as EncryptedEnvelopeV1
    const err = new IsEncryptedError(env)
    expect(err.name).toBe("IsEncryptedError")
    expect(err.envelope).toBe(env)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/encrypted/i)
  })
})

describe("UnsupportedSchemaVersionError", () => {
  it("describes a null input", () => {
    const err = new UnsupportedSchemaVersionError(null)
    expect(err.name).toBe("UnsupportedSchemaVersionError")
    expect(err.found).toBeNull()
    expect(err.message).toContain("null")
  })

  it("describes an object with version+schemaVersion fields", () => {
    const err = new UnsupportedSchemaVersionError({ version: "9.0", schemaVersion: 9 })
    expect(err.message).toContain("version=9.0")
    expect(err.message).toContain("schemaVersion=9")
  })

  it("describes a primitive input by typeof", () => {
    const err = new UnsupportedSchemaVersionError(42)
    expect(err.message).toContain("number")
  })

  it("describes a string input by typeof", () => {
    const err = new UnsupportedSchemaVersionError("not a backup")
    expect(err.message).toContain("string")
  })
})

describe("IntegrityCheckFailedError", () => {
  it("captures expected/actual checksums", () => {
    const err = new IntegrityCheckFailedError("aaa", "bbb")
    expect(err.name).toBe("IntegrityCheckFailedError")
    expect(err.expected).toBe("aaa")
    expect(err.actual).toBe("bbb")
    expect(err.message).toMatch(/integrity/i)
  })
})
