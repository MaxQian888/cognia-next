"use client"

/**
 * Live, reactive view of a Cognia Site's durable state.
 *
 * The Sites dashboard historically read its tables once into `useState` and
 * re-pulled them with a manual `refresh()`. This hook instead drives Dexie
 * `useLiveQuery` over the existing `lib/db/sites` list functions — Dexie tracks
 * the tables those reads touch, so every version / deployment / operation write
 * re-renders the progressive publish flow with no polling. The pure step
 * derivations are exported for unit testing without React or Dexie.
 *
 * **Two queries, not one, and no events in either.** A single query over all
 * nine tables meant that every `appendOperationEvent` — which fires on every
 * operation transition, several times per build — re-ran the whole thing,
 * including one `listSiteOperationEvents` per operation of the selected Site,
 * flattened into one array. Events are now scoped to the one operation that
 * needs them ({@link useSiteOperationEvents}); nothing else reads them, because
 * `failSiteOperation` and `markSiteOperationForReconcile` both write
 * `errorMessage` onto the operation row, so the events fallback that
 * `operationFailureText` used to carry was unreachable in production.
 *
 * The index query (every Site, plus the cross-Site rail signals) and the detail
 * query (the selected Site's own tables) are separate so that a write to one
 * Site's versions does not re-read the rail, and so that switching selection
 * does not re-read the Site list.
 */
import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"

