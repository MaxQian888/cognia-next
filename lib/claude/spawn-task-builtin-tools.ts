import type { SpawnedTaskBrief } from "@/lib/tasks/spawn-task-core"
import {
  SPAWN_TASK_JSON_SCHEMA,
  SPAWN_TASK_TOOL_NAME,
  parseSpawnTaskArgs,
} from "@/lib/tasks/spawn-task-core"

export const SPAWN_TASK_BUILTIN_PLUGIN_ID = "cognia-spawn-task-builtin"

export interface SpawnTaskManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

export function buildSpawnTaskManifestEntries(): SpawnTaskManifestEntry[] {
  return [
    {
      name: SPAWN_TASK_TOOL_NAME,
      description:
        "Stage a clearly scoped follow-up task in a new named sidechat for the user to start. Use aside for self-contained work and inherit only when the new task needs this conversation's context. After this succeeds, do not perform the spawned work in the current thread.",
      jsonSchema: SPAWN_TASK_JSON_SCHEMA,
      pluginId: SPAWN_TASK_BUILTIN_PLUGIN_ID,
    },
  ]
}

export function isSpawnTaskBuiltinTool(name: string): boolean {
  return name === SPAWN_TASK_TOOL_NAME
}

export interface SpawnTaskToolRunDeps {
  gate: (payload: unknown) => boolean
  dispatch: (sessionId: string, brief: SpawnedTaskBrief) => Promise<unknown>
}

export async function runSpawnTaskBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: SpawnTaskToolRunDeps | undefined,
  context: { sessionId: string }
): Promise<unknown> {
  if (!isSpawnTaskBuiltinTool(name)) {
    return { ok: false as const, error: `unknown spawn task tool: ${name}` }
  }
  if (!deps) {
    return { ok: false as const, error: "spawn_task host dependencies are unavailable" }
  }
  if (!deps.gate(args)) {
    return { ok: false as const, error: "Spawned task blocked by the PII redaction gate" }
  }
  const brief = parseSpawnTaskArgs(args)
  if ("error" in brief) return { ok: false as const, error: brief.error }
  return deps.dispatch(context.sessionId, brief)
}
