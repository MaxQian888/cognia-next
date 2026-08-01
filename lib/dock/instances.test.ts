import {
  closeDockInstance,
  dirtyDockInstances,
  isRevealSuppressed,
  markDockInstanceActivated,
  pinDockInstance,
  planDockReveal,
  reconcileDockInstances,
  setDockInstanceDirty,
  type DockRevealContext,
} from "./instances"
import { resolveDockPanel } from "./derive-panel-metadata"
import type { DockPanelInstance } from "@/types/dock/instance"
import type { ContextPanelDefinition } from "@/types/context-workbench"
import type { DockPanelDefinition, ResolvedDockPanel } from "@/types/dock/panel"
import type { DockRevealRequest } from "@/types/dock/reveal"

const renderer = (() => null) as unknown as ContextPanelDefinition["renderer"]

function definition(id: string, overrides: Partial<DockPanelDefinition> = {}): DockPanelDefinition {
  return {
    id,
    activity: "inspect",
    labelKey: `dock.panels.${id}`,
    appliesTo: () => true,
    renderer,
    ...overrides,
  }
}

function availableMap(...definitions: DockPanelDefinition[]): Map<string, ResolvedDockPanel> {
  return new Map(definitions.map((d) => [d.id, resolveDockPanel(d)]))
}

function instance(overrides: Partial<DockPanelInstance> = {}): DockPanelInstance {
  return {
    instanceId: "i1",
    panelId: "review",
    kind: "panel",
    mode: "pinned",
    dirty: false,
    activated: false,
    ...overrides,
  }
}

function context(overrides: Partial<DockRevealContext> = {}): DockRevealContext {
  let n = 0
  return {
    instances: [],
    available: availableMap(definition("review")),
    userPinned: false,
    userBusy: false,
    createInstanceId: () => `new-${++n}`,
    ...overrides,
  }
}

const reveal = (overrides: Partial<DockRevealRequest> = {}): DockRevealRequest => ({
  panelId: "review",
  source: "user",
  focus: "focus",
  ...overrides,
})

describe("planDockReveal", () => {
  it("refuses to reveal a panel that does not resolve here", () => {
    const plan = planDockReveal(reveal({ panelId: "ghost" }), context())
    expect(plan.outcome).toEqual({ kind: "unavailable", reason: "panel-not-registered" })
    expect(plan.instances).toEqual([])
  })

  it("opens a new pinned tab by default", () => {
    const plan = planDockReveal(reveal(), context())
    expect(plan.outcome).toEqual({
      kind: "opened",
      instanceId: "new-1",
      focused: true,
      evictedInstanceId: null,
    })
    expect(plan.instances).toHaveLength(1)
    expect(plan.instances[0]).toMatchObject({ panelId: "review", mode: "pinned", dirty: false })
  })

  it("reuses an existing instance instead of opening a second tab", () => {
    const existing = instance()
    const plan = planDockReveal(reveal(), context({ instances: [existing] }))
    expect(plan.outcome).toEqual({ kind: "activated", instanceId: "i1", focused: true })
    expect(plan.instances).toHaveLength(1)
  })

  it("matches an instance by resource, not by panel id alone", () => {
    const a = instance({
      instanceId: "a",
      panelId: "editor",
      resource: { key: "f:a", kind: "project-file" },
    })
    const plan = planDockReveal(
      reveal({ panelId: "editor", resource: { key: "f:b", kind: "project-file" } }),
      context({
        instances: [a],
        available: availableMap(definition("editor", { dock: { kind: "editor" } })),
      })
    )
    expect(plan.outcome).toMatchObject({ kind: "opened" })
    expect(plan.instances).toHaveLength(2)
  })

  it("clears the unread badge when the user activates the tab", () => {
    const existing = instance({ unread: 3 })
    const bystander = instance({ instanceId: "other", panelId: "other", unread: 2 })
    const plan = planDockReveal(
      reveal(),
      context({
        instances: [existing, bystander],
        available: availableMap(definition("review"), definition("other")),
      })
    )
    expect(plan.instances[0]).not.toHaveProperty("unread")
    // A bystander's badge is not collateral damage.
    expect(plan.instances[1]).toBe(bystander)
  })

  it("badges instead of stealing focus when the layout is pinned", () => {
    // ADR-0083's rule, carried forward: pinning turns automatic reveals into
    // pending state rather than into a jump.
    const existing = instance()
    const bystander = instance({ instanceId: "other", panelId: "other" })
    const plan = planDockReveal(
      reveal({ source: "automatic" }),
      context({
        instances: [existing, bystander],
        userPinned: true,
        available: availableMap(definition("review"), definition("other")),
      })
    )
    expect(plan.outcome).toEqual({ kind: "badged", instanceId: "i1" })
    expect(plan.instances[0]?.unread).toBe(1)
    expect(plan.instances[1]).toBe(bystander)
  })

  it("badges while the user is busy elsewhere", () => {
    const plan = planDockReveal(
      reveal({ source: "plugin" }),
      context({ instances: [instance()], userBusy: true })
    )
    expect(plan.outcome).toMatchObject({ kind: "badged" })
  })

  it("lets an explicit user reveal through a pinned layout", () => {
    const plan = planDockReveal(
      reveal({ source: "user" }),
      context({ instances: [instance()], userPinned: true, userBusy: true })
    )
    expect(plan.outcome).toMatchObject({ kind: "activated", focused: true })
  })

  it("honours a notify-only reveal without changing the active tab", () => {
    const plan = planDockReveal(reveal({ focus: "notify" }), context({ instances: [instance()] }))
    expect(plan.outcome).toEqual({ kind: "badged", instanceId: "i1" })
  })

  it("activates without focusing when asked", () => {
    const plan = planDockReveal(reveal({ focus: "activate" }), context({ instances: [instance()] }))
    expect(plan.outcome).toEqual({ kind: "activated", instanceId: "i1", focused: false })
  })

  it("drops a suppressed reveal for a panel that is not open yet", () => {
    // There is no tab to badge, and creating one would be exactly the
    // interruption the suppression exists to avoid.
    const plan = planDockReveal(reveal({ source: "automatic" }), context({ userPinned: true }))
    expect(plan.outcome).toEqual({ kind: "unavailable", reason: "panel-not-applicable" })
    expect(plan.instances).toEqual([])
  })

  it("refuses a second instance of a global singleton", () => {
    const browser = definition("browser", { dock: { kind: "native-surface" } })
    const plan = planDockReveal(
      reveal({ panelId: "browser", resource: { key: "s:2", kind: "session" } }),
      context({
        available: availableMap(browser),
        instances: [
          instance({
            instanceId: "b1",
            panelId: "browser",
            kind: "native-surface",
            resource: { key: "s:1", kind: "session" },
          }),
        ],
      })
    )
    expect(plan.outcome).toEqual({ kind: "unavailable", reason: "native-surface-busy" })
  })

  it("reuses the single preview slot when opening in preview mode", () => {
    const old = instance({ instanceId: "p1", panelId: "a", mode: "preview" })
    const plan = planDockReveal(
      reveal({ panelId: "b", mode: "preview" }),
      context({
        instances: [old],
        available: availableMap(definition("a"), definition("b")),
      })
    )
    expect(plan.outcome).toMatchObject({ kind: "opened", evictedInstanceId: "p1" })
    expect(plan.instances.map((i) => i.panelId)).toEqual(["b"])
  })

  it("never evicts a pinned tab for a preview", () => {
    const pinned = instance({ instanceId: "p1", panelId: "a", mode: "pinned" })
    const plan = planDockReveal(
      reveal({ panelId: "b", mode: "preview" }),
      context({
        instances: [pinned],
        available: availableMap(definition("a"), definition("b")),
      })
    )
    expect(plan.outcome).toMatchObject({ evictedInstanceId: null })
    expect(plan.instances).toHaveLength(2)
  })
})

