/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  DENY_MODEL_GATE,
  InboundValidationError,
  MAX_INBOUND_BODY_CHARS,
  MAX_INBOUND_TITLE_CHARS,
  distillInbound,
  validateClassification,
  type InboundClassifier,
  type InboundGate,
  type InboundSubmission,
} from "./distiller"
import { UNTRUSTED_OPEN } from "@/lib/external-bridge/untrusted"
import { getDb } from "@/lib/db/schema"

const ALLOW_GATE: InboundGate = { allowsModelCall: () => true }

function submission(overrides: Partial<InboundSubmission> = {}): InboundSubmission {
  return {
    kind: "note",
    title: "A title",
    body: "A body",
    origin: "mcp",
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().inboundDrafts.clear()
}, 30_000)

describe("validation", () => {
  it("rejects empty and oversized fields", async () => {
    await expect(distillInbound(submission({ title: "  " }), { gate: ALLOW_GATE })).rejects.toThrow(
      InboundValidationError
    )
    await expect(distillInbound(submission({ body: "" }), { gate: ALLOW_GATE })).rejects.toThrow(
      /body must not be empty/
    )
    await expect(
      distillInbound(submission({ title: "x".repeat(MAX_INBOUND_TITLE_CHARS + 1) }), {
        gate: ALLOW_GATE,
      })
    ).rejects.toThrow(/exceeds 200/)
    await expect(
      distillInbound(submission({ body: "x".repeat(MAX_INBOUND_BODY_CHARS + 1) }), {
        gate: ALLOW_GATE,
      })
    ).rejects.toThrow(/exceeds 100000/)
  })

  it("stores nothing when validation fails", async () => {
    await expect(distillInbound(submission({ title: "" }), { gate: ALLOW_GATE })).rejects.toThrow()
    expect(await getDb().inboundDrafts.count()).toBe(0)
  })
})

describe("persistence shape", () => {
  it("creates exactly one pending, untrusted-wrapped draft", async () => {
    const outcome = await distillInbound(submission(), { gate: DENY_MODEL_GATE, now: () => 555 })

    expect(outcome.status).toBe("created")
    if (outcome.status !== "created") return
    expect(outcome.draft.status).toBe("pending")
    expect(outcome.draft.body).toContain(UNTRUSTED_OPEN)
    expect(outcome.draft.createdAt).toBe(555)
    // The producer is recorded so the review UI can show where it came from.
    expect(outcome.draft.metadata?.origin).toBe("mcp")
    expect(await getDb().inboundDrafts.count()).toBe(1)
  })

  it("truncates an overlong source label rather than rejecting the submission", async () => {
    const outcome = await distillInbound(submission({ source: "s".repeat(500) }), {
      gate: DENY_MODEL_GATE,
    })
    if (outcome.status !== "created") throw new Error("expected created")
    expect(outcome.draft.source).toHaveLength(200)
  })
})

describe("PII redaction", () => {
  it("redacts before storage", async () => {
    const outcome = await distillInbound(
      submission({ body: "Email me at alice@example.com about it." }),
      { gate: DENY_MODEL_GATE }
    )
    if (outcome.status !== "created") throw new Error("expected created")
    expect(outcome.draft.body).not.toContain("alice@example.com")
  })

  it("redacts before the classifier sees the text, even with the gate wide open", async () => {
    const seen: string[] = []
    const classifier: InboundClassifier = {
      classify: async ({ body }) => {
        seen.push(body)
        return null
      },
    }

    await distillInbound(submission({ body: "reach alice@example.com now" }), {
      gate: ALLOW_GATE,
      classifier,
    })

    expect(seen).toHaveLength(1)
    // Redaction is not the gate's job to remember: a misconfigured gate must
    // not become a PII leak to a provider.
    expect(seen[0]).not.toContain("alice@example.com")
  })
})

