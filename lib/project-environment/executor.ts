import {
  assertBootstrapEnvironment,
  prepareBootstrapExecution,
  BootstrapAgentValidationError,
  type BootstrapValidationCode,
} from "./bootstrap-agent"
import { isTauri, transport } from "@/lib/tauri"
import { sha256Hex } from "@/lib/data/crypto"
import { readWorkspaceFile, statWorkspaceFile } from "@/lib/files/workspace-fs"
import {
  getProjectEnvironment,
  updateProjectEnvironmentInitialization,
} from "@/lib/db/project-environments"
import type {
  ProjectEnvironment,
  ProjectEnvironmentAction,
  ProjectEnvironmentOs,
  ProjectEnvironmentPolicy,
  ProjectEnvironmentScript,
} from "@/types/project-environment"
import {
  computeSetupFingerprint,
  effectiveSetupReuse,
  latestSetupRecord,
  recordAllowsReuse,
  setupOutputsPresent,
  setupSignature,
  type SetupReuseIo,
} from "./setup-reuse"

export interface ProjectEnvironmentExecutionResult {
  success: boolean
  bypassed: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
  error?: string
  bootstrapValidationCode?: BootstrapValidationCode
  /** Setup was skipped: the last setup in this root succeeded with the same fingerprint. */
  reused?: boolean
  /** Setup was satisfied by an identical one already running in this root. */
  joined?: boolean
}

interface NativeEnvironmentResult {
  stdout: string
  stderr: string
  exit_code: number | null
  timed_out: boolean
}

export interface ExecuteProjectEnvironmentInput {
  environment: ProjectEnvironment
  executionRoot: string
  scope: "local" | "managedWorktree"
  surface: "interactive" | "scheduled"
  actionId?: string
  bypassOnFailure?: boolean
  timeoutSecs?: number
  /** Run setup even when an earlier one could be reused or joined (the manual "Run setup"). */
  force?: boolean
}

export function resolveEnvironmentScript(
  script: ProjectEnvironmentScript,
  os: ProjectEnvironmentOs
): string {
  return script.byOs?.[os]?.trim() || script.default.trim()
}

function selectAction(
  environment: ProjectEnvironment,
  actionId: string | undefined
): ProjectEnvironmentAction | undefined {
  if (!actionId) return undefined
  const action = environment.actions.find((candidate) => candidate.id === actionId)
  if (!action) throw new Error(`Unknown project environment action: ${actionId}`)
  return action
}

/** Runs setup or a reusable action without ever loading secret values in JS. */
export async function executeProjectEnvironment(
  input: ExecuteProjectEnvironmentInput
): Promise<ProjectEnvironmentExecutionResult> {
  if (!input.environment.isEnabled) {
    return { success: true, bypassed: false }
  }
  if (input.surface === "scheduled" && input.bypassOnFailure) {
    return {
      success: false,
      bypassed: false,
      error: "Scheduled project environment setup cannot be bypassed",
    }
  }

  const action = selectAction(input.environment, input.actionId)
  const script = action?.script ?? input.environment.setupScript
  if (
    !(input.environment.bootstrapAgent?.enabled && !action) &&
    !script.default.trim() &&
    !Object.values(script.byOs ?? {}).some((value) => value?.trim())
  ) {
    return { success: true, bypassed: false }
  }
  const policy =
    input.environment.policy ??
    (isTauri()
      ? { network: "on" as const, requireSandbox: false }
      : { network: "off" as const, requireSandbox: true })

  if (action) return runScript(input, script, policy, { recordInitialization: false })
  return runSetupCoalesced(input, policy)
}

/** The environment's own policy, or the host default applied when it has none. */
type HostExecutionPolicy =
  ProjectEnvironmentPolicy | { network: "on" | "off"; requireSandbox: boolean }

// ---------------------------------------------------------------------------
// Setup: one at a time per root, joined when identical, skipped when unchanged
// ---------------------------------------------------------------------------

