/**
 * Everything a LocalProfile's cloud identity leaves behind, and how it is
 * removed when the profile is deleted (ADR-0149 section 9).
 *
 * # What deleting a profile used to leave behind
 *
 * `deleteAccount` dropped the registry row, the Dexie database, the runtime
 * targets and the browser vault, and stopped. It did not touch the profile's
 * `userBindings` row, its Logto session in the keyring, its re-authentication
 * marker, its collaboration-server address, or the host's `host_bindings`
 * person. So a deleted profile kept a live refresh token in the OS keyring
 * under a key nothing would ever read again, and the registry kept saying the
 * dead profile belonged to somebody.
 *
 * # Order, and why nothing here throws
 *
 * The session goes first, with revocation at the issuer, because the token is
 * the one thing that is dangerous to leave. Every step after that is
 * bookkeeping. Each step is attempted whether or not the previous one worked,
 * and the outcome of each is reported rather than thrown: a keyring that
 * cannot be reached must not stop the binding from being removed, and the
 * caller has to be able to say "deleted, but the issuer may still hold a
 * session" instead of either lying or refusing.
 */

import { forgetCollabConnection } from "@/lib/collab/connection"
import {
  signOutFromLogto,
  signOutLeftTokensLive,
  type LogtoAppSessionDeps,
  type LogtoSignOutReport,
} from "@/lib/logto/app-session"

import { unbindHostPerson, type HostPersonDeps } from "./host-person"
import { UserBindingRegistry } from "./user-binding"

export const PROFILE_CLOUD_IDENTITY_STEPS = [
  /** Revoke at the issuer and clear the keyring session and marker. */
  "session",
  /** Drop the registry's profile-to-person row. */
  "binding",
  /** Forget which collaboration server this profile talked to. */
  "collab-connection",
  /** Tell the host to forget the person. Only possible for the unlocked profile. */
  "host-person",
] as const

export type ProfileCloudIdentityStep = (typeof PROFILE_CLOUD_IDENTITY_STEPS)[number]

export type ProfileCloudIdentityStepOutcome =
  | { status: "done" }
  | { status: "skipped"; reason: "no-host" | "not-bound-on-host" }
  | { status: "failed"; error: string }

export interface ProfileCloudIdentityCleanup {
  localAccountId: string
  steps: Record<ProfileCloudIdentityStep, ProfileCloudIdentityStepOutcome>
  /** Every step that failed, in order, for a caller that reports rather than inspects. */
  failures: Array<{ step: ProfileCloudIdentityStep; error: string }>
  /**
   * True when a token may still be usable somewhere: the keyring clear
   * failed, or the issuer could not be told to revoke. Local deletion still
   * proceeds, but the caller must surface this rather than report a clean
   * delete.
   */
  tokensMayRemainLive: boolean
}

export interface ForgetProfileCloudIdentityDeps {
  registry?: Pick<UserBindingRegistry, "unbind">
  signOut?: (deps: LogtoAppSessionDeps) => Promise<LogtoSignOutReport>
  forgetConnection?: (localAccountId: string) => void
  unbindHost?: (localAccountId: string, deps?: HostPersonDeps) => Promise<boolean>
  host?: HostPersonDeps
  /**
   * Whether the host currently holds this profile as its bound namespace.
   * The host command acts on the unlocked profile only, so for any other
   * profile the step is reported as skipped rather than attempted and failed.
   */
  hostBound?: boolean
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Remove every trace of the person from a profile that is about to be deleted.
 */
export async function forgetProfileCloudIdentity(
  localAccountId: string,
  deps: ForgetProfileCloudIdentityDeps = {}
): Promise<ProfileCloudIdentityCleanup> {
  const steps = {} as Record<ProfileCloudIdentityStep, ProfileCloudIdentityStepOutcome>
  const failures: ProfileCloudIdentityCleanup["failures"] = []
  const fail = (step: ProfileCloudIdentityStep, error: unknown): void => {
    const message = describe(error)
    steps[step] = { status: "failed", error: message }
    failures.push({ step, error: message })
  }

  let tokensMayRemainLive = false
  try {
    // The report itself is not kept: its end-session URL carries the ID
    // token, and a deletion result travels through store state and toasts
    // long after the keyring was cleared. Only the verdict survives.
    const signOut = await (deps.signOut ?? signOutFromLogto)({ localAccountId })
    steps.session = { status: "done" }
    tokensMayRemainLive = signOutLeftTokensLive(signOut)
  } catch (error) {
    fail("session", error)
    // The clear did not run, so whatever was stored is still stored.
    tokensMayRemainLive = true
  }

  try {
    await (deps.registry ?? new UserBindingRegistry()).unbind(localAccountId)
    steps.binding = { status: "done" }
  } catch (error) {
    fail("binding", error)
  }

  try {
    ;(deps.forgetConnection ?? forgetCollabConnection)(localAccountId)
    steps["collab-connection"] = { status: "done" }
  } catch (error) {
    fail("collab-connection", error)
  }

  if (!deps.hostBound) {
    steps["host-person"] = { status: "skipped", reason: "not-bound-on-host" }
  } else {
    try {
      const told = await (deps.unbindHost ?? unbindHostPerson)(localAccountId, deps.host)
      steps["host-person"] = told ? { status: "done" } : { status: "skipped", reason: "no-host" }
    } catch (error) {
      fail("host-person", error)
    }
  }

  return { localAccountId, steps, failures, tokensMayRemainLive }
}