describe("dedup", () => {
  it("folds a re-submission into the existing draft", async () => {
    const first = await distillInbound(submission(), { gate: DENY_MODEL_GATE })
    if (first.status !== "created") throw new Error("expected created")

    const second = await distillInbound(submission(), { gate: DENY_MODEL_GATE })

    expect(second).toEqual({
      status: "duplicate",
      draftId: first.draft.id,
      canonicalHash: first.draft.canonicalHash,
    })
    expect(await getDb().inboundDrafts.count()).toBe(1)
  })

  it("treats a re-crawl with shifted whitespace as the same content", async () => {
    await distillInbound(submission({ body: "Retry after 60s." }), { gate: DENY_MODEL_GATE })
    const again = await distillInbound(submission({ body: "Retry\n\n  after 60s." }), {
      gate: DENY_MODEL_GATE,
    })

    expect(again.status).toBe("duplicate")
  })

  it("does not fold genuinely different content", async () => {
    await distillInbound(submission({ body: "one" }), { gate: DENY_MODEL_GATE })
    const other = await distillInbound(submission({ body: "two" }), { gate: DENY_MODEL_GATE })

    expect(other.status).toBe("created")
    expect(await getDb().inboundDrafts.count()).toBe(2)
  })

  it("dedups across producers — the same page via crawler and via MCP is one draft", async () => {
    await distillInbound(submission({ origin: "crawler" }), { gate: DENY_MODEL_GATE })
    const viaMcp = await distillInbound(submission({ origin: "mcp" }), { gate: DENY_MODEL_GATE })

    expect(viaMcp.status).toBe("duplicate")
  })
})

describe("model gate and classifier", () => {
  it("never calls the classifier when the gate refuses", async () => {
    const classify = jest.fn()
    await distillInbound(submission(), {
      gate: DENY_MODEL_GATE,
      classifier: { classify },
    })
    expect(classify).not.toHaveBeenCalled()
  })

  it("applies a valid classification to the stored draft", async () => {
    const classifier: InboundClassifier = {
      classify: async () => ({ title: "Refined", summary: "A summary", tags: ["a", "b"] }),
    }
    const outcome = await distillInbound(submission(), { gate: ALLOW_GATE, classifier })

    if (outcome.status !== "created") throw new Error("expected created")
    expect(outcome.draft.title).toBe("Refined")
    expect(outcome.draft.metadata?.summary).toBe("A summary")
    expect(outcome.draft.metadata?.tags).toEqual(["a", "b"])
  })

  it("merges classifier tags with the submitter's rather than replacing them", async () => {
    const classifier: InboundClassifier = {
      classify: async () => ({ tags: ["new", "existing"] }),
    }
    const outcome = await distillInbound(submission({ metadata: { tags: ["existing"] } }), {
      gate: ALLOW_GATE,
      classifier,
    })

    if (outcome.status !== "created") throw new Error("expected created")
    expect(outcome.draft.metadata?.tags).toEqual(["existing", "new"])
  })

  it("still records the submission when the classifier throws", async () => {
    const classifier: InboundClassifier = {
      classify: async () => {
        throw new Error("provider down")
      },
    }
    const outcome = await distillInbound(submission({ title: "Original" }), {
      gate: ALLOW_GATE,
      classifier,
    })

    // A provider outage must not silently drop inbound knowledge.
    expect(outcome.status).toBe("created")
    if (outcome.status !== "created") return
    expect(outcome.draft.title).toBe("Original")
  })
})

describe("validateClassification", () => {
  it("rejects non-objects and empty results", () => {
    expect(validateClassification(null)).toBeNull()
    expect(validateClassification("a string")).toBeNull()
    expect(validateClassification({})).toBeNull()
    expect(validateClassification({ title: "   " })).toBeNull()
  })

  it("drops non-string fields the model may have hallucinated", () => {
    expect(validateClassification({ title: 42, summary: {}, tags: "not-an-array" })).toBeNull()
  })

  it("bounds a runaway title and summary", () => {
    const result = validateClassification({
      title: "t".repeat(1000),
      summary: "s".repeat(9000),
    })
    expect(result?.title).toHaveLength(MAX_INBOUND_TITLE_CHARS)
    expect(result?.summary).toHaveLength(2000)
  })

  it("de-duplicates, trims, and caps tags", () => {
    const result = validateClassification({
      tags: [
        "  a  ",
        "a",
        "",
        7,
        "b".repeat(100),
        ...Array.from({ length: 40 }, (_, i) => `t${i}`),
      ],
    })
    expect(result?.tags).toContain("a")
    expect(result!.tags!.filter((t) => t === "a")).toHaveLength(1)
    expect(result!.tags!.length).toBeLessThanOrEqual(20)
    expect(result!.tags!.every((t) => t.length <= 60)).toBe(true)
  })
})
