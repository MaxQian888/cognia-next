/**
 * Acceptance profiles, as Router + Fusion asks about them (ADR-0188 D15, WP-D2).
 *
 * A delegate run is accepted only on a tool report produced by a command the
 * repository declares in `.cognia/workspace.json` (`acceptanceProfiles`), or
 * the project's own override of it, and only once the user approved that
 * command at its hash. The parse lives in `lib/project-environment/workspace-config.ts`
 * and the trust and approval rules in `workspace-config-trust.ts`; this module
 * is the per-project front door the router, the orchestrator and the settings
 * UI call: it finds the project, its root and its trust decision, then asks.
 *
 * # Call sites
 *
 * Every caller reaches this module with a dynamic `import()` behind the
 * Router + Fusion gate (ADR-0188 D37); nothing on the off path imports it.
 *
 * - `lib/router-fusion/routing/run-route.ts` (WP-D4), per request:
 *   `capabilities.acceptanceProfileAvailable = (await acceptanceProfileAvailable(projectId)).available`,
 *   and `request-rules`' `acceptanceProfileExists(id)` from `approvedProfileIds`.
 * - `lib/router-fusion/runtime/orchestrator-host.ts` (WP-D4), before the
 *   delegate VERIFY step: `resolveAcceptanceProfile(projectId, profileId, { configRoot })`.
 *   `ACCEPTANCE_PROFILE_UNAPPROVED` / `_CHANGED` park the run waiting for
 *   approval; `_MISSING` fails it.
 * - The acceptance-profile settings rows (WP-D5): `listAcceptanceProfiles`,
 *   `approveAcceptanceProfile(projectId, profileId, commandHash)` with the hash
 *   that was on screen, `revokeAcceptanceProfile`, and
 *   `setProjectAcceptanceProfiles` for the project override.
 *
 * # Dormancy (Rule 7)
 *
 * Only delegate needs a profile, and delegate stays dormant until WP-D4 wires
 * this in: documented on `WIRED_RULE_ROWS` / `EDITABLE_ACTION_MODES` in the
 * package, labelled "Later release" in the action catalog, pinned by their
 * tests. Until then `run-route.ts` passes `acceptanceProfileAvailable: false`.
 *
 * # Failing closed
 *
 * Nothing here throws for a fault the router could meet on ordinary traffic.
 * A project that cannot be found, an untrusted checkout, an unreadable or
 * invalid file and an approval store that cannot be read all answer
 * "not available" with the reason, so `delegate` is excluded with
 * `ACCEPTANCE_PROFILE_MISSING` rather than run on a guess.
 */

import type { ActionExclusion } from "@cognia/router-fusion"
import {
  PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY,
  parseAcceptanceProfilesValue,
  jsonPointer,
  type AcceptanceProfileProblem,
  type AcceptanceProfileSource,
  type WorkspaceAcceptanceProfile,
  type WorkspaceAcceptanceProfiles,
} from "@/lib/project-environment/workspace-config"
import {
  approvalKeyFor,
  evaluateAcceptanceProfiles,
  recordAcceptanceProfileApproval,
  removeAcceptanceProfileApproval,
  type AcceptanceProfileApprovalRecord,
  type AcceptanceProfileState,
  type AcceptanceProfileStatus,
  type AcceptanceProfilesVerdict,
  type EvaluateAcceptanceProfilesDeps,
} from "@/lib/project-environment/workspace-config-trust"
import { isTauri } from "@/lib/tauri"
import type { Project } from "@/types"

/** The project fields this module reads. */
export type AcceptanceProfileProject = Pick<Project, "id" | "roots" | "metadata">

/**
 * Everything read or written outside this module. Injected so the tests drive
 * the real loader path with a fake file system, and lazy by default so a
 * caller that injects all of it does not drag the stores and Dexie in.
 */
export interface AcceptanceProfileHost {
  loadProject: (projectId: string) => Promise<AcceptanceProfileProject | null>
  trustEnabled: () => Promise<boolean>
  onWeb: () => boolean
  /** Overrides for the loader's file, trust and approval reads. */
  evaluate: Partial<EvaluateAcceptanceProfilesDeps>
  recordApproval: typeof recordAcceptanceProfileApproval
  removeApproval: typeof removeAcceptanceProfileApproval
  /** Persist the project's `metadata` bag (the project override lives in it). */
  saveProjectMetadata: (projectId: string, metadata: Record<string, unknown>) => Promise<void>
  now: () => number
}

