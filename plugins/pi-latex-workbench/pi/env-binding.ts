/**
 * Host-owned session binding for the vendored LaTeX workbench extension when
 * Cognia loads it into a hosted Pi session (ADR-0210 §5).
 *
 * Cognia forwards a plugin's `piPackages[].hostedSession.env` bindings as
 * `COGNIA_PIPKG_<NAME>` — the only prefix the external-agent env policy
 * admits — while the upstream extension reads `LATEXWB_*`
 * (`vendor/packages/adapter-pi/src/session.ts` `WorkbenchSession.fromEnv`).
 * This module is the pure translation between the two:
 *
 *   - `COGNIA_PIPKG_LATEXWB_<REST>` → `LATEXWB_<REST>`, verbatim.
 *   - `COGNIA_PIPKG_STATE_DIR` (plugin config `stateDir`, workspace-relative)
 *     joined onto `COGNIA_PIPKG_WORKSPACE_DIR` (the session's absolute
 *     workspace) → `LATEXWB_STATE`. The manifest env-source union has no
 *     "join" form, so the join happens here, and it refuses a state dir that
 *     is absolute or escapes the workspace.
 *
 * A target the host already set always wins (a user launching Pi by hand with
 * `LATEXWB_PROJECT=…` keeps that binding), and an empty value never binds —
 * an unset plugin `project` must leave the extension unbound (inert), not
 * bound to the empty id.
 *
 * Every value originates from the plugin manifest or the user's plugin
 * configuration; none comes from the model.
 */

import { isAbsolute, relative, resolve } from "node:path"

export const COGNIA_PIPKG_PREFIX = "COGNIA_PIPKG_"
export const WORKBENCH_ENV_PREFIX = "LATEXWB_"
/** Plugin config `stateDir`, forwarded by `hostedSession.env` as `STATE_DIR`. */
export const STATE_DIR_KEY = `${COGNIA_PIPKG_PREFIX}STATE_DIR`
/** The session workspace (`{ workspace: true }`), forwarded as `WORKSPACE_DIR`. */
export const WORKSPACE_DIR_KEY = `${COGNIA_PIPKG_PREFIX}WORKSPACE_DIR`
export const STATE_TARGET = `${WORKBENCH_ENV_PREFIX}STATE`

const FORWARDED_NAME = /^LATEXWB_[A-Z0-9_]+$/

export type WorkbenchEnv = Readonly<Record<string, string | undefined>>

export interface WorkbenchEnvSkip {
  target: string
  reason: "already-set" | "empty"
}

export interface WorkbenchEnvBinding {
  /** Variables to set (all targets were unset). */
  assignments: Record<string, string>
  /** Forwarded values that did not bind, and why. */
  skipped: WorkbenchEnvSkip[]
}

export class WorkbenchEnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkbenchEnvError"
  }
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== ""
}

/**
 * `LATEXWB_STATE` from the forwarded workspace dir + workspace-relative state
 * dir. Throws `WorkbenchEnvError` for an absolute or escaping state dir, or a
 * relative workspace dir. Pure.
 */
export function joinStateDir(workspaceDir: string, stateDir: string): string {
  if (!isAbsolute(workspaceDir)) {
    throw new WorkbenchEnvError(
      `${WORKSPACE_DIR_KEY} must be an absolute workspace path, got ${JSON.stringify(workspaceDir)}`
    )
  }
  if (isAbsolute(stateDir) || /^[A-Za-z]:/.test(stateDir)) {
    throw new WorkbenchEnvError(
      `the plugin's stateDir must be workspace-relative, got ${JSON.stringify(stateDir)}`
    )
  }
  const joined = resolve(workspaceDir, stateDir)
  const rel = relative(resolve(workspaceDir), joined)
  if (rel === "" || isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") {
    throw new WorkbenchEnvError(
      `the plugin's stateDir must name a directory inside the workspace, got ${JSON.stringify(stateDir)}`
    )
  }
  return joined
}

/** Compute the `LATEXWB_*` assignments for `env`. Pure: `env` is not modified. */
export function resolveWorkbenchEnv(env: WorkbenchEnv): WorkbenchEnvBinding {
  const assignments: Record<string, string> = {}
  const skipped: WorkbenchEnvSkip[] = []

  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith(COGNIA_PIPKG_PREFIX)) continue
    const target = key.slice(COGNIA_PIPKG_PREFIX.length)
    if (!FORWARDED_NAME.test(target)) continue
    const value = env[key]
    if (isSet(env[target])) skipped.push({ target, reason: "already-set" })
    else if (!isSet(value)) skipped.push({ target, reason: "empty" })
    else assignments[target] = value
  }

  const stateDir = env[STATE_DIR_KEY]
  if (isSet(env[STATE_TARGET])) {
    if (isSet(stateDir)) skipped.push({ target: STATE_TARGET, reason: "already-set" })
  } else if (!(STATE_TARGET in assignments)) {
    if (isSet(stateDir)) {
      const workspaceDir = env[WORKSPACE_DIR_KEY]
      if (!isSet(workspaceDir)) {
        throw new WorkbenchEnvError(
          `${STATE_DIR_KEY} is set but ${WORKSPACE_DIR_KEY} is not; cannot place the workbench state`
        )
      }
      assignments[STATE_TARGET] = joinStateDir(workspaceDir, stateDir)
    } else if (stateDir !== undefined) {
      skipped.push({ target: STATE_TARGET, reason: "empty" })
    }
  }

  return { assignments, skipped }
}

/** Apply `resolveWorkbenchEnv(env)` to `env` in place; returns the binding. */
export function applyWorkbenchEnv(env: Record<string, string | undefined>): WorkbenchEnvBinding {
  const binding = resolveWorkbenchEnv(env)
  Object.assign(env, binding.assignments)
  return binding
}
