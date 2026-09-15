/**
 * The image catalog as the brain sees it (ADR-0182).
 *
 * The Rust `EffectiveCatalog` (baseline merged with the tenant layer, see
 * `crates/cognia-environment/src/catalog.rs`) projected into what resolution
 * and the settings UI need. The server is the authority: this view is only
 * ever read, and admission re-checks every spec resolved against it.
 */

import type { IsolationTier, SpecBundle } from "./environment-spec"

export type CatalogScope = "baseline" | "tenant"

/** `manual`: typed in by an admin. `build`: produced by ADR-0186. `legacy`: derived from `COGNIA_RUNNER_IMAGE`. */
export type CatalogEntrySource = "manual" | "build" | "legacy"

export interface CatalogImageView {
  registry: string
  repository: string
  /** Absent only on a tag-only legacy entry, which is listed but never admitted. */
  digest?: string
  tag?: string
}

export interface EnvironmentCatalogEntryView {
  id: string
  scope: CatalogScope
  label: string
  description?: string
  image: CatalogImageView
  /** The strictest of the entry's, the tenant's and the baseline's floors. */
  effectiveFloor: IsolationTier
  /** The first is the default. */
  sizeClassIds: string[]
  /** The image config's `User`; absent means root. */
  imageUser?: string
  source: CatalogEntrySource
}

export interface SizeClassView {
  id: string
  label: string
  cpuMillis: number
  memoryMib: number
  ephemeralStorageMib: number
  volumeMib: number
  /**
   * Reserved and dormant (ADR-0182): a class that sets it is listed so the
   * model does not change when GPU sandboxes land, shown as unavailable, and
   * refused by admission with `gpu_not_supported`.
   */
  gpu?: { count: number; resourceName: string }
}

export interface EgressPresetView {
  id: string
  label: string
  domains: string[]
}

/** A tenant entry the merge refused because it would widen the baseline. */
export interface RejectedCatalogEntryView {
  id: string
  code: string
  message: string
}

export interface EnvironmentCatalogView {
  /** The deployment-level switch. Off: every project runs on the existing path. */
  poolEnabled: boolean
  /** A Host several tenants' work shares: isolation is mandatory there. */
  multiTenant: boolean
  /** The strictest of the baseline's and tenant's floors. */
  floor: IsolationTier
  defaultEntryId?: string
  entries: EnvironmentCatalogEntryView[]
  rejected: RejectedCatalogEntryView[]
  sizeClasses: SizeClassView[]
  egressPresets: EgressPresetView[]
  /** Absent: no agent bundle configured, nothing can be admitted. */
  bundle?: { current: Omit<SpecBundle, "pinned">; retained: Array<Omit<SpecBundle, "pinned">> }
}