export interface AcceptanceProfileOptions {
  /**
   * Where to read `.cognia/workspace.json` from. Absent: the project's primary
   * root. A run passes its execution root, so the profile matches the branch
   * the run is on; approvals are keyed on the primary root either way.
   */
  configRoot?: string | null
  host?: Partial<AcceptanceProfileHost>
}

const DEFAULT_HOST: AcceptanceProfileHost = {
  loadProject: async (projectId) => {
    if (!projectId) return null
    const { useProjectStore } = await import("@/stores/project/project-store")
    const fromStore = useProjectStore.getState().projects.find((p) => p.id === projectId)
    if (fromStore) return fromStore
    // A headless run can start before the project store hydrates.
    const { getAllProjects } = await import("@/lib/db/projects")
    const rows = await getAllProjects().catch(() => [])
    return rows.find((p) => p.id === projectId) ?? null
  },
  trustEnabled: async () => {
    try {
      const { useSettingsStore } = await import("@/stores/settings")
      return useSettingsStore.getState().settings?.workspaceTrust?.enabled !== false
    } catch {
      // Unreadable settings must never be the thing that disables the gate.
      return true
    }
  },
  onWeb: () => !isTauri(),
  evaluate: {},
  recordApproval: recordAcceptanceProfileApproval,
  removeApproval: removeAcceptanceProfileApproval,
  saveProjectMetadata: async (projectId, metadata) => {
    const { useProjectStore } = await import("@/stores/project/project-store")
    const store = useProjectStore.getState()
    if (store.projects.some((p) => p.id === projectId)) {
      store.updateProject(projectId, { metadata })
      return
    }
    const { getAllProjects, putProject } = await import("@/lib/db/projects")
    const row = (await getAllProjects()).find((p) => p.id === projectId)
    if (!row) throw new Error(`project ${projectId} not found`)
    await putProject({ ...row, metadata, updatedAt: new Date() })
  },
  now: () => Date.now(),
}

function hostOf(options?: AcceptanceProfileOptions): AcceptanceProfileHost {
  return { ...DEFAULT_HOST, ...options?.host }
}

function projectProfilesOf(project: AcceptanceProfileProject): unknown {
  return project.metadata?.[PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY]
}

// ── Listing ────────────────────────────────────────────────────────────────

export type AcceptanceProfileListing =
  | { kind: "project_not_found"; projectId: string }
  /** The loader itself failed (not a verdict): an infrastructure fault. */
  | { kind: "fault"; projectId: string; message: string }
  | (AcceptanceProfilesVerdict & { projectId: string })

async function loadListing(
  projectId: string,
  options?: AcceptanceProfileOptions
): Promise<AcceptanceProfileListing> {
  const host = hostOf(options)
  let project: AcceptanceProfileProject | null
  try {
    project = await host.loadProject(projectId)
  } catch (cause) {
    return { kind: "fault", projectId, message: messageOf(cause) }
  }
  if (!project) return { kind: "project_not_found", projectId }
  try {
    const verdict = await evaluateAcceptanceProfiles(
      {
        configRoot: options?.configRoot?.trim() || approvalKeyFor(project),
        project,
        projectId,
        projectProfiles: projectProfilesOf(project),
        trustEnabled: await host.trustEnabled(),
        onWeb: host.onWeb(),
      },
      host.evaluate
    )
    return { ...verdict, projectId }
  } catch (cause) {
    return { kind: "fault", projectId, message: messageOf(cause) }
  }
}

/**
 * Every acceptance profile of a project with its approval status, or why
 * there are none to show. What the settings rows render (WP-D5).
 */
export async function listAcceptanceProfiles(
  projectId: string,
  options?: AcceptanceProfileOptions
): Promise<AcceptanceProfileListing> {
  return loadListing(projectId, options)
}

// ── Availability (router capability) ───────────────────────────────────────

export interface AcceptanceProfileSummary {
  profileId: string
  commandHash: string
  source: AcceptanceProfileSource
  status: AcceptanceProfileStatus
  /** The previously approved hash, when `changed`. */
  approvedCommandHash?: string
}

