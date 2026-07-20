"use client"

/**
 * Live, reactive view of a Cognia Site's durable state.
 *
 * The Sites dashboard historically read its tables once into `useState` and
 * re-pulled them with a manual `refresh()`. This hook instead drives a single
 * Dexie `useLiveQuery` over the existing `lib/db/sites` list functions — Dexie
 * tracks the tables those reads touch, so every `appendOperationEvent` /
 * version / deployment write (see `lib/db/sites.ts`) re-renders the progressive
 * publish flow with no polling. The pure step derivations are exported for unit
 * testing without React or Dexie.
 */
import { useLiveQuery } from "dexie-react-hooks"

import {
  listSiteDeployments,
  listSiteEnvironmentRevisions,
  listSiteOperationEvents,
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

export type SiteStepKey = "connect" | "environment" | "build" | "preview" | "publish"
export type SiteStepState = "idle" | "running" | "done" | "failed"

/** Fixed progressive order the publish flow renders. */
export const SITE_STEP_ORDER: readonly SiteStepKey[] = [
  "connect",
  "environment",
  "build",
  "preview",
  "publish",
]

/** Which publish step a durable operation belongs to (null = advanced/lifecycle). */
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
  /** Resolved selection: the pinned id, else the first site, else null. */
  selectedId: string | null
  versions: SiteVersionRow[]
  deployments: SiteDeploymentRow[]
  environments: SiteEnvironmentRevisionRow[]
  resources: SiteResourceRow[]
  operations: SiteOperationRow[]
  events: SiteOperationEventRow[]
  /** True until the first live snapshot resolves. */
  loading: boolean
}

const EMPTY_TABLES = {
  versions: [] as SiteVersionRow[],
  deployments: [] as SiteDeploymentRow[],
  environments: [] as SiteEnvironmentRevisionRow[],
  resources: [] as SiteResourceRow[],
  operations: [] as SiteOperationRow[],
  events: [] as SiteOperationEventRow[],
}

/** Newest durable operation belonging to a given step, if any. */
function newestOperationForStep(
  operations: SiteOperationRow[],
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
export function pickRunningOperation(operations: SiteOperationRow[]): SiteOperationRow | undefined {
  return operations
    .filter((operation) => operation.status === "running" || operation.status === "queued")
    .reduce<SiteOperationRow | undefined>(
      (newest, operation) =>
        !newest || operation.updatedAt > newest.updatedAt ? operation : newest,
      undefined
    )
}

/** Message of the highest-sequence event for an operation, if any. */
export function latestEventMessage(
  events: SiteOperationEventRow[],
  operationId: string
): string | undefined {
  const forOperation = events.filter((event) => event.operationId === operationId)
  if (forOperation.length === 0) return undefined
  return forOperation.reduce((newest, event) => (event.sequence > newest.sequence ? event : newest))
    .message
}

/** The step a running operation belongs to (drives which row shows sub-status). */
export function stepOfOperation(operation: SiteOperationRow | undefined): SiteStepKey | null {
  return operation ? STEP_OF_OPERATION[operation.type] : null
}

/**
 * @param siteId the pinned selection, or null to auto-select the first site.
 */
export function useSiteLiveData(siteId: string | null): SiteLiveData {
  const snapshot = useLiveQuery(async () => {
    const sites = await listSiteProjects()
    const selectedId = siteId ?? sites[0]?.id ?? null
    if (!selectedId) return { sites, selectedId: null, ...EMPTY_TABLES }
    const [versions, deployments, environments, resources, operations] = await Promise.all([
      listSiteVersions(selectedId),
      listSiteDeployments(selectedId),
      listSiteEnvironmentRevisions(selectedId),
      listSiteResources(selectedId),
      listSiteOperations(selectedId),
    ])
    const events = (
      await Promise.all(operations.map((operation) => listSiteOperationEvents(operation.id)))
    ).flat()
    return { sites, selectedId, versions, deployments, environments, resources, operations, events }
  }, [siteId])

  return {
    sites: snapshot?.sites ?? [],
    selectedId: snapshot?.selectedId ?? null,
    versions: snapshot?.versions ?? EMPTY_TABLES.versions,
    deployments: snapshot?.deployments ?? EMPTY_TABLES.deployments,
    environments: snapshot?.environments ?? EMPTY_TABLES.environments,
    resources: snapshot?.resources ?? EMPTY_TABLES.resources,
    operations: snapshot?.operations ?? EMPTY_TABLES.operations,
    events: snapshot?.events ?? EMPTY_TABLES.events,
    loading: snapshot === undefined,
  }
}
