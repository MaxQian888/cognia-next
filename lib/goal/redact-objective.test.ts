import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { redactObjective, unredactObjective } from "./redact-objective"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __resetRedactionKey()
})

describe("redactObjective", () => {
  it("replaces emails with <EMAIL_NNN> placeholders", async () => {
    const result = await redactObjective("ping alice@example.com about Q3")
    expect(result.safeObjective).toBe("ping <EMAIL_001> about Q3")
    expect(result.redactionMapEnc).not.toBe("")
  })

  it("returns an empty envelope when no PII is present", async () => {
    const result = await redactObjective("write a haiku about winter")
    expect(result.safeObjective).toBe("write a haiku about winter")
    expect(result.redactionMapEnc).toBe("")
  })

  it("replaces CN mobile numbers", async () => {
    const result = await redactObjective("call 13800138000 tomorrow")
    expect(result.safeObjective).toContain("<PHONE_001>")
    expect(result.safeObjective).not.toContain("13800138000")
  })

  it("replaces API keys", async () => {
    const key = "sk-proj-AAAAAAAAAAAAAAAAAAAA"
    const result = await redactObjective(`use ${key} for the call`)
    expect(result.safeObjective).toContain("<API_KEY_001>")
    expect(result.safeObjective).not.toContain(key)
  })

  it("does not leak the original through the encrypted envelope (it's JSON)", async () => {
    const result = await redactObjective("ping carol@example.com")
    // The encrypted envelope must NOT contain the cleartext email
    expect(result.redactionMapEnc).not.toContain("carol@example.com")
    // And it must look like a JSON-encoded envelope (v/iv/ct fields)
    const parsed = JSON.parse(result.redactionMapEnc)
    expect(parsed.v).toBe(1)
    expect(typeof parsed.iv).toBe("string")
    expect(typeof parsed.ct).toBe("string")
  })

  it("honours name hints by tokenising them as <NAME_NNN>", async () => {
    const result = await redactObjective("schedule a 1:1 with Alice next week", ["Alice"])
    expect(result.safeObjective).toContain("<NAME_001>")
    expect(result.safeObjective).not.toContain("Alice")
  })

  it("redacts the same value to the same placeholder", async () => {
    const result = await redactObjective(
      "email alice@example.com then escalate to alice@example.com"
    )
    const matches = result.safeObjective.match(/<EMAIL_\d{3}>/g)
    expect(matches).toEqual(["<EMAIL_001>", "<EMAIL_001>"])
  })

  it("round-trips through unredactObjective", async () => {
    const raw = "ping alice@example.com about the demo"
    const result = await redactObjective(raw)
    const restored = await unredactObjective(result.safeObjective, result.redactionMapEnc)
    expect(restored).toBe(raw)
  })

  it("unredactObjective passes through when the envelope is empty", async () => {
    const restored = await unredactObjective("nothing to redact", "")
    expect(restored).toBe("nothing to redact")
  })

  it("unredactObjective leaves unmapped placeholders untouched", async () => {
    const result = await redactObjective("ping alice@example.com")
    // Surface a placeholder that isn't in the map
    const tampered = `${result.safeObjective} <PHONE_999>`
    const restored = await unredactObjective(tampered, result.redactionMapEnc)
    expect(restored).toContain("alice@example.com")
    expect(restored).toContain("<PHONE_999>")
  })
})