export type AcceptanceProfileUnavailableReason =
  | "project_not_found"
  /** Neither the file nor the project declares a profile. */
  | "absent"
  /** The workspace is not trusted, so nothing was read. */
  | "restricted"
  | "invalid"
  /** Profiles exist, none approved at its current hash. */
  | "approval_pending"
  /** The loader failed: an infrastructure fault, not a verdict. */
  | "fault"

export interface AcceptanceProfileAvailability {
  /** True only when at least one profile exists AND is approved at its current hash. */
  available: boolean
  /** Every declared profile with its status. */
  profiles: AcceptanceProfileSummary[]
  /** Ids approved at their current hash: the ones a run may name. */
  approvedProfileIds: string[]
  /** Profiles awaiting the user (`unapproved` or `changed`). */
  pendingApproval: AcceptanceProfileSummary[]
  /** Why nothing is available; null when `available`. */
  reason: AcceptanceProfileUnavailableReason | null
  /** The invalid or fault message, for a diagnostic. */
  message?: string
}

function summaryOf(state: AcceptanceProfileState): AcceptanceProfileSummary {
  return {
    profileId: state.id,
    commandHash: state.commandHash,
    source: state.source,
    status: state.status,
    ...(state.approvedCommandHash ? { approvedCommandHash: state.approvedCommandHash } : {}),
  }
}

function unavailable(
  reason: AcceptanceProfileUnavailableReason,
  message?: string
): AcceptanceProfileAvailability {
  return {
    available: false,
    profiles: [],
    approvedProfileIds: [],
    pendingApproval: [],
    reason,
    ...(message ? { message } : {}),
  }
}

/**
 * Whether a delegate run in this project has an acceptance profile it may use:
 * one exists AND is approved at its current command hash. The router's
 * `capabilities.acceptanceProfileAvailable` (WP-D4).
 */
export async function acceptanceProfileAvailable(
  projectId: string,
  options?: AcceptanceProfileOptions
): Promise<AcceptanceProfileAvailability> {
  const listing = await loadListing(projectId, options)
  switch (listing.kind) {
    case "project_not_found":
    case "absent":
    case "restricted":
      return unavailable(listing.kind)
    case "invalid":
    case "fault":
      return unavailable(listing.kind, listing.message)
    case "declared": {
      const profiles = listing.profiles.map(summaryOf)
      const approvedProfileIds = profiles
        .filter((profile) => profile.status === "approved")
        .map((profile) => profile.profileId)
      const available = approvedProfileIds.length > 0
      return {
        available,
        profiles,
        approvedProfileIds,
        pendingApproval: profiles.filter((profile) => profile.status !== "approved"),
        reason: available ? null : "approval_pending",
      }
    }
  }
}

// ── Resolution (orchestrator) ──────────────────────────────────────────────

/**
 * An approved profile, everything the acceptance runner (WP-D3) needs. The
 * runner re-checks nothing here; it must be handed only this shape.
 */
export interface ApprovedAcceptanceProfile extends WorkspaceAcceptanceProfile {
  projectId: string
  profileId: string
  source: AcceptanceProfileSource
  commandHash: string
  approvedAt: number
  /** The root the profile was read from. */
  configRoot: string
}

export type AcceptanceProfileRefusalCode =
  | Extract<ActionExclusion, "ACCEPTANCE_PROFILE_MISSING">
  | "ACCEPTANCE_PROFILE_UNAPPROVED"
  | "ACCEPTANCE_PROFILE_CHANGED"

export type AcceptanceProfileMissingReason =
  | "project_not_found"
  | "absent"
  | "restricted"
  | "invalid"
  | "fault"
  /** The project has profiles, but none with this id. */
  | "not_declared"

export type AcceptanceProfileResolution =
  | { ok: true; profile: ApprovedAcceptanceProfile }
  | {
      ok: false
      code: Extract<AcceptanceProfileRefusalCode, "ACCEPTANCE_PROFILE_MISSING">
      projectId: string
      profileId: string
      reason: AcceptanceProfileMissingReason
      message: string
    }
  | {
      ok: false
      code: Exclude<AcceptanceProfileRefusalCode, "ACCEPTANCE_PROFILE_MISSING">
      projectId: string
      profileId: string
      /** The hash an approval must present (`approveAcceptanceProfile`). */
      commandHash: string
      /** The hash approved before, for `ACCEPTANCE_PROFILE_CHANGED`. */
      approvedCommandHash?: string
      /** The profile as it would run, for the approval prompt. */
      profile: WorkspaceAcceptanceProfile
      source: AcceptanceProfileSource
      message: string
    }

