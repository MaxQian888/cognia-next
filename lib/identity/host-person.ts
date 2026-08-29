/**
 * Telling the host which person a profile belongs to (ADR-0149 §9).
 *
 * The renderer owns the binding — the registry row in
 * `lib/identity/user-binding.ts` is the one a caller reads. This module only
 * mirrors it into `host_bindings`, so the companion API can answer "whose
 * machine is this" for a request that never touches the renderer.
 *
 * Off the desktop there is no host to tell, and that is a supported state
 * rather than a degraded one: the browser and Capacitor shells have no
 * SecurityStore at all. Every function here is a no-op there, which keeps
 * sign-in a single code path instead of two.
 */

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/platform/detect"

export const ACCOUNT_BIND_PERSON_COMMAND = "account_bind_person"
export const ACCOUNT_UNBIND_PERSON_COMMAND = "account_unbind_person"
export const ACCOUNT_PERSON_COMMAND = "account_person"

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export interface HostPerson {
  localAccountNamespace: string
  userId: string | null
  orgId: string | null
}

export interface HostPersonDeps {
  invokeFn?: InvokeFn
  isDesktop?: () => boolean
}

function resolve(deps: HostPersonDeps) {
  return {
    call: deps.invokeFn ?? (invoke as InvokeFn),
    desktop: (deps.isDesktop ?? isTauri)(),
  }
}

/**
 * Record the person on the host. Returns whether anything was written, so a
 * caller can tell "no host here" from "the host accepted it" without having to
 * ask what shell it is running in.
 */
export async function bindHostPerson(
  input: {
    localAccountId: string
    userId: string
    orgId?: string
    accessToken: string
  },
  deps: HostPersonDeps = {}
): Promise<boolean> {
  const { call, desktop } = resolve(deps)
  if (!desktop) return false
  // No `issuer`/`audience`: the host validates the token against its OWN
  // configured Logto issuer. A renderer that supplies the trust anchor is
  // verifying the token against itself.
  await call<void>(ACCOUNT_BIND_PERSON_COMMAND, {
    accessToken: input.accessToken,
    userId: input.userId,
    orgId: input.orgId ?? null,
  })
  return true
}

export async function unbindHostPerson(
  localAccountId: string,
  deps: HostPersonDeps = {}
): Promise<boolean> {
  const { call, desktop } = resolve(deps)
  if (!desktop) return false
  void localAccountId
  await call<void>(ACCOUNT_UNBIND_PERSON_COMMAND)
  return true
}

/**
 * Read what the host recorded, so a caller can detect a disagreement with the
 * renderer's own binding. `null` means "nothing recorded here" — no host, or a
 * profile the host has never seen unlocked — never "the call failed".
 */
export async function readHostPerson(
  localAccountId: string,
  deps: HostPersonDeps = {}
): Promise<HostPerson | null> {
  const { call, desktop } = resolve(deps)
  if (!desktop) return null
  void localAccountId
  const result = await call<HostPerson | null>(ACCOUNT_PERSON_COMMAND)
  return result ?? null
}
