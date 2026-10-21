/**
 * The plugin contract's share of `lib/github/workspace-backend-registry.ts`, which re-exports these.
 */

import type { E2BBackend } from "./workspace"

export interface WorkspaceBackendRegistration {
  /** Already-prefixed backend id (`<pluginId>:<id>`; unprefixed only in tests/host code). */
  backendId: string
  /** Owning plugin id; "host" for host-owned registrations. */
  pluginId: string
  /** Human label shown in the picker UI. */
  label: string
  /** Optional description rendered alongside the label. */
  description?: string
  /** The actual backend instance. */
  backend: E2BBackend
}

export type WorkspaceBackendRegistryEvent =
  | { type: "register"; backendId: string; pluginId: string }
  | { type: "unregister"; backendId: string; pluginId: string }
