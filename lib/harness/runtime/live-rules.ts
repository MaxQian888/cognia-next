/**
 * An adopted harness's tool rules, applied in the agent's own conversations
 * (ADR-0237).
 *
 * Probes apply a candidate's rules themselves (`./probe-runner.ts`). Once a
 * harness is adopted, its rules must hold wherever the agent works, or an
 * adoption would change the prompt and not the behaviour that was measured.
 * They go through the one extension seam every surface already shares: the
 * `tool.result.project` interceptor point (ADR-0189), which the interactive
 * chat, headless captures and scheduled runs all dispatch on a tool result.
 *
 * - The handler looks up the conversation's agent, reads its effective harness
 *   (variants resolved) and projects the result with the same pure function
 *   probes use (`../tool-rules.ts`), on top of any earlier interceptor's
 *   rewrite. Call caps count per turn, keyed by the turn id the call site
 *   passes.
 * - Registered only while some agent has adopted rules: a registration makes
 *   every turn pay the tool-result review round-trip, which nobody should pay
 *   for nothing.
 * - Probe sessions are excluded: a probe applies the candidate's rules, not
 *   the stored agent's, and applying both would double them.
 *
 * Rules can only shorten, annotate or withhold a result (see `../tool-rules.ts`),
 * so this hook can never widen what a run may do.
 */

import type { HarnessToolRule } from "@cognia/agent-config-types"
import type { InterceptorRegistration } from "@/lib/plugin/interceptors/types"
import type { ToolResultProjectValue } from "@/lib/plugin/interceptors/normalize"
import { createToolRuleState, projectToolResult, type ToolRuleState } from "../tool-rules"

export const LIVE_RULES_PLUGIN_ID = "cognia.harness-evolution"
export const LIVE_RULES_REGISTRATION_ID = `${LIVE_RULES_PLUGIN_ID}:tool-rules`
/** A call site that names no turn gets a fresh count after this much quiet. */
export const UNKEYED_TURN_IDLE_MS = 10 * 60_000

const excluded = new Set<string>()

/** Keep a conversation out of the live rules (a probe applies its own). Returns the undo. */
export function excludeSessionFromLiveToolRules(sessionId: string): () => void {
  excluded.add(sessionId)
  return () => {
    excluded.delete(sessionId)
  }
}

export function isSessionExcludedFromLiveToolRules(sessionId: string): boolean {
  return excluded.has(sessionId)
}

export interface LiveRulesDeps {
  characterIdOfSession(sessionId: string): Promise<string | undefined>
  rulesOfCharacter(characterId: string): Promise<readonly HarnessToolRule[]>
  now(): number
}

interface TurnState {
  turnId?: string
  lastAt: number
  state: ToolRuleState
}

/** The interceptor's transform. Exported for tests. */
export function createLiveToolRulesHandler(deps: LiveRulesDeps) {
  const turns = new Map<string, TurnState>()
  const stateFor = (sessionId: string, turnId: string | undefined): ToolRuleState => {
    const now = deps.now()
    const current = turns.get(sessionId)
    const fresh =
      !current || (turnId ? current.turnId !== turnId : now - current.lastAt > UNKEYED_TURN_IDLE_MS)
    const next: TurnState = fresh
      ? { ...(turnId ? { turnId } : {}), lastAt: now, state: createToolRuleState() }
      : { ...current, lastAt: now }
    turns.set(sessionId, next)
    return next.state
  }
  return async (value: ToolResultProjectValue): Promise<ToolResultProjectValue> => {
    if (excluded.has(value.sessionId)) return value
    const characterId = await deps.characterIdOfSession(value.sessionId)
    if (!characterId) return value
    const rules = await deps.rulesOfCharacter(characterId)
    if (rules.length === 0) return value
    const current = value.projection.modifiedResult ?? value.toolResult
    const projection = projectToolResult(
      rules,
      stateFor(value.sessionId, value.turnId),
      value.toolName,
      current,
      value.isError
    )
    if (!projection.changed) return value
    return { ...value, projection: { ...value.projection, modifiedResult: projection.output } }
  }
}

export interface LiveRulesRegistry {
  register(registration: InterceptorRegistration): () => void
}

/**
 * Keep the registration in step with whether any agent has adopted rules.
 * Returns the function to call with each new answer, and a disposer.
 */
export function createLiveToolRulesSwitch(
  deps: LiveRulesDeps,
  registry: LiveRulesRegistry
): { update(anyAgentHasRules: boolean): void; dispose(): void } {
  const handler = createLiveToolRulesHandler(deps)
  let unregister: (() => void) | undefined
  return {
    update(anyAgentHasRules) {
      if (anyAgentHasRules && !unregister) {
        unregister = registry.register({
          registrationId: LIVE_RULES_REGISTRATION_ID,
          pluginId: LIVE_RULES_PLUGIN_ID,
          pluginInstanceId: `${LIVE_RULES_PLUGIN_ID}#host`,
          generation: 0,
          realmId: "global",
          pointId: "tool.result.project",
          semantic: "transform",
          trustTier: "builtin",
          order: {},
          timeoutMs: 2_000,
          handler: handler as never,
          source: "interceptors",
          runtime: "frontend",
        })
      } else if (!anyAgentHasRules && unregister) {
        unregister()
        unregister = undefined
      }
    },
    dispose() {
      unregister?.()
      unregister = undefined
    },
  }
}

/**
 * Production wiring: watch the agents table, register while any agent's own
 * row carries tool rules (a variant inherits its base's, so a base without
 * rules means no variant has them either), and resolve rules through the
 * variant chain at call time. Returns the disposer.
 */
export async function installLiveToolRules(): Promise<() => void> {
  const [{ default: Dexie }, schema, characters, sessions, interceptors] = await Promise.all([
    import("dexie"),
    import("@/lib/db/schema"),
    import("@/lib/db/characters"),
    import("@/lib/db/sessions"),
    import("@/lib/plugin/interceptors/registry"),
  ])
  const rulesCache = new Map<string, Promise<readonly HarnessToolRule[]>>()
  const live = createLiveToolRulesSwitch(
    {
      characterIdOfSession: async (sessionId) =>
        (await sessions.getSession(sessionId))?.characterId,
      rulesOfCharacter: (characterId) => {
        let cached = rulesCache.get(characterId)
        if (!cached) {
          cached = characters
            .resolveCharacterById(characterId)
            .then((c) => c?.harness?.toolRules ?? [])
            .catch(() => [])
          rulesCache.set(characterId, cached)
        }
        return cached
      },
      now: Date.now,
    },
    { register: interceptors.registerInterceptor }
  )
  // Every row's edit stamp, so any agent edit (a variant re-pointed at another
  // base included) re-emits and drops the cached rule sets.
  const subscription = Dexie.liveQuery(async () =>
    (await schema.getDb().characters.toArray()).map((c) => ({
      id: c.id,
      updatedAt: c.updatedAt,
      hasRules: (c.harness?.toolRules?.length ?? 0) > 0,
    }))
  ).subscribe({
    next: (rows) => {
      rulesCache.clear()
      live.update(rows.some((r) => r.hasRules))
    },
    error: (error) => console.warn("Harness live tool rules: watch failed", error),
  })
  return () => {
    subscription.unsubscribe()
    live.dispose()
  }
}
