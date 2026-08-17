/** @jest-environment jsdom */
/**
 * Tests for the shared A2UI mapper toolkit.
 *
 * Uses fake-indexeddb so the recordCallbackBinding / resolveCallbackBinding
 * round-trip exercises the real Dexie path against the v38 schema.
 */

import "fake-indexeddb/auto"
import {
  buildActionId,
  generatePlainTextMirror,
  pruneOldCallbackBindings,
  recordCallbackBinding,
  resolveCallbackBinding,
  truncateActionId,
  walkA2UISurface,
  type A2UIWalkNode,
  bindingHintFields,
} from "./a2ui-mapper"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

const SAMPLE_SURFACE: A2UISegmentContent = {
  components: {
    root: { id: "root", component: "Column", children: ["t1", "card1"] },
    t1: { id: "t1", component: "Text", text: "Hello" },
    card1: { id: "card1", component: "Card", title: "Choices", children: ["btn1", "btn2"] },
    btn1: { id: "btn1", component: "Button", text: "Yes", action: "confirm" },
    btn2: { id: "btn2", component: "Button", text: "No", action: "deny" },
  },
  dataModel: {},
  rootId: "root",
}

describe("walkA2UISurface", () => {
  it("traverses depth-first from rootId", () => {
    const visits: Array<{ id: string; depth: number }> = []
    walkA2UISurface(SAMPLE_SURFACE, (node, depth) => {
      visits.push({ id: node.id, depth })
    })
    expect(visits.map((v) => v.id)).toEqual(["root", "t1", "card1", "btn1", "btn2"])
    expect(visits.map((v) => v.depth)).toEqual([0, 1, 1, 2, 2])
  })

  it("short-circuits on cycles", () => {
    const surface: A2UISegmentContent = {
      components: {
        a: { id: "a", component: "Column", children: ["b"] },
        b: { id: "b", component: "Column", children: ["a"] },
      },
      dataModel: {},
      rootId: "a",
    }
    const visited: string[] = []
    walkA2UISurface(surface, (n) => visited.push(n.id))
    expect(visited).toEqual(["a", "b"])
  })

  it("recovers children for Dialog body", () => {
    const surface: A2UISegmentContent = {
      components: {
        d: { id: "d", component: "Dialog", title: "x", body: ["t"] },
        t: { id: "t", component: "Text", text: "ok" },
      },
      dataModel: {},
      rootId: "d",
    }
    const ids: string[] = []
    walkA2UISurface(surface, (n: A2UIWalkNode) => ids.push(n.id))
    expect(ids).toEqual(["d", "t"])
  })

  it("treats unknown component as Text with empty children", () => {
    const surface: A2UISegmentContent = {
      components: {
        x: { id: "x", component: "WeirdCustom", payload: { stuff: 1 } },
      },
      dataModel: {},
      rootId: "x",
    }
    let observed: A2UIWalkNode | null = null
    walkA2UISurface(surface, (n) => {
      observed = n
    })
    expect(observed).not.toBeNull()
    expect(observed!.component).toBe("WeirdCustom")
    expect(observed!.childIds).toEqual([])
  })
})

describe("buildActionId / truncateActionId", () => {
  it("buildActionId is deterministic", () => {
    expect(buildActionId("sfc1", "btn1", "confirm")).toBe("a2ui:sfc1:btn1:confirm")
  })

  it("truncateActionId passes short ids through unchanged", async () => {
    const r = await truncateActionId("a2ui:s:b:x", 64)
    expect(r.isHashed).toBe(false)
    expect(r.wireId).toBe("a2ui:s:b:x")
  })

  it("truncateActionId hashes ids longer than maxBytes", async () => {
    const long = `a2ui:${"x".repeat(80)}:btn:confirm`
    const r = await truncateActionId(long, 64)
    expect(r.isHashed).toBe(true)
    expect(r.wireId.startsWith("a2ui:#")).toBe(true)
    // Deterministic: same input yields same hash.
    const r2 = await truncateActionId(long, 64)
    expect(r2.wireId).toBe(r.wireId)
  })
})

