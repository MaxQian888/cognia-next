/**
 * The plugin contract's share of `lib/workspace/capability-overlay.ts`, which re-exports these.
 */
import type { WORKSPACE_CAPABILITY_KINDS } from "@/lib/workspace/capability-overlay"

export type WorkspaceCapabilityKind = (typeof WORKSPACE_CAPABILITY_KINDS)[number]

/**
 * Capability id → forced state in this workspace. An id that is absent
 * inherits the definition's global flag.
 */
export type WorkspaceCapabilityOverrides = Record<string, boolean>

export type WorkspaceCapabilityOverlay = Partial<
  Record<WorkspaceCapabilityKind, WorkspaceCapabilityOverrides>
>
