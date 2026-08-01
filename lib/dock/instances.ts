/**
 * The instance table: which panels are open, bound to what, and what a reveal
 * should do about it.
 *
 * Pure, and separate from the dockview grid on purpose. dockview knows about
 * boxes and tabs; it does not know that two tabs are the same panel over
 * different resources, that one of them holds a process-wide webview lease, or
 * that a reveal from a background job must not steal the group the user is
 * typing in. Those are the decisions that make the dock feel deliberate rather
 * than twitchy, so they live here where they can be reasoned about and pinned.
 */

import {
  dockInstanceKeyOf,
  dockInstanceMatchKey,
  type DockPanelInstance,
  type DockTabMode,
} from "@/types/dock/instance"
import type {
  DockRevealOutcome,
  DockRevealRequest,
  DockRevealUnavailableReason,
} from "@/types/dock/reveal"
import type { ResolvedDockPanel } from "@/types/dock/panel"

export interface DockRevealContext {
  instances: readonly DockPanelInstance[]
  /** Panels that resolved for the current resource, keyed by panel id. */
  available: ReadonlyMap<string, ResolvedDockPanel>
  /**
   * The user pinned this layout: automatic and plugin reveals become badges.
   * Explicit user reveals still go through — pinning guards against surprise,
   * not against the user's own click.
   */
  userPinned: boolean
  /** True while the user is mid-interaction somewhere else in the dock. */
  userBusy: boolean
  /** Mints instance ids. Injected so tests stay deterministic. */
  createInstanceId: () => string
}

export interface DockRevealPlan {
  outcome: DockRevealOutcome
  /** The instance table after the reveal. Unchanged when nothing happened. */
  instances: DockPanelInstance[]
}

function unavailable(
  instances: readonly DockPanelInstance[],
  reason: DockRevealUnavailableReason
): DockRevealPlan {
  return { outcome: { kind: "unavailable", reason }, instances: [...instances] }
}

/**
 * Decide what a reveal request does to the instance table.
 *
 * Order matters and encodes the policy:
 *  1. A panel that does not resolve for this resource cannot be revealed at all.
 *  2. An existing instance is always reused — a reveal never opens a second tab
 *     for something already on screen.
 *  3. A suppressed reveal degrades to an unread badge rather than doing nothing,
 *     so the user still learns the panel wants attention.
 *  4. Only then is a new instance opened, taking the preview slot if asked.
 */
export function planDockReveal(
  request: DockRevealRequest,
  context: DockRevealContext
): DockRevealPlan {
  const panel = context.available.get(request.panelId)
  if (!panel) return unavailable(context.instances, "panel-not-registered")

  const matchKey = dockInstanceMatchKey(request.panelId, request.resource?.key)
  const existing = context.instances.find((i) => dockInstanceKeyOf(i) === matchKey)
  const suppressed = isRevealSuppressed(request, context)

  if (existing) {
    if (suppressed || request.focus === "notify") {
      return {
        outcome: { kind: "badged", instanceId: existing.instanceId },
        instances: context.instances.map((i) =>
          i.instanceId === existing.instanceId ? { ...i, unread: (i.unread ?? 0) + 1 } : i
        ),
      }
    }
    return {
      outcome: {
        kind: "activated",
        instanceId: existing.instanceId,
        focused: request.focus === "focus",
      },
      instances: context.instances.map((i) =>
        i.instanceId === existing.instanceId ? clearUnread(i) : i
      ),
    }
  }

  // A global singleton already open somewhere else cannot be opened again: one
  // native webview, one lease. The caller decides whether to offer a "bring it
  // here" affordance.
  if (panel.meta.singletonPolicy === "singleton-global") {
    const elsewhere = context.instances.find((i) => i.panelId === request.panelId)
    if (elsewhere) return unavailable(context.instances, "native-surface-busy")
  }

  // Nothing to badge — there is no tab yet. A suppressed reveal for a panel
  // that is not open would have to create the very tab it is trying not to
  // disturb the user with, so it is dropped instead.
  if (suppressed) return unavailable(context.instances, "panel-not-applicable")

  const mode: DockTabMode = request.mode ?? "pinned"
  const evicted =
    mode === "preview" ? (context.instances.find((i) => i.mode === "preview") ?? null) : null

  const instance: DockPanelInstance = {
    instanceId: context.createInstanceId(),
    panelId: request.panelId,
    kind: panel.meta.kind,
    resource: request.resource,
    mode,
    dirty: false,
    activated: false,
  }

  const remaining = evicted
    ? context.instances.filter((i) => i.instanceId !== evicted.instanceId)
    : [...context.instances]

  return {
    outcome: {
      kind: "opened",
      instanceId: instance.instanceId,
      focused: request.focus === "focus",
      evictedInstanceId: evicted?.instanceId ?? null,
    },
    instances: [...remaining, instance],
  }
}