import {
  listActiveSiteDeployments,
  listSiteDeployments,
  listSiteEnvironmentRevisions,
  listSiteOperationSignals,
  listSiteOperations,
  listSiteProjects,
  listSiteResources,
  listSiteVersions,
} from "@/lib/db/sites"
import type {
  SiteDeploymentRow,
  SiteEnvironmentRevisionRow,
  SiteOperationEventRow,
  SiteOperationRow,
  SiteOperationType,
  SiteProjectRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"

export type SiteStepKey = "connect" | "manifest" | "environment" | "build" | "preview" | "publish"
export type SiteStepState = "idle" | "running" | "done" | "failed"

/** Fixed progressive order the publish flow renders. */
export const SITE_STEP_ORDER: readonly SiteStepKey[] = [
  "connect",
  "manifest",
  "environment",
  "build",
  "preview",
  "publish",
]

/**
 * Which publish step a durable operation belongs to (null = advanced/lifecycle).
 *
 * `manifest` is absent on purpose: writing `.cognia/hosting.json` is a local
 * file edit, not a leased provider operation, so its step state comes from the
 * file itself ({@link StepDerivationInput.manifestReady}) rather than from a
 * row in `siteOperations`.
 */
const STEP_OF_OPERATION: Record<SiteOperationType, SiteStepKey | null> = {
  environment: "environment",
  provision: "build",
  build: "build",
  upload: "publish",
  deploy: "publish",
  access: null,
  domain: null,
  takedown: null,
  restore: null,
  reconcile: null,
  purge: null,
}

export interface SiteLiveData {
  sites: SiteProjectRow[]
  /**
   * Cross-Site signals for the rail. The per-Site tables below only cover the
   * selection, so without these every row but one would be a bare name.
   */
  activeDeployments: SiteDeploymentRow[]
  operationSignals: SiteOperationRow[]
  /** Resolved selection: the pinned id, else the first site, else null. */
  selectedId: string | null
  versions: SiteVersionRow[]
  deployments: SiteDeploymentRow[]
  environments: SiteEnvironmentRevisionRow[]
  resources: SiteResourceRow[]
  operations: SiteOperationRow[]
  /** True until the first live snapshot resolves. */
  loading: boolean
}

interface SiteIndexSnapshot {
  sites: SiteProjectRow[]
  activeDeployments: SiteDeploymentRow[]
  operationSignals: SiteOperationRow[]
}

interface SiteDetailSnapshot {
  versions: SiteVersionRow[]
  deployments: SiteDeploymentRow[]
  environments: SiteEnvironmentRevisionRow[]
  resources: SiteResourceRow[]
  operations: SiteOperationRow[]
}

const EMPTY_SITES: SiteProjectRow[] = []
const EMPTY_DEPLOYMENTS: SiteDeploymentRow[] = []
const EMPTY_OPERATIONS: SiteOperationRow[] = []
const EMPTY_VERSIONS: SiteVersionRow[] = []
const EMPTY_ENVIRONMENTS: SiteEnvironmentRevisionRow[] = []
const EMPTY_RESOURCES: SiteResourceRow[] = []

const EMPTY_INDEX: SiteIndexSnapshot = {
  sites: EMPTY_SITES,
  activeDeployments: EMPTY_DEPLOYMENTS,
  operationSignals: EMPTY_OPERATIONS,
}

const EMPTY_DETAIL: SiteDetailSnapshot = {
  versions: EMPTY_VERSIONS,
  deployments: EMPTY_DEPLOYMENTS,
  environments: EMPTY_ENVIRONMENTS,
  resources: EMPTY_RESOURCES,
  operations: EMPTY_OPERATIONS,
}

function newestOperationForStep(
  operations: readonly SiteOperationRow[],
  step: SiteStepKey
): SiteOperationRow | undefined {
  return operations
    .filter((operation) => STEP_OF_OPERATION[operation.type] === step)
    .reduce<SiteOperationRow | undefined>(
      (newest, operation) =>
        !newest || operation.updatedAt > newest.updatedAt ? operation : newest,
      undefined
    )
}

function operationSignals(operation: SiteOperationRow | undefined): {
  running: boolean
  failed: boolean
} {
  if (!operation) return { running: false, failed: false }
  return {
    running: operation.status === "running" || operation.status === "queued",
    failed: operation.status === "failed" || operation.status === "waiting-reconcile",
  }
}

export interface StepDerivationInput {
  /** Provider token verified this session, or a provisioned resource proves it. */
  connectDone: boolean
  /** `.cognia/hosting.json` exists and parses. Build, preview, and provision all read it. */
  manifestReady: boolean
  environments: SiteEnvironmentRevisionRow[]
  versions: SiteVersionRow[]
  deployments: SiteDeploymentRow[]
  previewActive: boolean
  operations: SiteOperationRow[]
}

/**
 * Derive each step's state. Priority: an in-flight operation (running/queued)
 * wins, then a satisfied success predicate, then a failed/stuck operation,
 * else idle — so a retry shows "running" even after an earlier failure, and a
 * success supersedes a stale failed operation.
 */
export function deriveStepStates(input: StepDerivationInput): Record<SiteStepKey, SiteStepState> {
  const done: Record<SiteStepKey, boolean> = {
    connect: input.connectDone,
    manifest: input.manifestReady,
    environment: input.environments.length > 0,
    build: input.versions.some((version) => version.status === "ready"),
    preview: input.previewActive,
    publish: input.deployments.some((deployment) => deployment.status === "active"),
  }
  const states = {} as Record<SiteStepKey, SiteStepState>
  for (const step of SITE_STEP_ORDER) {
    const { running, failed } = operationSignals(newestOperationForStep(input.operations, step))
    states[step] = running ? "running" : done[step] ? "done" : failed ? "failed" : "idle"
  }
  return states
}

/** Newest in-flight operation across all steps (for the live sub-status line). */
export function pickRunningOperation(
  operations: readonly SiteOperationRow[]
): SiteOperationRow | undefined {
  return operations
    .filter((operation) => operation.status === "running" || operation.status === "queued")
    .reduce<SiteOperationRow | undefined>(
      (newest, operation) =>
        !newest || operation.updatedAt > newest.updatedAt ? operation : newest,
      undefined
    )
}

/**
 * Message of the highest-sequence event in a list, if any.
 *
 * The list arrives already scoped to one operation (see
 * {@link useSiteOperationEvents}); this used to filter a flat array of every
 * operation's events, which is the read the split removed.
 */
export function newestEventMessage(events: readonly SiteOperationEventRow[]): string | undefined {
  if (events.length === 0) return undefined
  return events.reduce((newest, event) => (event.sequence > newest.sequence ? event : newest))
    .message
}

/** The step a running operation belongs to (drives which row shows sub-status). */
export function stepOfOperation(operation: SiteOperationRow | undefined): SiteStepKey | null {
  return operation ? STEP_OF_OPERATION[operation.type] : null
}

/**
 * Every Site, plus the cross-Site signals the rail needs to answer "is this one
 * live, busy, or broken" without selecting it. Deps are empty: this does not
 * re-read when the selection changes.
 */
function useSiteIndex(): SiteIndexSnapshot | undefined {
  return useClientLiveQuery<SiteIndexSnapshot>(
    async () => {
      const [sites, activeDeployments, operationSignals] = await Promise.all([
        listSiteProjects(),
        listActiveSiteDeployments(),
        listSiteOperationSignals(),
      ])
      return { sites, activeDeployments, operationSignals }
    },
    [],
    EMPTY_INDEX
  )
}

/** The selected Site's own tables. Re-reads only when the selection changes. */
function useSiteDetail(selectedId: string | null): SiteDetailSnapshot | undefined {
  return useClientLiveQuery<SiteDetailSnapshot>(
    async () => {
      if (!selectedId) return EMPTY_DETAIL
      const [versions, deployments, environments, resources, operations] = await Promise.all([
        listSiteVersions(selectedId),
        listSiteDeployments(selectedId),
        listSiteEnvironmentRevisions(selectedId),
        listSiteResources(selectedId),
        listSiteOperations(selectedId),
      ])
      return { versions, deployments, environments, resources, operations }
    },
    [selectedId],
    EMPTY_DETAIL
  )
}

/**
 * @param siteId the pinned selection, or null to auto-select the first site.
 */
export function useSiteLiveData(siteId: string | null): SiteLiveData {
  // `useClientLiveQuery` short-circuits on the server so the console can be
  // rendered by every shell without reaching for IndexedDB during prerender.
  const index = useSiteIndex()
  const selectedId = siteId ?? index?.sites[0]?.id ?? null
  const detail = useSiteDetail(selectedId)

  return {
    sites: index?.sites ?? EMPTY_SITES,
    selectedId,
    activeDeployments: index?.activeDeployments ?? EMPTY_DEPLOYMENTS,
    operationSignals: index?.operationSignals ?? EMPTY_OPERATIONS,
    versions: detail?.versions ?? EMPTY_VERSIONS,
    deployments: detail?.deployments ?? EMPTY_DEPLOYMENTS,
    environments: detail?.environments ?? EMPTY_ENVIRONMENTS,
    resources: detail?.resources ?? EMPTY_RESOURCES,
    operations: detail?.operations ?? EMPTY_OPERATIONS,
    // The rail and the empty state key off this; the detail query resolving
    // later must not make an already-listed Site look like it is still loading.
    loading: index === undefined,
  }
}
