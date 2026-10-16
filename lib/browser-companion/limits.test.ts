import { BROWSER_CONTEXT_LIMITS } from "@/types/browser-companion"

import { validateBrowserSubmission } from "./limits"

function payload(overrides: Record<string, unknown> = {}) {
  return {
    submissionId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "ws-1",
    instruction: "Summarise this",
    context: {
      schemaVersion: 1,
      captureMode: "metadata",
      url: "https://example.com/a",
      title: "A",
      capturedAt: 1_700_000_000_000,
    },
    ...overrides,
  }
}

describe("validateBrowserSubmission", () => {
  it("accepts a minimal metadata capture", () => {
    const result = validateBrowserSubmission(payload())
    expect(result.ok).toBe(true)
  })

  it("drops fields the contract does not name rather than passing them through", () => {
    const result = validateBrowserSubmission(payload({ cwd: "/etc", model: "opus" }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The extension cannot choose a model, a cwd, a tool set or a permission
    // mode; anything extra it sends must not survive validation.
    expect(result.request).not.toHaveProperty("cwd")
    expect(result.request).not.toHaveProperty("model")
  })

  it("rejects each missing required field by name", () => {
    for (const field of ["submissionId", "workspaceId", "instruction"]) {
      const result = validateBrowserSubmission(payload({ [field]: "" }))
      expect(result).toEqual({ ok: false, rejection: { code: "malformed", field } })
    }
    expect(validateBrowserSubmission("nope").ok).toBe(false)
  })

  it("measures limits in UTF-8 bytes, not characters", () => {
    // A CJK instruction passes a character-denominated cap while blowing the
    // byte budget threefold; bytes are what the wire and the context cost.
    const chars = Math.ceil(BROWSER_CONTEXT_LIMITS.instructionBytes / 3)
    const result = validateBrowserSubmission(payload({ instruction: "交".repeat(chars) }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection).toMatchObject({
      code: "too_large",
      field: "instruction",
      limit: BROWSER_CONTEXT_LIMITS.instructionBytes,
    })
  })

  it("enforces the selection and page ceilings", () => {
    const selection = validateBrowserSubmission(
      payload({
        context: {
          ...payload().context,
          captureMode: "selection",
          selection: {
            text: "a".repeat(BROWSER_CONTEXT_LIMITS.selectionBytes + 1),
            truncated: true,
          },
        },
      })
    )
    expect(selection).toMatchObject({ ok: false, rejection: { field: "context.selection" } })

    const page = validateBrowserSubmission(
      payload({
        context: {
          ...payload().context,
          captureMode: "readable-page",
          readableText: {
            text: "a".repeat(BROWSER_CONTEXT_LIMITS.readableTextBytes + 1),
            truncated: true,
            originalCharacterCount: 999,
          },
        },
      })
    )
    expect(page).toMatchObject({ ok: false, rejection: { field: "context.readableText" } })
  })

  it("refuses an oversized body before parsing any of it", () => {
    // The envelope ceiling guards the raw payload, not the request we would
    // rebuild from it. Checked on the rebuilt request it could never fire —
    // the per-field caps sum to 168 KiB — and an unreachable limit reads as
    // protection that was never there.
    const result = validateBrowserSubmission(
      payload({ padding: "a".repeat(BROWSER_CONTEXT_LIMITS.requestBytes) })
    )
    expect(result).toMatchObject({ ok: false, rejection: { code: "too_large", field: "request" } })
  })

  it("admits a capture that uses every per-field budget at once", () => {
    // The three caps are designed to coexist: a whole page, a selection inside
    // it, and a full-length instruction is a real submission, not an attack.
    const result = validateBrowserSubmission(
      payload({
        instruction: "a".repeat(BROWSER_CONTEXT_LIMITS.instructionBytes),
        context: {
          ...payload().context,
          captureMode: "readable-page",
          readableText: {
            text: "a".repeat(BROWSER_CONTEXT_LIMITS.readableTextBytes),
            truncated: false,
            originalCharacterCount: 1,
          },
          selection: {
            text: "a".repeat(BROWSER_CONTEXT_LIMITS.selectionBytes),
            truncated: false,
          },
        },
      })
    )
    expect(result.ok).toBe(true)
  })

  it("refuses a capture mode whose content is missing or contradicted", () => {
    // A mode names what the user agreed to send. An envelope that disagrees
    // with it is a disagreement about consent, not a shape difference.
    const missingSelection = validateBrowserSubmission(
      payload({ context: { ...payload().context, captureMode: "selection" } })
    )
    expect(missingSelection).toMatchObject({
      ok: false,
      rejection: { code: "capture_mode_missing_content", field: "context.selection" },
    })

    const missingPage = validateBrowserSubmission(
      payload({ context: { ...payload().context, captureMode: "readable-page" } })
    )
    expect(missingPage).toMatchObject({
      ok: false,
      rejection: { code: "capture_mode_missing_content", field: "context.readableText" },
    })

    const metadataWithBody = validateBrowserSubmission(
      payload({
        context: {
          ...payload().context,
          captureMode: "metadata",
          selection: { text: "x", truncated: false },
        },
      })
    )
    expect(metadataWithBody).toMatchObject({
      ok: false,
      rejection: { field: "context.captureMode" },
    })
  })

  it("refuses any URL that is not http(s)", () => {
    // The extension is told to capture only http(s). The Host is the boundary
    // that has to say so rather than assume the client behaved.
    for (const url of [
      "file:///etc/passwd",
      "chrome://settings",
      "data:text/html,<h1>x",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html",
      "javascript:alert(1)",
      "not a url",
    ]) {
      const result = validateBrowserSubmission(payload({ context: { ...payload().context, url } }))
      expect(result).toMatchObject({ ok: false, rejection: { field: "context.url" } })
    }
  })

  it("refuses an unknown schema version or capture mode", () => {
    expect(
      validateBrowserSubmission(payload({ context: { ...payload().context, schemaVersion: 2 } }))
    ).toMatchObject({ ok: false, rejection: { field: "context.schemaVersion" } })
    expect(
      validateBrowserSubmission(
        payload({ context: { ...payload().context, captureMode: "screenshot" } })
      )
    ).toMatchObject({ ok: false, rejection: { field: "context.captureMode" } })
  })

  it("normalizes a blank suggested title away instead of storing whitespace", () => {
    const result = validateBrowserSubmission(payload({ suggestedTitle: "   " }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.suggestedTitle).toBeUndefined()
  })
})

describe("ADR-0228 fields", () => {
  const base = payload().context

  it("accepts an article with metadata, a transcript, a link and an image", () => {
    const result = validateBrowserSubmission(
      payload({
        context: {
          ...base,
          captureMode: "article",
          article: { text: "# A", truncated: false, originalCharacterCount: 3, format: "markdown" },
          selection: { text: "**b**", truncated: false, format: "markdown" },
          metadata: { byline: " Ada ", canonicalUrl: "javascript:alert(1)", extra: "x" },
          transcript: { status: "available", text: "[00:01] hi", truncated: false, language: "en" },
          link: { url: "https://example.com/l", text: "Link" },
          image: { url: "https://cdn.example.com/i.png", alt: "Chart" },
        },
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const context = result.request.context
    expect(context.article).toMatchObject({ text: "# A", format: "markdown" })
    expect(context.selection).toMatchObject({ format: "markdown" })
    // Trimmed, and a canonical URL that is not http(s) is dropped, as is a key
    // the contract does not name.
    expect(context.metadata).toEqual({ byline: "Ada" })
    expect(context.transcript).toEqual({
      status: "available",
      text: "[00:01] hi",
      truncated: false,
      language: "en",
    })
    expect(context.link).toEqual({ url: "https://example.com/l", text: "Link" })
    expect(context.image).toEqual({ url: "https://cdn.example.com/i.png", alt: "Chart" })
  })

  it("requires the article an article capture names", () => {
    expect(
      validateBrowserSubmission(payload({ context: { ...base, captureMode: "article" } }))
    ).toEqual({
      ok: false,
      rejection: { code: "capture_mode_missing_content", field: "context.article" },
    })
  })

  it("refuses a link or image that is not http(s), and an unknown transcript shape", () => {
    for (const [key, value] of [
      ["link", { url: "file:///etc/passwd" }],
      ["image", { url: "data:image/png;base64,AAAA" }],
      ["transcript", { status: "maybe" }],
      ["transcript", { status: "unavailable", reason: "because" }],
    ] as const) {
      const result = validateBrowserSubmission(payload({ context: { ...base, [key]: value } }))
      expect(result).toEqual({
        ok: false,
        rejection: { code: "malformed", field: `context.${key}` },
      })
    }
  })

  it("validates every added page and names the one that failed", () => {
    const result = validateBrowserSubmission(
      payload({ additionalContexts: [base, { ...base, url: "chrome://settings" }] })
    )
    expect(result).toEqual({
      ok: false,
      rejection: { code: "malformed", field: "additionalContexts[1].url" },
    })
  })

  it("bounds the pages and their total content", () => {
    const tooMany = validateBrowserSubmission(
      payload({ additionalContexts: Array.from({ length: 10 }, () => base) })
    )
    expect(tooMany).toMatchObject({
      ok: false,
      rejection: { code: "too_large", field: "additionalContexts" },
    })
    const big = {
      ...base,
      captureMode: "readable-page",
      readableText: {
        text: "x".repeat(BROWSER_CONTEXT_LIMITS.readableTextBytes),
        truncated: true,
        originalCharacterCount: 1_000_000,
      },
    }
    // Four full pages are exactly the total budget; one more byte of
    // selection tips it over while the envelope stays under its own ceiling.
    const withSelection = { ...big, selection: { text: "y", truncated: false } }
    const overBudget = validateBrowserSubmission(
      payload({ context: withSelection, additionalContexts: [big, big, big] })
    )
    expect(overBudget).toMatchObject({
      ok: false,
      rejection: { code: "too_large", field: "contexts" },
    })
  })

  it("accepts attachment refs once each, and only known kinds", () => {
    const ok = validateBrowserSubmission(
      payload({ attachments: [{ attachmentId: "upl_1", kind: "pdf", extra: true }] })
    )
    expect(ok.ok && ok.request.attachments).toEqual([{ attachmentId: "upl_1", kind: "pdf" }])
    for (const attachments of [
      [{ attachmentId: "upl_1", kind: "video" }],
      [
        { attachmentId: "upl_1", kind: "pdf" },
        { attachmentId: "upl_1", kind: "pdf" },
      ],
      "upl_1",
    ]) {
      expect(validateBrowserSubmission(payload({ attachments })).ok).toBe(false)
    }
  })
})
