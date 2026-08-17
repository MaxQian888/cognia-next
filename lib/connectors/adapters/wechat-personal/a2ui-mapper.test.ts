import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { A2UIMessageSegment } from "@/types/connectors/segment"
import {
  __countNumericActionsForTesting,
  __resetNumericActionRegistryForTesting,
  __peekNumericActionForTesting,
} from "./numeric-action-registry"
import { buildIlinkA2UISurface, collectNumberedInteractives } from "./a2ui-mapper"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetNumericActionRegistryForTesting()
})
afterAll(dbFixture.dispose)

function makeSegment(
  surfaceId: string,
  components: Record<string, unknown>,
  rootId = "root"
): A2UIMessageSegment {
  return {
    type: "a2ui",
    surfaceId,
    plainTextMirror: "",
    content: { components, dataModel: {}, rootId },
  }
}

const TWO_BUTTON_SURFACE = makeSegment("sfc1", {
  root: { component: "Card", title: "Confirm", children: ["row"] },
  row: { component: "Row", children: ["yes", "no"] },
  yes: { component: "Button", text: "Yes", action: "confirm" },
  no: { component: "Button", text: "No", action: "cancel" },
})

describe("collectNumberedInteractives", () => {
  it("returns 1..N for buttons in render order", () => {
    const numbered = collectNumberedInteractives(TWO_BUTTON_SURFACE)
    expect(numbered.map((n) => ({ componentId: n.componentId, numeric: n.numeric }))).toEqual([
      { componentId: "yes", numeric: 1 },
      { componentId: "no", numeric: 2 },
    ])
  })

  it("collects Select / RadioGroup / Checkbox alongside Button", () => {
    const surface = makeSegment("s2", {
      root: { component: "Card", children: ["s", "r", "c"] },
      s: { component: "Select", options: [] },
      r: { component: "RadioGroup", options: [] },
      c: { component: "Checkbox", label: "agree" },
    })
    const numbered = collectNumberedInteractives(surface)
    expect(numbered.map((n) => n.componentId)).toEqual(["s", "r", "c"])
  })

  it("caps at 9 — single-digit replies only", () => {
    const components: Record<string, unknown> = {
      root: {
        component: "Card",
        children: Array.from({ length: 15 }, (_, i) => `b${i}`),
      },
    }
    for (let i = 0; i < 15; i++) {
      components[`b${i}`] = { component: "Button", text: `B${i}` }
    }
    const surface = makeSegment("s3", components)
    const numbered = collectNumberedInteractives(surface)
    expect(numbered).toHaveLength(9)
  })

  it("ignores non-interactive nodes (Text, Image, Divider)", () => {
    const surface = makeSegment("s4", {
      root: { component: "Card", children: ["t", "i", "d", "b"] },
      t: { component: "Text", text: "hi" },
      i: { component: "Image" },
      d: { component: "Divider" },
      b: { component: "Button", text: "Go" },
    })
    expect(collectNumberedInteractives(surface).map((n) => n.componentId)).toEqual(["b"])
  })

  it("preserves a wfapp: / wfcan: value as the wireActionId without minting an a2ui: form", () => {
    const surface = makeSegment("wf1", {
      root: { component: "Card", children: ["row"] },
      row: { component: "Row", children: ["approve", "cancel"] },
      approve: { component: "Button", text: "Approve", value: "wfapp:bind1", action: "approve" },
      cancel: { component: "Button", text: "Cancel", value: "wfcan:bind1", action: "cancel" },
    })
    const numbered = collectNumberedInteractives(surface)
    expect(numbered[0].wireActionId).toBe("wfapp:bind1")
    expect(numbered[0].needsBindingWrite).toBe(false)
    expect(numbered[1].wireActionId).toBe("wfcan:bind1")
    expect(numbered[1].needsBindingWrite).toBe(false)
  })

  it("mints an a2ui: wireActionId for buttons without a reserved value prefix", () => {
    const numbered = collectNumberedInteractives(TWO_BUTTON_SURFACE)
    expect(numbered[0].wireActionId).toBe("a2ui:sfc1:yes:confirm")
    expect(numbered[0].needsBindingWrite).toBe(true)
  })
})