describe("callback binding persistence", () => {
  it("recordCallbackBinding upserts by [adapterId+actionId]", async () => {
    await recordCallbackBinding({
      adapterId: "adp_1",
      actionId: "a2ui:s1:b1:confirm",
      surfaceId: "s1",
      componentId: "b1",
      conversationKey: "telegram:adp_1:chat",
    })
    const found = await resolveCallbackBinding("adp_1", "a2ui:s1:b1:confirm")
    expect(found).toBeDefined()
    expect(found!.surfaceId).toBe("s1")
    expect(found!.componentId).toBe("b1")
    expect(found!.conversationKey).toBe("telegram:adp_1:chat")
  })

  it("recordCallbackBinding overwrites on re-record (idempotent)", async () => {
    await recordCallbackBinding({
      adapterId: "adp_1",
      actionId: "act_1",
      surfaceId: "s_old",
    })
    await recordCallbackBinding({
      adapterId: "adp_1",
      actionId: "act_1",
      surfaceId: "s_new",
      componentId: "btn",
    })
    const r = await resolveCallbackBinding("adp_1", "act_1")
    expect(r?.surfaceId).toBe("s_new")
    expect(r?.componentId).toBe("btn")
    expect(await getDb().connectorCallbackBindings.count()).toBe(1)
  })

  it("resolveCallbackBinding returns undefined for unknown actionId", async () => {
    expect(await resolveCallbackBinding("adp_1", "missing")).toBeUndefined()
  })

  it("resolveCallbackBinding treats an expired binding as unresolved", async () => {
    // Expiry is enforced at read time, not only by the daily cleanup sweep —
    // a click on a stale card must not resolve until the sweep happens to run.
    await recordCallbackBinding({
      adapterId: "adp_1",
      actionId: "act_expired",
      surfaceId: "s",
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() - 1,
    })
    expect(await resolveCallbackBinding("adp_1", "act_expired")).toBeUndefined()

    // A binding without expiresAt (pre-TTL legacy row) never expires here.
    await getDb().connectorCallbackBindings.add({
      id: "adp_1:act_legacy",
      adapterId: "adp_1",
      actionId: "act_legacy",
      kind: "callback_query",
      surfaceId: "s_legacy",
      createdAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
    })
    expect((await resolveCallbackBinding("adp_1", "act_legacy"))?.surfaceId).toBe("s_legacy")
  })

  it("pruneOldCallbackBindings deletes rows older than TTL for the given adapter", async () => {
    const now = Date.now()
    // Insert one fresh row + one stale row.
    await getDb().connectorCallbackBindings.bulkAdd([
      {
        id: "adp_1:fresh",
        adapterId: "adp_1",
        actionId: "fresh",
        kind: "callback_query",
        surfaceId: "s",
        createdAt: now,
      },
      {
        id: "adp_1:stale",
        adapterId: "adp_1",
        actionId: "stale",
        kind: "callback_query",
        surfaceId: "s",
        createdAt: now - 20 * 24 * 60 * 60 * 1000,
      },
      {
        // Other adapter — should not be touched.
        id: "adp_2:also_stale",
        adapterId: "adp_2",
        actionId: "also_stale",
        kind: "callback_query",
        surfaceId: "s",
        createdAt: now - 20 * 24 * 60 * 60 * 1000,
      },
    ])
    const removed = await pruneOldCallbackBindings("adp_1")
    expect(removed).toBe(1)
    const remaining = await getDb().connectorCallbackBindings.toArray()
    expect(remaining.map((r) => r.actionId).sort()).toEqual(["also_stale", "fresh"])
  })
})

describe("generatePlainTextMirror", () => {
  it("renders a bullet-list projection of common components", () => {
    const out = generatePlainTextMirror(SAMPLE_SURFACE)
    expect(out).toContain("Hello")
    expect(out).toContain("# Choices")
    expect(out).toContain("[Yes]")
    expect(out).toContain("[No]")
  })

  it("emits placeholders for unknown components so the user sees something", () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Chart", chartType: "bar" },
      },
      dataModel: {},
      rootId: "root",
    }
    const out = generatePlainTextMirror(surface)
    expect(out).toBe("[Chart]")
  })

  it("renders alerts with title + body", () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Alert", title: "Heads up", text: "Backup failed" },
      },
      dataModel: {},
      rootId: "root",
    }
    expect(generatePlainTextMirror(surface)).toBe("[!] Heads up: Backup failed")
  })

  it("emits an input placeholder for TextField / TextArea", () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["t", "a"] },
        t: { id: "t", component: "TextField", value: "", label: "Name" },
        a: { id: "a", component: "TextArea", value: "", placeholder: "Comments" },
      },
      dataModel: {},
      rootId: "root",
    }
    const out = generatePlainTextMirror(surface)
    expect(out).toContain("[Name: __________]")
    expect(out).toContain("[Comments: __________]")
  })

  it("emits select options separated by slash", () => {
    const surface: A2UISegmentContent = {
      components: {
        root: {
          id: "root",
          component: "Select",
          value: "",
          label: "Pick",
          options: [
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
          ],
        },
      },
      dataModel: {},
      rootId: "root",
    }
    expect(generatePlainTextMirror(surface)).toBe("Pick: Alpha / Beta")
  })
})

describe("bindingHintFields", () => {
  it("returns {} without hints and forwards well-formed kind / payload hints", () => {
    expect(bindingHintFields(undefined)).toEqual({})
    expect(bindingHintFields({ component: "Button" })).toEqual({})
    expect(bindingHintFields({ bindingKind: "issue_action" })).toEqual({ kind: "issue_action" })
    expect(
      bindingHintFields({
        bindingKind: "issue_action",
        bindingPayload: { action: "run", issueId: "i" },
      })
    ).toEqual({ kind: "issue_action", payload: { action: "run", issueId: "i" } })
    // Non-string kinds and non-object payloads are ignored, not forwarded.
    expect(bindingHintFields({ bindingKind: 3, bindingPayload: [1] })).toEqual({})
    expect(bindingHintFields({ bindingPayload: "nope" })).toEqual({})
  })
})
