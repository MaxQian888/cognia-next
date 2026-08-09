import type { SpawnedTaskBrief } from "@/lib/tasks/spawn-task-core"
import { parseSpawnTaskArgs, type SpawnTaskMode } from "@/lib/tasks/spawn-task-core"
import { isTauri } from "@/lib/tauri"
import { proxyToRenderer } from "@/lib/external-bridge/orchestration-proxy-client"

export interface SpawnTaskInput {
  parentSessionId: string
  title: string
  tldr: string
  situation: string
  code_locations: string[]
  solution: string
  caveats: string[]
  mode?: SpawnTaskMode
}

export interface SpawnTaskOutput {
  ok: boolean
  taskSessionId?: string
  error?: string
  [key: string]: unknown
}

export interface SpawnTaskExternalDeps {
  gate: (payload: unknown) => boolean
  dispatch: (parentSessionId: string, brief: SpawnedTaskBrief) => Promise<unknown>
}

export async function spawnTask(input: SpawnTaskInput): Promise<SpawnTaskOutput> {
  if (isTauri()) return spawnTaskCore(input)
  return proxyToRenderer<SpawnTaskOutput>("spawn_task", { ...input })
}

export async function spawnTaskCore(
  input: SpawnTaskInput,
  deps?: SpawnTaskExternalDeps
): Promise<SpawnTaskOutput> {
  if (!input.parentSessionId?.trim()) {
    return { ok: false, error: "spawn_task requires a parentSessionId" }
  }
  const runtimeDeps =
    deps ??
    ({
      gate: (await import("@cognia/redact")).hasNoLeakingPiiDeep,
      dispatch: (await import("@/lib/tasks/spawn-task-dispatch")).dispatchSpawnTask,
    } satisfies SpawnTaskExternalDeps)
  if (!runtimeDeps.gate(input)) {
    return { ok: false, error: "spawn_task input failed the outbound PII gate" }
  }
  const brief = parseSpawnTaskArgs(input as unknown as Record<string, unknown>)
  if ("error" in brief) return { ok: false, error: brief.error }
  try {
    return (await runtimeDeps.dispatch(input.parentSessionId, brief)) as SpawnTaskOutput
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