describe("buildIlinkA2UISurface", () => {
  it("returns the bare mirror when the surface has no interactive components", async () => {
    const surface = makeSegment("s5", {
      root: { component: "Card", title: "Notice", children: ["t"] },
      t: { component: "Text", text: "Update applied." },
    })
    const result = await buildIlinkA2UISurface({
      adapterId: "ad1",
      conversationKey: "wechat-personal:ad1:u1",
      segment: surface,
    })
    expect(result.numberedCount).toBe(0)
    expect(result.textMirror).toContain("Notice")
    expect(result.textMirror).not.toContain("回复数字触发按钮")
    const bindings = await getDb().connectorCallbackBindings.toArray()
    expect(bindings).toHaveLength(0)
  })

  it("writes a callback_query binding for each plain Button + populates the registry", async () => {
    const adapterId = "ad1"
    const conversationKey = "wechat-personal:ad1:u1"
    const result = await buildIlinkA2UISurface({
      adapterId,
      conversationKey,
      segment: TWO_BUTTON_SURFACE,
    })
    expect(result.numberedCount).toBe(2)
    expect(result.textMirror).toContain("1) Yes")
    expect(result.textMirror).toContain("2) No")

    const bindings = await getDb().connectorCallbackBindings.toArray()
    expect(bindings).toHaveLength(2)
    expect(bindings.every((b) => b.kind === "callback_query")).toBe(true)
    const yesBinding = bindings.find((b) => b.componentId === "yes")
    expect(yesBinding?.actionId).toBe("a2ui:sfc1:yes:confirm")

    expect(__peekNumericActionForTesting(conversationKey, 1)).toBe("a2ui:sfc1:yes:confirm")
    expect(__peekNumericActionForTesting(conversationKey, 2)).toBe("a2ui:sfc1:no:cancel")
    expect(__countNumericActionsForTesting(conversationKey)).toBe(2)
  })

  it("reuses an existing wfapp:/wfcan: binding without writing a duplicate row", async () => {
    const adapterId = "ad1"
    const conversationKey = "wechat-personal:ad1:u1"
    // Simulate the upstream tool: workflow run-by-name already recorded
    // the approve binding under the wfapp: id.
    await recordCallbackBinding({
      adapterId,
      actionId: "wfapp:bind1",
      kind: "wf_approve",
      surfaceId: "wf1",
      componentId: "approve",
      conversationKey,
      payload: { workflowId: "wf_x" },
    })

    const surface = makeSegment("wf1", {
      root: { component: "Card", children: ["row"] },
      row: { component: "Row", children: ["approve"] },
      approve: { component: "Button", text: "Approve", value: "wfapp:bind1", action: "approve" },
    })
    const result = await buildIlinkA2UISurface({
      adapterId,
      conversationKey,
      segment: surface,
    })
    expect(result.numberedCount).toBe(1)

    const bindings = await getDb().connectorCallbackBindings.toArray()
    expect(bindings).toHaveLength(1)
    // The existing wf_approve binding is untouched — no duplicate row.
    expect(bindings[0].kind).toBe("wf_approve")
    expect(__peekNumericActionForTesting(conversationKey, 1)).toBe("wfapp:bind1")
  })

  it("uses seg.plainTextMirror as the base when provided, generating one otherwise", async () => {
    const withPrebuilt: A2UIMessageSegment = {
      ...TWO_BUTTON_SURFACE,
      plainTextMirror: "# Pre-baked mirror",
    }
    const result = await buildIlinkA2UISurface({
      adapterId: "ad",
      conversationKey: "wechat-personal:ad:u1",
      segment: withPrebuilt,
    })
    expect(result.textMirror.startsWith("# Pre-baked mirror")).toBe(true)
  })
})