describe("isRevealSuppressed", () => {
  it("only suppresses non-user sources", () => {
    const busy = { userPinned: false, userBusy: true }
    expect(isRevealSuppressed(reveal({ source: "user" }), busy)).toBe(false)
    expect(isRevealSuppressed(reveal({ source: "automatic" }), busy)).toBe(true)
    expect(isRevealSuppressed(reveal({ source: "plugin" }), busy)).toBe(true)
    expect(
      isRevealSuppressed(reveal({ source: "automatic" }), { userPinned: false, userBusy: false })
    ).toBe(false)
  })
})

describe("instance table mutators", () => {
  it("pins a preview tab and leaves everything else alone", () => {
    const before = [instance({ instanceId: "a", mode: "preview" }), instance({ instanceId: "b" })]
    const after = pinDockInstance(before, "a")
    expect(after[0]?.mode).toBe("pinned")
    expect(after[1]).toBe(before[1])
    // Nothing to change: the same array comes back, so the caller can skip a
    // transaction entirely.
    expect(pinDockInstance(after, "a")).toBe(after)
  })

  it("marks an instance activated exactly once", () => {
    const before = [instance()]
    const once = markDockInstanceActivated(before, "i1")
    expect(once[0]?.activated).toBe(true)
    expect(markDockInstanceActivated(once, "i1")).toBe(once)
    expect(markDockInstanceActivated(before, "missing")).toBe(before)
  })

  it("pins a preview tab as soon as it goes dirty", () => {
    const after = setDockInstanceDirty([instance({ mode: "preview" })], "i1", true)
    expect(after[0]).toMatchObject({ dirty: true, mode: "pinned" })
  })

  it("leaves the mode alone when clearing dirty", () => {
    const dirty = setDockInstanceDirty([instance({ mode: "pinned" })], "i1", true)
    const clean = setDockInstanceDirty(dirty, "i1", false)
    expect(clean[0]).toMatchObject({ dirty: false, mode: "pinned" })
  })

  it("is a no-op when the dirty flag already matches", () => {
    const before = [instance({ dirty: true })]
    expect(setDockInstanceDirty(before, "i1", true)).toBe(before)
  })

  it("closes by instance id", () => {
    const before = [instance({ instanceId: "a" }), instance({ instanceId: "b" })]
    expect(closeDockInstance(before, "a").map((i) => i.instanceId)).toEqual(["b"])
  })

  it("lists which of the targeted instances hold unsaved work", () => {
    const before = [
      instance({ instanceId: "a", dirty: true }),
      instance({ instanceId: "b" }),
      instance({ instanceId: "c", dirty: true }),
    ]
    expect(dirtyDockInstances(before, ["a", "b"]).map((i) => i.instanceId)).toEqual(["a"])
  })
})

describe("reconcileDockInstances", () => {
  it("separates instances whose panel disappeared so a placeholder can stay", () => {
    const before = [
      instance({ instanceId: "a", panelId: "review" }),
      instance({ instanceId: "b", panelId: "acme.panel" }),
    ]
    const { instances, unavailable } = reconcileDockInstances(
      before,
      availableMap(definition("review"))
    )
    expect(instances.map((i) => i.instanceId)).toEqual(["a"])
    expect(unavailable.map((i) => i.instanceId)).toEqual(["b"])
  })
})
