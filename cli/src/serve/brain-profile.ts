/**
 * Which brain this `cognia serve` process is (plan §9a).
 *
 * cognia-server starts the Host's own brain without a profile, and each
 * member's data partition on a multi-tenant Host with
 * `COGNIA_BRAIN_PROFILE=person`. Any other value refuses to start: a typo
 * must not boot a member's partition as a full Host brain.
 */
import type { HeadlessHost } from "@/lib/headless/types"

export const BRAIN_PROFILE_ENV = "COGNIA_BRAIN_PROFILE"

export type BrainProfile = { ok: true; host: HeadlessHost } | { ok: false; error: string }

export function resolveBrainProfile(env: NodeJS.ProcessEnv): BrainProfile {
  const raw = env[BRAIN_PROFILE_ENV]
  if (raw === undefined || raw === "") return { ok: true, host: "brain" }
  if (raw === "person") return { ok: true, host: "person-brain" }
  return {
    ok: false,
    error: `serve: unknown ${BRAIN_PROFILE_ENV} "${raw}" (expected "person" or unset)`,
  }
}
