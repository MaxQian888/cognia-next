/** @jest-environment jsdom */
import {
  COMPOSER_APPEND_EVENT,
  composerAppendHasContent,
  dispatchComposerAppend,
  type ComposerAppendDetail,
} from "./composer-append"

describe("dispatchComposerAppend", () => {
  it("reports unclaimed when no composer listens", () => {
    expect(dispatchComposerAppend({ text: "hi", sessionId: "s1" })).toBe(false)
  })

  it("reports claimed when a composer takes the event", () => {
    const seen: ComposerAppendDetail[] = []
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<ComposerAppendDetail>).detail
      seen.push(detail)
      detail.claimed = true
    }
    window.addEventListener(COMPOSER_APPEND_EVENT, listener)
    try {
      expect(dispatchComposerAppend({ text: "hi", sessionId: "s1" })).toBe(true)
      expect(seen[0]).toMatchObject({ text: "hi", sessionId: "s1" })
    } finally {
      window.removeEventListener(COMPOSER_APPEND_EVENT, listener)
    }
  })
})

describe("composerAppendHasContent", () => {
  it("counts files, citations, envelopes and a reply target, not just text", () => {
    expect(composerAppendHasContent(undefined)).toBe(false)
    expect(composerAppendHasContent({ text: "  " })).toBe(false)
    expect(composerAppendHasContent({ text: "x" })).toBe(true)
    expect(composerAppendHasContent({ files: [new File(["a"], "a.txt")] })).toBe(true)
    expect(composerAppendHasContent({ citations: [{ kind: "entity", id: "memory:1" }] })).toBe(true)
    expect(composerAppendHasContent({ carried: [{ preamble: "<x>" }] })).toBe(true)
    expect(composerAppendHasContent({ replyTo: { messageId: "m", preview: "p" } })).toBe(true)
  })
})

it("carries an explicit submit request and its acknowledgement to the claiming bridge", () => {
  const onSubmitted = jest.fn()
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ComposerAppendDetail>).detail
    expect(detail.submit).toBe(true)
    detail.claimed = true
    detail.onSubmitted?.(false)
  }
  window.addEventListener(COMPOSER_APPEND_EVENT, listener)
  try {
    expect(
      dispatchComposerAppend({ sessionId: "main", text: "quote", submit: true, onSubmitted })
    ).toBe(true)
    expect(onSubmitted).toHaveBeenCalledWith(false)
  } finally {
    window.removeEventListener(COMPOSER_APPEND_EVENT, listener)
  }
})
