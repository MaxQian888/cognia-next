import { platform } from "@tauri-apps/plugin-os"
import { isTauri, transport } from "@/lib/tauri"
import { updateProjectEnvironmentInitialization } from "@/lib/db/project-environments"
import type {
  ProjectEnvironment,
  ProjectEnvironmentAction,
  ProjectEnvironmentOs,
  ProjectEnvironmentScript,
} from "@/types/project-environment"

export interface ProjectEnvironmentExecutionResult {
  success: boolean
  bypassed: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
  error?: string
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
}

function currentOs(): ProjectEnvironmentOs {
  const value = platform()
  if (value === "windows" || value === "linux" || value === "macos") return value
  throw new Error(`Unsupported project environment OS: ${value}`)
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
  if (!isTauri()) {
    return { success: false, bypassed: false, error: "Project environments require local Tauri" }
  }
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
  const script = resolveEnvironmentScript(
    action?.script ?? input.environment.setupScript,
    currentOs()
  )
  if (!script) return { success: true, bypassed: false }

  const startedAt = Date.now()
  if (!action) {
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
    const result = await transport.call<NativeEnvironmentResult>("project_environment_execute", {
      script,
      cwd: input.executionRoot,
      variables: input.environment.variables,
      keyringReferences: input.environment.keyringReferences,
      timeoutSecs: input.timeoutSecs,
    })
    const success = !result.timed_out && result.exit_code === 0
    const error = result.timed_out
      ? "Project environment setup timed out"
      : success
        ? undefined
        : `Project environment setup exited with code ${result.exit_code ?? "unknown"}`
    const bypassed = !success && input.surface === "interactive" && input.bypassOnFailure === true
    if (!action) {
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
    if (!action) {
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
    return { success: bypassed, bypassed, error }
  }
}
