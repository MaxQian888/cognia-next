/**
 * Runtime replay driver for the Claude Agent SDK path (ADR-0118).
 *
 * This is the piece that makes "no API key" true end to end. It runs the real
 * CLI agent session — real build-options assembly, real sidecar, real SDK, real
 * tool pipeline, real permission gate, real persistence — and substitutes only
 * the model endpoint, by overlaying `SendOptions.env` with the tape server's
 * per-actor base URL.
 *
 * Two things it is careful about:
 *
 *   - The credential it injects is a placeholder that exists solely because the
 *     SDK refuses to start without one. It is not a secret, it is never read by
 *     anything, and it must never be replaced by a real key: the whole point is
 *     that a replay cannot reach a provider even if it tries.
 *   - The permission script is consumed, not assumed. A scripted decision that
 *     the run never asked for is reported by `assertConsumed` — a scenario that
 *     silently stopped exercising its permission path is exactly the regression
 *     replay exists to catch.
 */

import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import type {
  ReplayPermissionEntryV1,
  ReplayScenarioV1,
} from "@cognia/agent-config-types/model-request-surface"
import type { ResolvedConfig } from "../../config/schema"
import type { AgentSession, AgentSessionParams } from "../../agent/session-runner"
import type { PermissionResponder } from "../../agent/permission-gate"
import type { ReplayDriver, ReplayDriverContext } from "./run-replay"
import type { RunnerLooseEnds } from "@/lib/ai/replay/lease"

/**
 * Satisfies the SDK's "an API key is required" check and nothing else.
 *
 * Deliberately self-describing: if this string ever shows up in a provider log
 * or an error message, the run escaped the tape server and that is a release
 * blocker, not a curiosity.
 */
export const REPLAY_PLACEHOLDER_API_KEY = "cognia-replay-no-credential-required"

export interface RuntimeDriverOptions {
  config: ResolvedConfig
  /** Injected so the driver is exercisable without spawning a sidecar. */
  createSession?: (params: AgentSessionParams) => AgentSession
  /** Overridden only by tests that need a deterministic clock. */
  timeoutMs?: number
}

export interface ScriptedPermission extends ReplayPermissionEntryV1 {
  consumed: boolean
}

function replayProviderConfig(config: ResolvedConfig, baseUrl: string): ResolvedConfig {
  const configured = config.providers ?? {}
  const providerIds = new Set([...Object.keys(configured), config.provider])
  const providers = Object.fromEntries(
    [...providerIds].map((providerId) => {
      const current = configured[providerId] ?? {}
      const {
        apiKey: _apiKey,
        authToken: _authToken,
        baseURL: _baseURL,
        ...nonCredentialConfig
      } = current
      return [
        providerId,
        {
          ...nonCredentialConfig,
          apiKey: REPLAY_PLACEHOLDER_API_KEY,
          baseURL: baseUrl,
        },
      ]
    })
  )
  return { ...config, providers }
}

/**
 * Build a responder that follows the scenario's script and denies anything it
 * did not anticipate.
 *
 * Denying the unscripted is the safe default in both directions: an unexpected
 * tool request fails the run loudly, and a replay can never grant something the
 * recording did not.
 */
export function createScriptedResponder(
  script: readonly ReplayPermissionEntryV1[],
  actorRef?: string,
  sharedEntries?: ScriptedPermission[]
): {
  responder: PermissionResponder
  entries: ScriptedPermission[]
} {
  const entries = sharedEntries ?? script.map((entry) => ({ ...entry, consumed: false }))
  const scopedActorRef = actorRef ?? "root"

  const responder: PermissionResponder = async (request) => {
    const toolName = (request as { toolName?: string }).toolName ?? ""
    const match = entries.find(
      (entry) => !entry.consumed && entry.actorRef === scopedActorRef && entry.toolName === toolName
    )
    if (!match) {
      return {
        decision: "deny",
        reason: `replay: no scripted decision for "${toolName}"`,
      }
    }
    match.consumed = true
    if (match.decision === "deny") {
      return { decision: "deny", reason: "replay: scripted denial" }
    }
    return { decision: "allow" }
  }

  return { responder, entries }
}

/** Prompt steps belonging to the scenario's root actor, in order. */
function promptSteps(
  scenario: ReplayScenarioV1,
  rootActor: string
): Array<{ actorRef: string; text: string }> {
  const prompts: Array<{ actorRef: string; text: string }> = []
  for (const step of scenario.inputSteps) {
    if (step.kind !== "prompt") {
      throw new Error(`runtime replay does not support ${step.kind} input steps`)
    }
    if (step.actorRef !== rootActor) {
      throw new Error(`runtime replay cannot directly drive child actor ${step.actorRef}`)
    }
    prompts.push(step)
  }
  return prompts
}

export function createRuntimeDriver(options: RuntimeDriverOptions): ReplayDriver {
  return async (context: ReplayDriverContext): Promise<RunnerLooseEnds> => {
    const { fixture, server } = context
    const scenario = fixture.scenario
    const rootActor = scenario.actors.find((actor) => actor.role === "root")?.actorRef ?? "root"

    // Imported lazily — and as a dynamic import, since the CLI is ESM — so
    // `cognia eval replay` on a canonical fixture never pulls in the sidecar
    // graph at all.
    const createSession =
      options.createSession ?? (await import("../../agent/session-runner")).createAgentSession

    const rootPermissions = createScriptedResponder(scenario.permissionScript, rootActor)
    const { responder, entries } = rootPermissions
    const rootBaseUrl = server.baseUrlFor(rootActor)
    const replayConfig = replayProviderConfig(options.config, rootBaseUrl)

    const resolveReplayOptions = async (
      actorRef: string,
      ctx: Parameters<NonNullable<AgentSessionParams["resolveOptions"]>>[0]
    ) => {
      const { resolveSendOptions } = await import("@/lib/claude/build-options")
      const resolved = await resolveSendOptions(ctx)
      return {
        ...resolved,
        env: {
          ANTHROPIC_BASE_URL: server.baseUrlFor(actorRef),
          ANTHROPIC_API_KEY: REPLAY_PLACEHOLDER_API_KEY,
        },
      }
    }

    const session = createSession({
      config: replayConfig,
      resolveOptions: (ctx) => resolveReplayOptions(rootActor, ctx),
      resolveSubagentOptions: resolveReplayOptions,
      resolveSubagentGate: (actorRef) =>
        createScriptedResponder(scenario.permissionScript, actorRef, entries).responder,
    })

    const seenChildren = new Set<string>()
    const finishedChildren = new Set<string>()

    try {
      for (const step of promptSteps(scenario, rootActor)) {
        await session.send(step.text, {
          gate: responder,
          timeoutMs: options.timeoutMs,
          onEnvelope: (envelope: AgentEventEnvelope) => {
            // Child lifecycle is tracked from the canonical log rather than
            // guessed: an orphaned child is one of the loose ends the run has
            // to fail on.
            if (envelope.event.kind !== "subagent") return
            const payload = envelope.event as { agentId?: string; phase?: string }
            const id = payload.agentId ?? envelope.runId
            seenChildren.add(id)
            if (payload.phase === "completed" || payload.phase === "failed") {
              finishedChildren.add(id)
            }
          },
        })
      }
    } finally {
      await session.close()
    }

    return {
      unconsumedPermissions: entries
        .filter((entry) => !entry.consumed)
        .map((entry) => `${entry.toolName} (${entry.decision}) was scripted but never requested`),
      unfinishedChildren: [...seenChildren]
        .filter((id) => !finishedChildren.has(id))
        .map((id) => `${id} never reported completion`),
    }
  }
}
