/**
 * The desktop's bootstrap sessions (ADR-0235 P5/P6): install, repair, re-pair
 * and uninstall a full Cognia Host on a machine this desktop reaches over SSH.
 *
 * Every call is a Tauri command in `crates/cognia-host-installer/src/
 * commands.rs` and runs on this desktop: the SSH profile's credentials are
 * read from this machine's keyring, so there is no host-mediated path. The
 * renderer holds only the random session id; the connection and the
 * inspection stay native.
 *
 * A step names the inspection it acts on and the plan the user chose there.
 * That pair is the consent: the native side refuses a plan the inspection did
 * not offer, and an inspection that is no longer the latest
 * (`stale_inspection`). An `unknown` failure means the step may or may not
 * have run, so the caller inspects again before offering anything else.
 *
 * The pair invitation in {@link PairView} is an owner credential. It is
 * handed straight to pairing and never rendered, logged or stored.
 */

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import {
  buildForwardedConnectRequest,
  type ForwardedRequestError,
} from "@/lib/terminal/ssh-forwarding"
import type { SshConnectRequest, SshHostProfile } from "@/lib/terminal/ssh-profiles"

import type { SshHostKeyChange } from "@/lib/terminal/ssh-host-key"

/** Must match `STAGE_EVENT` in `crates/cognia-host-installer/src/commands.rs`. */
export const HOST_INSTALLER_STAGE_EVENT = "host-installer://stage"

export type PlanKind = "fresh" | "repair" | "re_pair" | "uninstall"

export type StageName =
  "probe" | "plan" | "fetch" | "upload" | "stage" | "service" | "pair" | "route"

export type StageOutcome =
  "ok" | "denied" | "unsupported" | "unreachable" | "unknown" | "timeout" | "failed"

export type InstallNotice = "linger_off" | "linger_unknown"

export interface OpenedView {
  sessionId: string
  hostKeyStatus: "learned" | "verified"
  hostKeyFingerprint: string
}

export interface ExistingView {
  installed: boolean
  running: boolean
  version: string | null
  ready: boolean | null
  masterKeyPresent: boolean
}

export interface InspectionView {
  inspectionId: string
  os: "linux" | "macos"
  arch: "x64" | "arm64"
  target: string
  /** Typing it confirms deleting the Host's data on this machine. */
  hostname: string
  user: string
  dataDir: string
  serviceManager: "systemd" | "launchd"
  linger: boolean | null
  glibc: string | null
  freeBytes: number | null
  existing: ExistingView | null
  offers: PlanKind[]
  notices: InstallNotice[]
}

export interface InstalledView {
  version: string
  dataDir: string
}

/** An owner invitation. Register it, never show or keep it. */
export interface PairView {
  invitation: string
  hasRelay: boolean
  expiresAtMs: number
}

export type UnsupportedReason =
  | { cause: "windows" }
  | { cause: "os"; name: string }
  | { cause: "arch"; name: string }
  | { cause: "no_service_manager" }
  | { cause: "glibc_too_old"; found: string; baseline: string }
  | { cause: "glibc_unknown" }
  | { cause: "no_home" }

export type ReleaseCause =
  | "no_trust_root"
  | "unreachable"
  | "no_catalog"
  | "untrusted"
  | "no_release"
  | "not_an_archive"
  | "digest_mismatch"
  | "io"

/** A step that did not succeed. `message` is English support detail. */
export type InstallerFailure =
  | { kind: "no_session" }
  | { kind: "busy" }
  | { kind: "stale_inspection" }
  | { kind: "host_key_changed"; change: SshHostKeyChange }
  | { kind: "connect"; message: string }
  | { kind: "unsupported"; reason: UnsupportedReason; message: string }
  | { kind: "not_enough_space"; free: number; needed: number }
  | { kind: "release"; cause: ReleaseCause; message: string }
  | { kind: "denied"; message: string }
  | { kind: "refused"; stage: StageName; message: string }
  | { kind: "fault"; stage: StageName; message: string }
  | { kind: "unknown"; stage: StageName; message: string }
  | { kind: "timeout"; stage: StageName }
  | { kind: "failed"; stage: StageName; message: string }
  | { kind: "relay_unavailable"; message: string }
  /** Not from the native side: the command itself could not run. */
  | { kind: "ipc"; message: string }

