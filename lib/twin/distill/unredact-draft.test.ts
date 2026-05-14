/**
 * Coverage for the Drafts → Accept unredact-preview helper. We seed a
 * twin source with an encrypted redaction map, then build a draft that
 * references the placeholders and walk the helper end-to-end.
 */

import "fake-indexeddb/auto"
import {
  applyUnredactSelection,
  findPlaceholders,
  loadTwinUnredactMap,
  previewUnredact,
} from "./unredact-draft"
import { encryptRedactionMap, __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { redactText } from "@/lib/twin/ingest/redact"
import { createTwinSource } from "@/lib/db/twin-sources"
import { createTwinDraft } from "@/lib/db/twin-drafts"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { TwinDraft } from "@/types/twin"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __resetRedactionKey()
})

async function seedSourceWithMap(twinId: string, sourceId: string, originalText: string) {
  const { map } = redactText(originalText)
  const enc = await encryptRedactionMap(map)
  await createTwinSource({
    id: sourceId,
    twinId,
    kind: "document",
    format: "markdown",
    source: originalText,
    title: "doc",
    bytes: originalText.length,
    fingerprint: `fp_${sourceId}`,
    redacted: true,
    redactionMapEnc: enc,
  })
  return map
}

function buildDraft(twinId: string, body: string): TwinDraft {
  return {
    id: "drf_1",
    twinId,
    jobId: "job_1",
    kind: "character",
    payload: {
      kind: "character",
      data: { name: "Stub", systemPrompt: body },
    },
    provenance: { chunkIds: [], rationale: "" },
    status: "pending",
    createdAt: Date.now(),
  }
}

describe("findPlaceholders", () => {
  it("returns deduped placeholders in order", () => {
    const ph = findPlaceholders("ping <EMAIL_001> then <EMAIL_001> again, finally <PHONE_002>")
    expect(ph).toEqual(["<EMAIL_001>", "<PHONE_002>"])
  })

  it("returns [] for plain text", () => {
    expect(findPlaceholders("hello world")).toEqual([])
  })
})

describe("loadTwinUnredactMap", () => {
  it("merges every source's decrypted map for the twin", async () => {
    await seedSourceWithMap("twin_a", "src1", "Email alice@example.com about contract.")
    await seedSourceWithMap("twin_a", "src2", "Call +14155550100 by EOD.")
    // Also seed an unrelated twin so we know loadTwin filters correctly.
    await seedSourceWithMap("twin_b", "src3", "Unrelated mallory@example.com noise")
    const merged = await loadTwinUnredactMap("twin_a")
    const originals = Object.values(merged).map((r) => r.original)
    // The PHONE regex's `\b` anchor lands inside the leading "+", so the
    // captured original is just the digit run. Acceptable for restore.
    expect(originals).toEqual(expect.arrayContaining(["alice@example.com", "14155550100"]))
    // Bob's record from twin_b is not in twin_a's map.
    expect(originals).not.toContain("mallory@example.com")
  })

  it("tolerates a source whose blob cannot be decrypted", async () => {
    await createTwinSource({
      id: "broken",
      twinId: "twin_x",
      kind: "document",
      format: "markdown",
      source: "",
      title: "broken",
      bytes: 0,
      fingerprint: "fp_broken",
      redacted: true,
      redactionMapEnc: "not-valid-json",
    })
    const merged = await loadTwinUnredactMap("twin_x")
    expect(merged).toEqual({})
  })
})

describe("previewUnredact", () => {
  it("flags placeholders that have a known original + defaults keep=true", async () => {
    await seedSourceWithMap("twin_p", "src1", "Email alice@example.com about contract.")
    // Find what the redactor produced and use it in the draft.
    const map = await loadTwinUnredactMap("twin_p")
    const placeholder = Object.keys(map)[0]
    expect(placeholder).toMatch(/^<EMAIL_\d{3}>$/)
    const draft = buildDraft("twin_p", `Reach out to ${placeholder} ASAP.`)
    const preview = await previewUnredact(draft, "twin_p")
    expect(preview.placeholders).toHaveLength(1)
    expect(preview.placeholders[0]).toMatchObject({
      placeholder,
      original: "alice@example.com",
      kind: "EMAIL",
      keep: true,
    })
  })

  it("returns empty placeholders when the draft has none", async () => {
    const draft = buildDraft("twin_p", "Plain prompt, no PII.")
    const preview = await previewUnredact(draft, "twin_p")
    expect(preview.placeholders).toEqual([])
  })
})

describe("applyUnredactSelection", () => {
  it("restores selected placeholders + leaves the unselected ones intact", () => {
    const payload: TwinDraft["payload"] = {
      kind: "character",
      data: {
        systemPrompt: "Reach out to <EMAIL_001>. Backup: <PHONE_002>.",
      },
    }
    const result = applyUnredactSelection(payload, [
      { placeholder: "<EMAIL_001>", original: "alice@example.com", keep: true },
      { placeholder: "<PHONE_002>", original: "+14155550100", keep: false },
    ])
    const data = (result as { data: { systemPrompt: string } }).data
    expect(data.systemPrompt).toContain("alice@example.com")
    expect(data.systemPrompt).toContain("<PHONE_002>")
  })

  it("escapes problematic characters when splicing back in", () => {
    const payload: TwinDraft["payload"] = {
      kind: "skill",
      data: { content: "Contact <NAME_001>" },
    }
    const result = applyUnredactSelection(payload, [
      { placeholder: "<NAME_001>", original: 'Alice "Codename Q"', keep: true },
    ])
    const data = (result as { data: { content: string } }).data
    expect(data.content).toBe('Contact Alice "Codename Q"')
  })

  it("is a no-op when nothing is selected", () => {
    const payload: TwinDraft["payload"] = {
      kind: "character",
      data: { systemPrompt: "<EMAIL_001>" },
    }
    expect(applyUnredactSelection(payload, [])).toBe(payload)
    expect(
      applyUnredactSelection(payload, [
        { placeholder: "<EMAIL_001>", original: "x@y.com", keep: false },
      ])
    ).toBe(payload)
  })
})