function missing(
  projectId: string,
  profileId: string,
  reason: AcceptanceProfileMissingReason,
  detail?: string
): AcceptanceProfileResolution {
  return {
    ok: false,
    code: "ACCEPTANCE_PROFILE_MISSING",
    projectId,
    profileId,
    reason,
    message: `acceptance profile "${profileId}" is not available (${reason})${detail ? `: ${detail}` : ""}`,
  }
}

/**
 * The approved profile a delegate run may execute, or a typed refusal:
 * `ACCEPTANCE_PROFILE_MISSING` (nothing to run), `ACCEPTANCE_PROFILE_UNAPPROVED`
 * (first sight) or `ACCEPTANCE_PROFILE_CHANGED` (approved before, command
 * changed since). Only `ok: true` may reach the runner.
 */
export async function resolveAcceptanceProfile(
  projectId: string,
  profileId: string,
  options?: AcceptanceProfileOptions
): Promise<AcceptanceProfileResolution> {
  const listing = await loadListing(projectId, options)
  switch (listing.kind) {
    case "project_not_found":
    case "absent":
    case "restricted":
      return missing(projectId, profileId, listing.kind)
    case "invalid":
    case "fault":
      return missing(projectId, profileId, listing.kind, listing.message)
    case "declared":
      break
  }
  const state = listing.profiles.find((candidate) => candidate.id === profileId)
  if (!state) return missing(projectId, profileId, "not_declared")
  if (state.status === "approved" && state.approvedAt !== undefined) {
    return {
      ok: true,
      profile: {
        ...state.profile,
        projectId,
        profileId,
        source: state.source,
        commandHash: state.commandHash,
        approvedAt: state.approvedAt,
        configRoot: options?.configRoot?.trim() || listing.approvalKey || "",
      },
    }
  }
  const changed = state.status === "changed"
  return {
    ok: false,
    code: changed ? "ACCEPTANCE_PROFILE_CHANGED" : "ACCEPTANCE_PROFILE_UNAPPROVED",
    projectId,
    profileId,
    commandHash: state.commandHash,
    ...(state.approvedCommandHash ? { approvedCommandHash: state.approvedCommandHash } : {}),
    profile: state.profile,
    source: state.source,
    message: changed
      ? `acceptance profile "${profileId}" changed since it was approved; approve the new command`
      : `acceptance profile "${profileId}" has not been approved`,
  }
}

// ── Approval (settings UI, run resume) ─────────────────────────────────────

export type AcceptanceProfileApprovalResult =
  | { ok: true; approval: AcceptanceProfileApprovalRecord }
  | {
      ok: false
      /**
       * `_MISSING`: no such profile to approve. `_CHANGED`: the hash presented
       * is not the profile's current one (the file or override changed after it
       * was shown), so nothing is approved. `_UNTRUSTED`: the workspace has no
       * trust grant to record the approval on. `_APPROVAL_FAILED`: the trust
       * store could not be written (a fault; nothing was approved).
       */
      code:
        | "ACCEPTANCE_PROFILE_MISSING"
        | "ACCEPTANCE_PROFILE_CHANGED"
        | "ACCEPTANCE_PROFILE_UNTRUSTED"
        | "ACCEPTANCE_PROFILE_APPROVAL_FAILED"
      reason?: AcceptanceProfileMissingReason
      /** The profile's current hash, for `_CHANGED`. */
      commandHash?: string
      message: string
    }

/**
 * Approve one profile for one project, bound to the hash the user was shown.
 *
 * The profile is re-read first, and the approval refused when its hash is no
 * longer `commandHash`: the file can change between the render and the click,
 * and approving a command nobody looked at is the thing this gate prevents.
 */
