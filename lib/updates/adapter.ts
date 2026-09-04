/**
 * The contract every update source implements.
 *
 * An adapter answers two questions and nothing else: what could this asset
 * move to, and what happens when the user acts on it. Scheduling, dedupe,
 * backoff, persistence and consent all live in the coordinator, so adding a
 * ninth asset kind never means re-implementing any of that.
 */

import type {
  UpdateAction,
  UpdateAssetKind,
  UpdateCandidate,
  UpdateChannel,
  UpdateExecutor,
  UpdateFailure,
  UpdateState,
} from "@cognia/agent-config-types"

import type { CatalogEntry } from "./catalog-types"

export interface UpdateCheckContext {
  channel: UpdateChannel
  /** Stable device cohort, already normalized. */
  rolloutBucket: number
  /** True when the user pressed Check, which bypasses the percentage gate only. */
  manual: boolean
  /**
   * Verified catalog entries, or null when the control plane was unreachable
   * or failed verification. Adapters that can still answer from a local or
   * registry source may do so. Adapters that cannot must return [].
   */
  catalog: readonly CatalogEntry[] | null
  signal?: AbortSignal
}

export interface UpdateApplyContext {
  /** The user has seen and accepted whatever this candidate changes. */
  consented: boolean
  /** Report download progress in bytes. */
  onProgress?: (downloaded: number, total?: number) => void
  signal?: AbortSignal
}

export interface UpdateApplyResult {
  state: UpdateState
  failure?: UpdateFailure
  /** Where the user was sent, for the store and package-manager executors. */
  externalUrl?: string
  /** Exact command the user should run, for the package-manager executor. */
  command?: string
}

export interface UpdateAdapter {
  readonly kind: UpdateAssetKind
  readonly executor: UpdateExecutor
  /**
   * Whether this asset kind exists on the current host at all. A false answer
   * removes the group from the Update Center rather than showing a permanently
   * empty row, which is the difference between "not applicable here" and
   * "broken".
   */
  isSupported(): boolean
  /** Discover candidates. An empty array means everything is current. */
  check(context: UpdateCheckContext): Promise<UpdateCandidate[]>
  /**
   * Act on a candidate. Adapters whose executor is not in-app still implement
   * this: they open the store, or hand back the package-manager command, and
   * report `awaiting-store` / `awaiting-reload` rather than pretending to
   * install.
   */
  apply(candidate: UpdateCandidate, context: UpdateApplyContext): Promise<UpdateApplyResult>
}

/** Per-asset row the Update Center renders. */
export interface UpdateItem {
  key: string
  assetId: string
  kind: UpdateAssetKind
  executor: UpdateExecutor
  /** Localized display name resolved by the UI from `nameKey` or `displayName`. */
  displayName?: string
  nameKey?: string
  state: UpdateState
  candidate: UpdateCandidate | null
  currentVersion: string | null
  action: UpdateAction | null
  /** True when this row's install is performed by something other than Cognia. */
  externallyInstalled: boolean
  progress?: { downloaded: number; total?: number }
  failure?: UpdateFailure
  lastCheckedAt?: number
  skippedVersion?: string
  deferredUntil?: number
  command?: string
  externalUrl?: string
}