export interface StageEventPayload {
  sessionId: string
  operationId: string
  stage: StageName
  /** `null` when the stage starts. */
  outcome: StageOutcome | null
}

export type InstallerResult<T> = { ok: true; value: T } | { ok: false; failure: InstallerFailure }

const FAILURE_KINDS = new Set<string>([
  "no_session",
  "busy",
  "stale_inspection",
  "host_key_changed",
  "connect",
  "unsupported",
  "not_enough_space",
  "release",
  "denied",
  "refused",
  "fault",
  "unknown",
  "timeout",
  "failed",
  "relay_unavailable",
])

/** A rejection from `invoke`, as a typed failure. */
export function toInstallerFailure(error: unknown): InstallerFailure {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { kind?: unknown }).kind === "string" &&
    FAILURE_KINDS.has((error as { kind: string }).kind)
  ) {
    return error as InstallerFailure
  }
  return { kind: "ipc", message: error instanceof Error ? error.message : String(error) }
}

async function call<T>(
  command: string,
  args: Record<string, unknown>
): Promise<InstallerResult<T>> {
  try {
    return { ok: true, value: await invoke<T>(command, args) }
  } catch (error) {
    return { ok: false, failure: toInstallerFailure(error) }
  }
}

/** Rows and columns the exec connection ignores; a request must name some. */
const EXEC_ROWS = 24
const EXEC_COLS = 80

export type InstallerRequest =
  { kind: "ok"; request: SshConnectRequest } | { kind: "invalid"; reason: ForwardedRequestError }

/**
 * The SSH request for a saved profile, its jump chain resolved and its
 * forwards stripped at the source: a bootstrap never binds a port.
 */
export function installerSshRequest(
  profile: SshHostProfile,
  allProfiles: readonly SshHostProfile[]
): InstallerRequest {
  return buildForwardedConnectRequest({
    profile: { ...profile, localForwards: [], remoteForwards: [] },
    allProfiles,
    rows: EXEC_ROWS,
    cols: EXEC_COLS,
  })
}

export function openSsh(request: SshConnectRequest): Promise<InstallerResult<OpenedView>> {
  return call("host_installer_ssh_open", { request })
}

export function inspectMachine(sessionId: string): Promise<InstallerResult<InspectionView>> {
  return call("host_installer_inspect", { sessionId })
}

export function installHost(input: {
  sessionId: string
  inspectionId: string
  plan: Extract<PlanKind, "fresh" | "repair">
  channel: string
  localAccountId?: string
}): Promise<InstallerResult<InstalledView>> {
  return call("host_installer_install", {
    args: {
      sessionId: input.sessionId,
      inspectionId: input.inspectionId,
      plan: input.plan,
      choice: { channel: input.channel, localAccountId: input.localAccountId ?? null },
    },
  })
}

export function pairHost(input: {
  sessionId: string
  inspectionId: string
  plan: Exclude<PlanKind, "uninstall">
  deviceName: string
}): Promise<InstallerResult<PairView>> {
  return call("host_installer_pair", input)
}

export function uninstallHost(input: {
  sessionId: string
  inspectionId: string
  /** The machine's name, typed, to also delete the Host's data. */
  deleteDataConfirmation?: string
}): Promise<InstallerResult<null>> {
  return call("host_installer_uninstall", {
    sessionId: input.sessionId,
    inspectionId: input.inspectionId,
    deleteDataConfirmation: input.deleteDataConfirmation ?? null,
  })
}

export async function closeSession(sessionId: string): Promise<void> {
  await call<boolean>("host_installer_close", { sessionId })
}

/** Stage transitions of one session. Resolves to the unsubscribe function. */
export async function onStage(
  sessionId: string,
  handler: (event: StageEventPayload) => void
): Promise<() => void> {
  const unlisten = await listen<StageEventPayload>(HOST_INSTALLER_STAGE_EVENT, (message) => {
    if (message.payload.sessionId === sessionId) handler(message.payload)
  })
  return () => safeUnlisten(unlisten)
}
