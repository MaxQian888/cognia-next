import {
  inboundEditRevision,
  isNewerInboundEdit,
  mutationConversationMatches,
} from "./inbound-revision"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

it("keeps Matrix tie ordering invariant after terminal payload compaction", () => {
  const event = {
    platform: "matrix",
    timestamp: 20,
    messageId: "!r:s|$z",
    raw: { event_id: "$z" },
  } as NormalizedInboundEvent
  const compacted = { ...event, raw: undefined }
  expect(inboundEditRevision(compacted)).toEqual(inboundEditRevision(event))
  expect(
    isNewerInboundEdit(
      inboundEditRevision({ ...event, messageId: "!r:s|$a", raw: { event_id: "$a" } }),
      inboundEditRevision(compacted)
    )
  ).toBe(false)
})

it.each([
  ["matrix", { event_id: "$z" }, { event_id: "$a" }],
  ["telegram", { update_id: 102 }, { update_id: 101 }],
  ["slack", { event: { ts: "100.000102" } }, { event: { ts: "100.000101" } }],
  [
    "discord",
    { d: { edited_timestamp: "2026-10-23T00:00:00.000102+00:00" } },
    { d: { edited_timestamp: "2026-10-23T00:00:00.000101+00:00" } },
  ],
])("orders %s edits without losing wire precision", (platform, newer, older) => {
  const event = (raw: unknown) => ({ platform, timestamp: 1000, raw }) as NormalizedInboundEvent
  const current = inboundEditRevision(event(newer))
  expect(isNewerInboundEdit(inboundEditRevision(event(older)), current)).toBe(false)
  expect(isNewerInboundEdit(current, inboundEditRevision(event(older)))).toBe(true)
  expect(isNewerInboundEdit(current, current)).toBe(false)
})

it("rejects an older timestamp but permits unsequenced equal-clock edits", () => {
  expect(isNewerInboundEdit({ at: 1 }, { at: 2 })).toBe(false)
  expect(isNewerInboundEdit({ at: 2 }, { at: 2 })).toBe(true)
})

it("matches threadless mutations without crossing Matrix server ports or adapter scopes", () => {
  expect(mutationConversationMatches("lark:a:chat", "lark:a:chat:thread")).toBe(true)
  expect(mutationConversationMatches("lark:a:chat", "lark:a:chat-other:thread")).toBe(false)
  expect(mutationConversationMatches("matrix:a:!r:server", "matrix:a:!r:server:$thread")).toBe(true)
  expect(mutationConversationMatches("matrix:a:!r:server", "matrix:a:!r:server:8448")).toBe(false)
  expect(mutationConversationMatches("lark:a:chat", "lark:b:chat:thread")).toBe(false)
})
