/** @jest-environment node */
/**
 * Tests for the inbound media model gate.
 *
 * The property that matters is one-directional: every ambiguity has to resolve
 * to withholding. A missing policy, a missing grant, an expired grant, a grant
 * naming other providers — each must leave binary on the device.
 */

import {
  applyMediaModelGate,
  isMediaSegment,
  resolveMediaModelPolicy,
  type MediaModelGrant,
} from "./media-model-gate"
import type { MessageSegment } from "@/types/connectors/segment"

function grant(over: Partial<MediaModelGrant> = {}): MediaModelGrant {
  return {
    policy: "allow_cloud_binary",
    providers: ["anthropic"],
    grantedAt: 1_000,
    ...over,
  }
}

describe("resolveMediaModelPolicy", () => {
  it("defaults to local_extract_only when the adapter has no policy", () => {
    // A row that predates the field must not be read as permission.
    expect(resolveMediaModelPolicy({ adapter: {} })).toBe("local_extract_only")
  })

  it("uses the adapter policy when there is no grant", () => {
    expect(resolveMediaModelPolicy({ adapter: { mediaModelPolicy: "allow_cloud_binary" } })).toBe(
      "allow_cloud_binary"
    )
    expect(resolveMediaModelPolicy({ adapter: { mediaModelPolicy: "local_extract_only" } })).toBe(
      "local_extract_only"
    )
  })

  it("honours a live grant for the resolved provider", () => {
    expect(
      resolveMediaModelPolicy({
        adapter: { mediaModelPolicy: "local_extract_only" },
        override: { mediaModelGrant: grant(), providerOverride: "anthropic" },
        now: 2_000,
      })
    ).toBe("allow_cloud_binary")
  })

  it("falls back to the adapter's default provider when the conversation sets none", () => {
    expect(
      resolveMediaModelPolicy({
        adapter: { mediaModelPolicy: "local_extract_only" },
        override: { mediaModelGrant: grant({ providers: ["openai"] }) },
        adapterDefaultProvider: "openai",
        now: 2_000,
      })
    ).toBe("allow_cloud_binary")
  })

  it("refuses a grant that does not name the provider this turn will use", () => {
    // The whole point of provider scoping: permission for a local model must
    // not silently become permission to upload to a third party.
    expect(
      resolveMediaModelPolicy({
        adapter: { mediaModelPolicy: "local_extract_only" },
        override: {
          mediaModelGrant: grant({ providers: ["ollama"] }),
          providerOverride: "anthropic",
        },
        now: 2_000,
      })
    ).toBe("local_extract_only")
  })

  it("refuses an expired grant", () => {
    expect(
      resolveMediaModelPolicy({
        adapter: {},
        override: { mediaModelGrant: grant({ expiresAt: 1_500 }), providerOverride: "anthropic" },
        now: 2_000,
      })
    ).toBe("local_extract_only")
  })

  it("refuses a grant that names no providers", () => {
    expect(
      resolveMediaModelPolicy({
        adapter: {},
        override: { mediaModelGrant: grant({ providers: [] }), providerOverride: "anthropic" },
        now: 2_000,
      })
    ).toBe("local_extract_only")
  })

  it("refuses when no provider can be resolved at all", () => {
    expect(
      resolveMediaModelPolicy({
        adapter: {},
        override: { mediaModelGrant: grant() },
        now: 2_000,
      })
    ).toBe("local_extract_only")
  })
})

describe("isMediaSegment", () => {
  it("covers every binary-carrying kind", () => {
    for (const type of ["image", "voice", "video", "file"]) {
      expect(isMediaSegment({ type } as MessageSegment)).toBe(true)
    }
    expect(isMediaSegment({ type: "text", text: "x" } as MessageSegment)).toBe(false)
  })
})

describe("applyMediaModelGate", () => {
  it("stamps the policy so the prompt builder cannot decide differently", () => {
    const event = { segments: [] as MessageSegment[] }
    applyMediaModelGate(event, "allow_cloud_binary")
    expect(event).toMatchObject({ mediaModelPolicy: "allow_cloud_binary" })
  })

  it("reports media with no local text as withheld under local_extract_only", () => {
    const event = {
      segments: [
        { type: "image", url: "https://x/1.png" },
        { type: "voice", url: "https://x/1.ogg" },
      ] as unknown as MessageSegment[],
    }
    const decision = applyMediaModelGate(event, "local_extract_only")
    expect(decision.blocked).toEqual([
      { segmentType: "image", reason: "no_local_text" },
      { segmentType: "voice", reason: "no_local_text" },
    ])
  })

  it("reports nothing withheld when the binary itself is permitted", () => {
    const event = {
      segments: [{ type: "image", url: "https://x/1.png" }] as unknown as MessageSegment[],
    }
    expect(applyMediaModelGate(event, "allow_cloud_binary").blocked).toEqual([])
  })

  it("lets locally-extracted text through and leaves it on the segment", () => {
    const event = {
      segments: [
        { type: "image", url: "u", ocrText: "invoice total 12" },
        { type: "voice", url: "v", transcript: "call me back" },
        { type: "file", name: "a.pdf", ocrText: "quarterly report" },
      ] as unknown as MessageSegment[],
    }
    const decision = applyMediaModelGate(event, "local_extract_only")
    expect(decision.blocked).toEqual([])
    expect((event.segments[0] as { ocrText?: string }).ocrText).toBe("invoice total 12")
    expect((event.segments[1] as { transcript?: string }).transcript).toBe("call me back")
  })

  it("drops locally-extracted text that fails the PII gate", () => {
    // OCR of a photographed form routinely contains exactly the identifiers the
    // redaction gate exists to catch — it is not equivalent to typed chat text.
    const event = {
      segments: [
        { type: "image", url: "u", ocrText: "id 110101199003071234" },
      ] as unknown as MessageSegment[],
    }
    const decision = applyMediaModelGate(event, "local_extract_only", {
      isPiiSafe: (text) => !text.includes("110101"),
    })
    expect(decision.blocked).toEqual([{ segmentType: "image", reason: "pii_gate" }])
    expect((event.segments[0] as { ocrText?: string }).ocrText).toBeUndefined()
  })

  it("re-gates extracted text even when the binary itself is permitted", () => {
    // The grant covers the picture, not a leak in the words read out of it.
    const event = {
      segments: [
        { type: "file", name: "scan.pdf", ocrText: "card 4111111111111111" },
      ] as unknown as MessageSegment[],
    }
    const decision = applyMediaModelGate(event, "allow_cloud_binary", {
      isPiiSafe: () => false,
    })
    expect(decision.blocked).toEqual([{ segmentType: "file", reason: "pii_gate" }])
    expect((event.segments[0] as { ocrText?: string }).ocrText).toBeUndefined()
  })

  it("never touches text segments", () => {
    const event = {
      segments: [{ type: "text", text: "email me at a@b.com" }] as unknown as MessageSegment[],
    }
    const decision = applyMediaModelGate(event, "local_extract_only", { isPiiSafe: () => false })
    expect(decision.blocked).toEqual([])
    expect((event.segments[0] as { text: string }).text).toBe("email me at a@b.com")
  })
})
