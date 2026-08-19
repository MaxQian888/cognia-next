/** @jest-environment jsdom */

import {
  COMPOSER_MENTION_REQUEST_EVENT,
  onComposerMentionRequest,
  requestComposerMention,
} from "./composer-mention-request"

describe("composer mention request", () => {
  it("delivers the name to every subscriber and stops on unsubscribe", () => {
    const first: string[] = []
    const second: string[] = []
    const offFirst = onComposerMentionRequest((name) => first.push(name))
    const offSecond = onComposerMentionRequest((name) => second.push(name))

    requestComposerMention("Research Analyst")
    expect(first).toEqual(["Research Analyst"])
    expect(second).toEqual(["Research Analyst"])

    offFirst()
    requestComposerMention("Writing Editor")
    expect(first).toEqual(["Research Analyst"])
    expect(second).toEqual(["Research Analyst", "Writing Editor"])

    offSecond()
    requestComposerMention("Brainstorm Buddy")
    expect(second).toHaveLength(2)
  })

  it("ignores an event with no usable name rather than inserting '@undefined'", () => {
    const seen: string[] = []
    const off = onComposerMentionRequest((name) => seen.push(name))
    try {
      for (const detail of [undefined, null, {}, { name: "" }, { name: 42 }]) {
        window.dispatchEvent(new CustomEvent(COMPOSER_MENTION_REQUEST_EVENT, { detail }))
      }
      expect(seen).toEqual([])
      requestComposerMention("Ada")
      expect(seen).toEqual(["Ada"])
    } finally {
      off()
    }
  })
})
