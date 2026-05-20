/**
 * @jest-environment node
 */

import { summariseAtGateBlocks } from "./at-gate-stats"
import type { ConnectorAuditRow } from "@/lib/db/connector-types"

const NOW = 1_750_000_000_000

function block(reason: string, ageMs: number = 1000): ConnectorAuditRow {
  return {
    id: `aud-${Math.random()}`,
    adapterId: "tg-1",
    kind: "inbound.policy_blocked",
    at: NOW - ageMs,
    reason,
  } as ConnectorAuditRow
}

function other(kind: string): ConnectorAuditRow {
  return {
    id: `aud-${Math.random()}`,
    adapterId: "tg-1",
    kind,
    at: NOW - 1000,
  } as ConnectorAuditRow
}

describe("summariseAtGateBlocks", () => {
  it("returns zero for an empty input", () => {
    const summary = summariseAtGateBlocks([], { now: NOW })
    expect(summary.total).toBe(0)
    expect(summary.byReason).toEqual([])
  })

  it("counts only inbound.policy_blocked rows", () => {
    const rows = [
      block("at_mention_required"),
      other("inbound.received"),
      block("chat_blocklist"),
      other("delivery.success"),
    ]
    const summary = summariseAtGateBlocks(rows, { now: NOW })
    expect(summary.total).toBe(2)
  })

  it("groups by reason and sorts descending", () => {
    const rows = [
      block("at_mention_required"),
      block("at_mention_required"),
      block("at_mention_required"),
      block("chat_blocklist"),
      block("chat_allowlist"),
      block("chat_allowlist"),
    ]
    const summary = summariseAtGateBlocks(rows, { now: NOW })
    expect(summary.total).toBe(6)
    expect(summary.byReason).toEqual([
      { reason: "at_mention_required", count: 3 },
      { reason: "chat_allowlist", count: 2 },
      { reason: "chat_blocklist", count: 1 },
    ])
  })

  it("ignores rows older than the window", () => {
    const inside = block("at_mention_required", 1000)
    const outside = block("at_mention_required", 30 * 60 * 60 * 1000) // 30h
    const summary = summariseAtGateBlocks([inside, outside], {
      now: NOW,
      windowMs: 24 * 60 * 60 * 1000,
    })
    expect(summary.total).toBe(1)
  })

  it("buckets unknown reasons into 'other'", () => {
    const rows = [block("at_mention_required"), block("totally-made-up"), block("")]
    const summary = summariseAtGateBlocks(rows, { now: NOW })
    expect(summary.byReason).toContainEqual({ reason: "other", count: 2 })
    expect(summary.byReason).toContainEqual({ reason: "at_mention_required", count: 1 })
  })

  it("honours topN by folding the tail into 'other'", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => block("at_mention_required")),
      ...Array.from({ length: 8 }, () => block("chat_blocklist")),
      ...Array.from({ length: 5 }, () => block("chat_allowlist")),
      ...Array.from({ length: 2 }, () => block("at_direct_only")),
    ]
    const summary = summariseAtGateBlocks(rows, { now: NOW, topN: 2 })
    expect(summary.total).toBe(25)
    // Top 2: at_mention_required(10), chat_blocklist(8). Tail merged: 5+2=7 into 'other'.
    expect(summary.byReason).toEqual([
      { reason: "at_mention_required", count: 10 },
      { reason: "chat_blocklist", count: 8 },
      { reason: "other", count: 7 },
    ])
  })

  it("merges fold-into-other with a pre-existing 'other' bucket", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => block("at_mention_required")),
      ...Array.from({ length: 5 }, () => block("totally-unknown")),
      ...Array.from({ length: 3 }, () => block("chat_blocklist")),
    ]
    const summary = summariseAtGateBlocks(rows, { now: NOW, topN: 1 })
    expect(summary.byReason[0]).toEqual({ reason: "at_mention_required", count: 10 })
    // 5 unknown ("other") + 3 chat_blocklist folded = 8 in "other".
    expect(summary.byReason).toContainEqual({ reason: "other", count: 8 })
  })

  it("topN=0 returns total only with no histogram", () => {
    const rows = [block("at_mention_required")]
    const summary = summariseAtGateBlocks(rows, { now: NOW, topN: 0 })
    expect(summary.total).toBe(1)
    expect(summary.byReason).toEqual([{ reason: "other", count: 1 }])
  })
})
