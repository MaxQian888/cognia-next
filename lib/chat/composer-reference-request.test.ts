/** @jest-environment jsdom */

import {
  COMPOSER_REFERENCE_REQUEST_EVENT,
  onComposerReferenceRequest,
  requestComposerReference,
} from "./composer-reference-request"
import type { EntityMentionCandidate } from "./mentions/entity-sources"

const candidate: EntityMentionCandidate = {
  entityKind: "memory",
  id: "mem_1",
  title: "Prefers pnpm",
  searchText: "prefers pnpm",
}

describe("composer reference request", () => {
  it("delivers the candidate to a subscriber", () => {
    const handler = jest.fn()
    const off = onComposerReferenceRequest(handler)
    requestComposerReference(candidate)
    expect(handler).toHaveBeenCalledWith(candidate)
    off()
  })

  it("stops delivering after unsubscribe", () => {
    const handler = jest.fn()
    onComposerReferenceRequest(handler)()
    requestComposerReference(candidate)
    expect(handler).not.toHaveBeenCalled()
  })

  it("reaches every subscriber", () => {
    const a = jest.fn()
    const b = jest.fn()
    const offA = onComposerReferenceRequest(a)
    const offB = onComposerReferenceRequest(b)
    requestComposerReference(candidate)
    expect(a).toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
    offA()
    offB()
  })

  // A malformed event must stage nothing rather than a chip with no identity,
  // which the user could not remove by recognising it.
  it.each([
    ["no detail", undefined],
    ["no candidate", {}],
    ["no id", { candidate: { entityKind: "memory", title: "x", searchText: "" } }],
    ["an empty id", { candidate: { entityKind: "memory", id: "", title: "x", searchText: "" } }],
    ["no kind", { candidate: { id: "mem_1", title: "x", searchText: "" } }],
  ])("ignores an event with %s", (_label, detail) => {
    const handler = jest.fn()
    const off = onComposerReferenceRequest(handler)
    window.dispatchEvent(new CustomEvent(COMPOSER_REFERENCE_REQUEST_EVENT, { detail }))
    expect(handler).not.toHaveBeenCalled()
    off()
  })
})
