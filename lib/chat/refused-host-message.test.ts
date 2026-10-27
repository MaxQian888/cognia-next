import {
  refusedHostMessageOf,
  withoutRefusedHostMessages,
  isHostEnqueuePlaceholder,
  refusedHostMessageId,
} from "./refused-host-message"
import type { TranscriptTimelineItem } from "@cognia/agent-config-types"

const message = {
  role: "user",
  metadata: {
    hostState: {
      optimistic: true,
      refusal: { code: "model_access_unavailable", at: 123 },
      attachmentRefs: [{ name: "notes.txt", mediaType: "text/plain", size: 4 }],
    },
  },
}

it("recognizes a local refused intent and keeps its attachment references", () => {
  expect(refusedHostMessageOf(message)).toEqual({
    code: "model_access_unavailable",
    at: 123,
    attachments: [{ name: "notes.txt", mediaType: "text/plain", size: 4 }],
  })
})

it("keeps content for an uncatalogued Host refusal as well", () => {
  expect(
    refusedHostMessageOf({
      ...message,
      metadata: {
        hostState: {
          ...message.metadata.hostState,
          refusal: { code: "upstream refused this request", at: 123 },
        },
      },
    })?.code
  ).toBe("upstream refused this request")
})

it.each([
  null,
  { ...message, role: "assistant" },
  { ...message, metadata: { hostState: { ...message.metadata.hostState, optimistic: false } } },
  { role: "user", metadata: { hostState: { optimistic: true } } },
  {
    role: "user",
    metadata: { hostState: { optimistic: true, refusal: { code: "", at: 1 } } },
  },
])("does not treat an unconfirmed or canonical row as a refusal: %p", (candidate) => {
  expect(refusedHostMessageOf(candidate)).toBeNull()
})

it.each([-1, NaN, Infinity, "123"])("refuses an invalid refusal timestamp: %p", (at) => {
  expect(
    refusedHostMessageOf({
      ...message,
      metadata: {
        hostState: {
          ...message.metadata.hostState,
          refusal: { code: "org_agent_not_allowed", at },
        },
      },
    })
  ).toBeNull()
})

it("ignores invalid attachment metadata and accepts a text-only refusal", () => {
  const hostState = {
    ...message.metadata.hostState,
    attachmentRefs: [null, { name: 1 }, { name: "bad", mediaType: "text/plain", size: -1 }],
  }
  expect(refusedHostMessageOf({ ...message, metadata: { hostState } })?.attachments).toEqual([])
  expect(
    refusedHostMessageOf({
      ...message,
      metadata: { hostState: { ...hostState, attachmentRefs: undefined } },
    })?.attachments
  ).toEqual([])
})

it("filters refused placeholders without hiding unrelated timeline content", () => {
  const items = [
    { kind: "system", itemKey: "system:1", message: { id: "system" } },
    { kind: "active-turn", itemKey: "active:1", messages: [{ id: "refused" }, { id: "other" }] },
    { kind: "active-turn", itemKey: "active:2", messages: [{ id: "refused" }] },
    { kind: "completed-turn", itemKey: "complete:1", userMessages: [{ id: "refused" }] },
    { kind: "completed-turn", itemKey: "complete:2", userMessages: [{ id: "other" }] },
  ] as TranscriptTimelineItem[]
  expect(withoutRefusedHostMessages(items, new Set())).toBe(items)
  expect(withoutRefusedHostMessages(items, new Set(["refused"]))).toEqual([
    items[0],
    { ...items[1], messages: [{ id: "other" }] },
    items[4],
  ])
})

it("uses a separate local id and distinguishes an enqueue placeholder from runtime confirmation", () => {
  expect(refusedHostMessageId("a1")).toBe("host-state-refused:a1")
  expect(
    isHostEnqueuePlaceholder({ role: "user", metadata: { hostState: { actionId: "a1" } } }, "a1")
  ).toBe(true)
  expect(isHostEnqueuePlaceholder({ role: "user", metadata: {} }, "a1")).toBe(false)
  expect(
    isHostEnqueuePlaceholder(
      { role: "assistant", metadata: { hostState: { actionId: "a1" } } },
      "a1"
    )
  ).toBe(false)
})
