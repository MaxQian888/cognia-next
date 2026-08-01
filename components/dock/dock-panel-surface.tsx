"use client"

/**
 * Renders one dock tab's contents.
 *
 * This is the seam that makes the migration cheap: a `ContextPanelDefinition`'s
 * `renderer` takes `ContextPanelRenderProps`, and that is exactly what this
 * builds. Every panel the Context Workbench already hosts drops into a dock tab
 * with no edit, because from the panel's point of view nothing changed — it is
 * still handed a workbench instance id, a resource, and whether it is active.
 *
 * What this adds around it:
 *   - the error boundary, so one crashing panel takes its own tab rather than
 *     the whole layout (dockview renders panels as siblings; an unguarded throw
 *     unmounts the tree that owns the grid);
 *   - `onFirstActivate` / `onRestore`, which have to fire exactly once and pick
 *     the right one — the instance table's `activated` flag is what tells them
 *     apart across a reload;
 *   - the unavailable placeholder for a panel whose plugin went away.
 */

import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from "react"
import { DockPanelUnavailable } from "./dock-panel-unavailable"
import type { ContextResource } from "@/types/context-workbench"
import type { DockPanelInstance } from "@/types/dock/instance"
import type { ResolvedDockPanel } from "@/types/dock/panel"

interface PanelErrorBoundaryProps {
  children: ReactNode
  fallback: (retry: () => void) => ReactNode
  /** Reset the boundary when the tab starts rendering something else. */
  resetKey: string
}

/**
 * Mirrors the Context Workbench's own panel boundary rather than importing it:
 * that one is a private class inside a 1400-line client component, and reaching
 * into it would couple the dock to that file's lifetime. The behaviour is the
 * contract, and it is pinned by this file's tests.
 */
class DockPanelErrorBoundary extends Component<
  PanelErrorBoundaryProps,
  { failedKey: string | null }
> {
  state: { failedKey: string | null } = { failedKey: null }

  static getDerivedStateFromError() {
    return { failedKey: "__failed__" }
  }

  componentDidUpdate(previous: PanelErrorBoundaryProps) {
    if (previous.resetKey !== this.props.resetKey && this.state.failedKey !== null) {
      this.setState({ failedKey: null })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Dock panel crashed", error, info)
  }

  private retry = () => this.setState({ failedKey: null })

  render() {
    return this.state.failedKey ? this.props.fallback(this.retry) : this.props.children
  }
}

export interface DockPanelSurfaceProps {
  instance: DockPanelInstance
  /** Absent when the panel no longer resolves — a disabled plugin, say. */
  panel: ResolvedDockPanel | undefined
  resource: ContextResource
  /** Stable per host mount; what plugin panels key their own state on. */
  workbenchInstanceId: string
  active: boolean
  /** Called the first time this instance is shown, so the table can record it. */
  onActivated: (instanceId: string) => void
}

export function DockPanelSurface({
  instance,
  panel,
  resource,
  workbenchInstanceId,
  active,
  onActivated,
}: DockPanelSurfaceProps) {
  const notifiedRef = useRef(false)

  useEffect(() => {
    if (!active || !panel || notifiedRef.current) return
    notifiedRef.current = true
    // `activated` distinguishes "the user is opening this for the first time"
    // from "we are rebuilding a layout they already had". Running
    // `onFirstActivate` on a restore would re-fire a panel's one-time side
    // effects (a fetch, an analytics event) on every reload.
    if (instance.activated) panel.definition.onRestore?.(resource)
    else void panel.definition.onFirstActivate?.(resource)
    onActivated(instance.instanceId)
  }, [active, panel, instance.activated, instance.instanceId, resource, onActivated])

  if (!panel) {
    return (
      <DockPanelUnavailable
        name={instance.panelId}
        reason={instance.kind === "plugin-surface" ? "plugin" : "permission"}
      />
    )
  }

  const Renderer = panel.definition.renderer
  const name = panel.definition.label ?? panel.definition.id

  return (
    <DockPanelErrorBoundary
      resetKey={`${instance.instanceId}:${panel.definition.id}`}
      fallback={(retry) => <DockPanelUnavailable name={name} reason="crashed" onRetry={retry} />}
    >
      <div className="h-full min-h-0" data-testid={`dock-panel-${instance.instanceId}`}>
        <Renderer workbenchInstanceId={workbenchInstanceId} resource={resource} active={active} />
      </div>
    </DockPanelErrorBoundary>
  )
}