interface SetupFlight {
  signature: string
  promise: Promise<ProjectEnvironmentExecutionResult>
}

/**
 * Setups in flight, keyed by environment, scope and root. Two setups in the
 * same root at once (a chat turn and a scheduled fire, or a prewarm and the
 * fire it prepared for) would run the same installer twice into the same
 * directory, racing each other. The second request instead waits for the
 * first and, when it asked for the same thing and that succeeded, takes its
 * result.
 */
const setupFlights = new Map<string, SetupFlight>()

function setupFlightKey(input: ExecuteProjectEnvironmentInput): string {
  return [input.environment.id, input.scope, input.executionRoot].join("\u0000")
}

async function runSetupCoalesced(
  input: ExecuteProjectEnvironmentInput,
  policy: HostExecutionPolicy
): Promise<ProjectEnvironmentExecutionResult> {
  const key = setupFlightKey(input)
  const signature = setupSignature(input.environment)
  for (let inFlight = setupFlights.get(key); inFlight; inFlight = setupFlights.get(key)) {
    const outcome = await inFlight.promise.catch(() => null)
    // Joined only when the finished setup did what this request would have
    // done and it worked. A failure is not shared: this request makes its own
    // attempt, under its own surface's bypass rules. A forced run never joins.
    if (
      !input.force &&
      !input.environment.bootstrapAgent?.enabled &&
      inFlight.signature === signature &&
      outcome?.success &&
      !outcome.bypassed
    ) {
      return { success: true, bypassed: false, exitCode: outcome.exitCode, joined: true }
    }
  }
  // No await between the empty lookup above and this set, so no other caller
  // can slip a second flight in for the same key.
  const promise = runSetupOnce(input, policy, signature)
  setupFlights.set(key, { signature, promise })
  try {
    return await promise
  } finally {
    if (setupFlights.get(key)?.promise === promise) setupFlights.delete(key)
  }
}

async function runSetupOnce(
  input: ExecuteProjectEnvironmentInput,
  policy: HostExecutionPolicy,
  signature: string
): Promise<ProjectEnvironmentExecutionResult> {
  let reuse: ReturnType<typeof effectiveSetupReuse>
  try {
    assertBootstrapEnvironment(input.environment)
    reuse = effectiveSetupReuse(input.environment)
  } catch (validationError) {
    // Invalid imported config must reach the normal recorded failure path,
    // even if it carries a matching historic fingerprint.
    return runScript(input, input.environment.setupScript, policy, {
      recordInitialization: true,
      validationError,
    })
  }
  const bootstrap = input.environment.bootstrapAgent?.enabled === true
  let bootstrapInvalidated = false
  let fingerprint: string | undefined
  if (reuse) {
    fingerprint = await computeSetupFingerprint(
      signature,
      input.executionRoot,
      reuse,
      setupReuseIo
    ).catch(() => undefined)
    if ((fingerprint || bootstrap) && !input.force) {
      // The caller's copy of the environment may predate the last setup (a
      // settings draft, a row read before a concurrent run finished), so the
      // decision reads the stored history.
      const stored =
        (await getProjectEnvironment(input.environment.id).catch(() => undefined)) ??
        input.environment
      const record = latestSetupRecord(stored, input.executionRoot, input.scope)
      const outputsPresent = await setupOutputsPresent(
        input.executionRoot,
        reuse,
        setupReuseIo
      ).catch(() => false)
      if (bootstrap) {
        bootstrapInvalidated =
          !fingerprint ||
          !outputsPresent ||
          (record?.status === "succeeded" && record.fingerprint !== fingerprint)
      }
      if (!bootstrap && fingerprint && recordAllowsReuse(record, fingerprint) && outputsPresent) {
        // Not written to the history: the history records setups that ran, and
        // a reuse on every turn would push those out of its 100-entry window.
        return { success: true, bypassed: false, exitCode: record?.exitCode, reused: true }
      }
    }
  }
  return runScript(
    bootstrapInvalidated ? { ...input, force: true } : input,
    input.environment.setupScript,
    policy,
    {
      recordInitialization: true,
      ...(fingerprint ? { fingerprint } : {}),
    }
  )
}