/**
 * A reveal the user did not ask for, arriving while the layout is pinned or
 * while they are working elsewhere, must not take the active tab.
 */
export function isRevealSuppressed(
  request: DockRevealRequest,
  context: Pick<DockRevealContext, "userPinned" | "userBusy">
): boolean {
  if (request.source === "user") return false
  return context.userPinned || context.userBusy
}

function clearUnread(instance: DockPanelInstance): DockPanelInstance {
  if (instance.unread === undefined) return instance
  const { unread: _unread, ...rest } = instance
  return rest
}

/**
 * `Array.prototype.map` always allocates, so a caller cannot tell "nothing
 * changed" from "everything was rewritten to an equal value". These mutators
 * return the *original* array when no element moved, which is what lets the
 * kernel skip a transaction — and therefore a revision bump and a write —
 * for a no-op.
 */
function mapPreservingIdentity<T>(items: readonly T[], project: (item: T) => T): T[] {
  let changed = false
  const next = items.map((item) => {
    const projected = project(item)
    if (projected !== item) changed = true
    return projected
  })
  return changed ? next : (items as T[])
}

/** Promote a preview tab to permanent. Anything else is returned untouched. */
export function pinDockInstance(
  instances: readonly DockPanelInstance[],
  instanceId: string
): DockPanelInstance[] {
  return mapPreservingIdentity(instances, (i) =>
    i.instanceId === instanceId && i.mode === "preview" ? { ...i, mode: "pinned" } : i
  )
}

/** Mark an instance activated so a later restore does not re-run first-activate. */
export function markDockInstanceActivated(
  instances: readonly DockPanelInstance[],
  instanceId: string
): DockPanelInstance[] {
  return mapPreservingIdentity(instances, (i) =>
    i.instanceId === instanceId && !i.activated ? { ...i, activated: true } : i
  )
}

/** Record whether an instance holds unsaved work. */
export function setDockInstanceDirty(
  instances: readonly DockPanelInstance[],
  instanceId: string,
  dirty: boolean
): DockPanelInstance[] {
  return mapPreservingIdentity(instances, (i) =>
    i.instanceId === instanceId && i.dirty !== dirty
      ? // Editing a preview tab makes it permanent, exactly as it does in the
        // project editor's strip — otherwise the next preview would evict a
        // buffer holding unsaved work.
        { ...i, dirty, mode: dirty ? "pinned" : i.mode }
      : i
  )
}

export function closeDockInstance(
  instances: readonly DockPanelInstance[],
  instanceId: string
): DockPanelInstance[] {
  return instances.filter((i) => i.instanceId !== instanceId)
}

/** Instances that would lose unsaved work if the given ids were closed. */
export function dirtyDockInstances(
  instances: readonly DockPanelInstance[],
  instanceIds: readonly string[]
): DockPanelInstance[] {
  const targets = new Set(instanceIds)
  return instances.filter((i) => targets.has(i.instanceId) && i.dirty)
}

/**
 * Drop instances whose panel no longer resolves — a plugin was disabled, or a
 * capability was revoked. Returns the survivors plus what went missing, so the
 * host can leave a restorable placeholder rather than silently shrinking the
 * layout.
 */
export function reconcileDockInstances(
  instances: readonly DockPanelInstance[],
  available: ReadonlyMap<string, ResolvedDockPanel>
): { instances: DockPanelInstance[]; unavailable: DockPanelInstance[] } {
  const kept: DockPanelInstance[] = []
  const lost: DockPanelInstance[] = []
  for (const instance of instances) {
    if (available.has(instance.panelId)) kept.push(instance)
    else lost.push(instance)
  }
  return { instances: kept, unavailable: lost }
}
