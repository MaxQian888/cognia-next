/**
 * Long-term memory runtime glue for the Squad dispatch path (ADR-0069 x
 * ADR-0140).
 *
 * `startSquadRun`'s own header promises that "a Squad turn gets the whole
 * product pipeline: skills, memory, twin, MCP, hooks". Four of those five were
 * true, because `dispatchTeammate` reaches `resolveSendOptions`, which resolves
 * skills, MCP, hooks and (given `twinDeps`) the twin. Memory was not, because
 * `build-options` gates its injection on `memoryDeps && memoryUserMessage` and
 * no team module ever passed either. Every other surface that sends a turn
 * builds them: chat (`claude-chat-send-options.ts`), the character-team room,
 * scheduled outbound, the pet. A conversation handed to a Squad therefore
 * silently lost every memory the same conversation would have recalled on the
 * direct path.
 *
 * Built ONCE per run, like `resolveTeamTwinRuntime` beside it: resolving the
 * memory backend can construct an embedding client, and doing that per teammate
 * turn would pay for it on every dispatch in the wave.
 *
 * Never throws. A memory misconfiguration degrades the run to no recall, which
 * is what this surface did before the helper existed.
 */

import { resolveMemoryConfig } from "@/types/memory/memory"
import type { ApplyMemoryContextDeps } from "@/lib/memory/runtime/apply-memory-context"
import type { TwinRuntimeDepsForBuild } from "@/lib/claude/build-options"

/**
 * Resolve the per-run memory read-runtime.
 *
 * @param twinDeps  The run's twin deps, when it built any. `tryBuildMemoryDeps`
 *                  reuses their vector-store client rather than opening a
 *                  second one against the same backend.
 * @returns `undefined` when memory is disabled, temporary, or unreachable
 *          (headless / CLI, where Dexie may not exist).
 */
export async function resolveTeamMemoryRuntime(
  twinDeps?: TwinRuntimeDepsForBuild
): Promise<ApplyMemoryContextDeps | undefined> {
  try {
    const [settingsDb, { useSettingsStore }, { tryBuildMemoryDeps }] = await Promise.all([
      import("@/lib/db/settings"),
      import("@/stores/settings"),
      import("@/lib/memory/runtime/build-deps"),
    ])
    const appSettings =
      (await settingsDb.getSettings().catch(() => undefined)) ??
      useSettingsStore.getState().settings
    return await tryBuildMemoryDeps(resolveMemoryConfig(appSettings?.memory), twinDeps)
  } catch {
    return undefined
  }
}