const setupReuseIo: SetupReuseIo = {
  readFile: (root, relPath) => readWorkspaceFile(root, relPath),
  statFile: async (root, relPath) => {
    const stat = await statWorkspaceFile(root, relPath)
    return { exists: stat.exists, size: stat.size, mtimeMs: stat.mtimeMs ?? undefined }
  },
  sha256Hex,
}

// ---------------------------------------------------------------------------
// The host call
// ---------------------------------------------------------------------------

async function runScript(
  input: ExecuteProjectEnvironmentInput,
  script: ProjectEnvironmentScript,
  policy: HostExecutionPolicy,
  options: { recordInitialization: boolean; fingerprint?: string; validationError?: unknown }
): Promise<ProjectEnvironmentExecutionResult> {
  const startedAt = Date.now()
  if (options.recordInitialization) {
    await updateProjectEnvironmentInitialization(
      input.environment.id,
      {
        status: "running",
        scope: input.scope,
        executionRoot: input.executionRoot,
        startedAt,
      },
      startedAt
    )
  }

  try {
    if (options.validationError !== undefined) throw options.validationError
    const bootstrap =
      options.recordInitialization && input.environment.bootstrapAgent?.enabled
        ? prepareBootstrapExecution(input.environment, input.force === true)
        : undefined
    const result = await transport.call<NativeEnvironmentResult>("project_environment_execute", {
      script: bootstrap?.script ?? script,
      cwd: input.executionRoot,
      variables: bootstrap?.variables ?? input.environment.variables,
      keyringReferences: input.environment.keyringReferences,
      policy,
      // The CLI must retain its configured budget plus time to reap tool groups.
      timeoutSecs: bootstrap
        ? Math.max(input.timeoutSecs ?? 0, bootstrap.timeoutSecs)
        : input.timeoutSecs,
    })
    const success = !result.timed_out && result.exit_code === 0
    const error = result.timed_out
      ? "Project environment setup timed out"
      : success
        ? undefined
        : `Project environment setup exited with code ${result.exit_code ?? "unknown"}`
    const bypassed = !success && input.surface === "interactive" && input.bypassOnFailure === true
    if (options.recordInitialization) {
      const completedAt = Date.now()
      await updateProjectEnvironmentInitialization(
        input.environment.id,
        {
          status: bypassed ? "bypassed" : success ? "succeeded" : "failed",
          scope: input.scope,
          executionRoot: input.executionRoot,
          startedAt,
          completedAt,
          exitCode: result.exit_code ?? undefined,
          error,
          // Only a real success vouches for skipping a later setup.
          ...(success && options.fingerprint ? { fingerprint: options.fingerprint } : {}),
        },
        completedAt
      )
    }
    return {
      success: success || bypassed,
      bypassed,
      exitCode: result.exit_code ?? undefined,
      stdout: result.stdout || undefined,
      stderr: result.stderr || undefined,
      error,
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause)
    const bypassed = input.surface === "interactive" && input.bypassOnFailure === true
    if (options.recordInitialization) {
      const completedAt = Date.now()
      await updateProjectEnvironmentInitialization(
        input.environment.id,
        {
          status: bypassed ? "bypassed" : "failed",
          scope: input.scope,
          executionRoot: input.executionRoot,
          startedAt,
          completedAt,
          error,
        },
        completedAt
      )
    }
    return {
      success: bypassed,
      bypassed,
      error,
      ...(cause instanceof BootstrapAgentValidationError
        ? { bootstrapValidationCode: cause.code }
        : {}),
    }
  }
}