export async function approveAcceptanceProfile(
  projectId: string,
  profileId: string,
  commandHash: string,
  options?: AcceptanceProfileOptions
): Promise<AcceptanceProfileApprovalResult> {
  const host = hostOf(options)
  const listing = await loadListing(projectId, options)
  if (listing.kind !== "declared") {
    return {
      ok: false,
      code:
        listing.kind === "restricted"
          ? "ACCEPTANCE_PROFILE_UNTRUSTED"
          : "ACCEPTANCE_PROFILE_MISSING",
      reason: listing.kind,
      message: `acceptance profile "${profileId}" cannot be approved (${listing.kind})`,
    }
  }
  const state = listing.profiles.find((candidate) => candidate.id === profileId)
  if (!state) {
    return {
      ok: false,
      code: "ACCEPTANCE_PROFILE_MISSING",
      reason: "not_declared",
      message: `acceptance profile "${profileId}" is not declared`,
    }
  }
  if (state.commandHash !== commandHash) {
    return {
      ok: false,
      code: "ACCEPTANCE_PROFILE_CHANGED",
      commandHash: state.commandHash,
      message: `acceptance profile "${profileId}" changed since it was shown; review it again`,
    }
  }
  const approvalKey = listing.approvalKey
  let approval: AcceptanceProfileApprovalRecord | null = null
  try {
    approval = approvalKey
      ? await host.recordApproval(approvalKey, { projectId, profileId, commandHash }, host.now())
      : null
  } catch (cause) {
    return { ok: false, code: "ACCEPTANCE_PROFILE_APPROVAL_FAILED", message: messageOf(cause) }
  }
  if (!approval) {
    return {
      ok: false,
      code: "ACCEPTANCE_PROFILE_UNTRUSTED",
      message: "trust this workspace before approving its acceptance profiles",
    }
  }
  return { ok: true, approval }
}

export type AcceptanceProfileRevocation =
  | { ok: true; removed: boolean }
  | { ok: false; code: "PROJECT_NOT_FOUND" | "APPROVAL_STORE_FAILED"; message: string }

/**
 * Withdraw a project's approval of one profile. Works whatever the file says
 * now, including when the profile is gone: a revocation must not depend on
 * the thing it revokes still parsing.
 */
export async function revokeAcceptanceProfile(
  projectId: string,
  profileId: string,
  options?: AcceptanceProfileOptions
): Promise<AcceptanceProfileRevocation> {
  const host = hostOf(options)
  const project = await host.loadProject(projectId).catch(() => null)
  const approvalKey = project ? approvalKeyFor(project) : null
  if (!project || !approvalKey) {
    return { ok: false, code: "PROJECT_NOT_FOUND", message: `project ${projectId} not found` }
  }
  try {
    return { ok: true, removed: await host.removeApproval(approvalKey, { projectId, profileId }) }
  } catch (cause) {
    return { ok: false, code: "APPROVAL_STORE_FAILED", message: messageOf(cause) }
  }
}

// ── Project override ───────────────────────────────────────────────────────

export type ProjectAcceptanceProfilesUpdate =
  | { ok: true; profiles: WorkspaceAcceptanceProfiles }
  | { ok: false; code: "ACCEPTANCE_PROFILES_INVALID"; problems: AcceptanceProfileProblem[] }
  | { ok: false; code: "PROJECT_NOT_FOUND" | "PROJECT_SAVE_FAILED"; message: string }

/**
 * Replace the project's own acceptance profiles (the override), or remove
 * them with `null`. Validated with the file's strict rules before anything is
 * written; stored normalized. A profile saved here still runs only once
 * approved at its command hash.
 */
export async function setProjectAcceptanceProfiles(
  projectId: string,
  profiles: unknown,
  options?: AcceptanceProfileOptions
): Promise<ProjectAcceptanceProfilesUpdate> {
  const host = hostOf(options)
  const parsed =
    profiles === null
      ? ({ ok: true, profiles: {} } as const)
      : parseAcceptanceProfilesValue(
          profiles,
          jsonPointer("/metadata", PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY)
        )
  if (!parsed.ok) {
    return { ok: false, code: "ACCEPTANCE_PROFILES_INVALID", problems: parsed.problems }
  }
  const project = await host.loadProject(projectId).catch(() => null)
  if (!project) {
    return { ok: false, code: "PROJECT_NOT_FOUND", message: `project ${projectId} not found` }
  }
  const { [PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY]: _previous, ...others } =
    project.metadata ?? {}
  const metadata: Record<string, unknown> =
    profiles === null
      ? others
      : { ...others, [PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY]: parsed.profiles }
  try {
    await host.saveProjectMetadata(projectId, metadata)
  } catch (cause) {
    return { ok: false, code: "PROJECT_SAVE_FAILED", message: messageOf(cause) }
  }
  return { ok: true, profiles: parsed.profiles }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
