/**
 * One `LlmClient` ladder for background work that must run on a REAL install,
 * not just a BYOK one.
 *
 * Three factories already exist and each answers a different question:
 *
 *   `buildUtilityLlmClient`  — which provider/model does this cheap chore use?
 *   `buildAgentRoleLlmClient` — …after the session's configured Agent has had
 *                               its say (`Character.modelRouting[role]`).
 *   `buildHeadlessTurnLlmClient` — how do we call a model at all when the
 *                               renderer has no key?
 *
 * The last one is not an optimization. `buildRendererLlmClient` ends in
 * `if (!resolution.apiKey) return null`, and that key only ever comes from
 * something the user typed into settings. A Claude subscription — the app's
 * PRIMARY auth mode — keeps its OAuth bearer in the keyring and hands it to the
 * sidecar, never to the renderer (ADR-0025). So every feature built on the
 * direct client alone is silently dead for most installs. A background chore
 * that returns `null` there does not degrade gracefully; it simply never
 * happens, and nothing says so.
 *
 * This composes the three in the order that keeps a configured key cheap and a
 * subscription working:
 *
 *   configured Agent's utility model  →  one headless turn
 *
 * The headless leg runs through `resolveSendOptions`, so it covers every
 * provider AND every external agent (codex, opencode, gemini-cli) with no
 * per-agent adapter — that is the reuse worth having here.
 *
 * COST SHAPE, because this is the part that gets misused. The fallback is one
 * whole agent turn. That is right for work measured in "a few times an hour"
 * (project-context mining runs once per closed ~12-message window, and only
 * when the salience gate fires) and WRONG for anything on a keystroke or
 * per-turn cadence — ghost text, follow-up suggestions. Those keep their bare
 * `buildUtilityLlmClient` and their honest `null`.
 */

import type {
  AgentModelRole,
  AppSettings,
  ChatSession,
  UtilityModelConfig,
} from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { buildAgentRoleLlmClient } from "@/lib/ai/generation/agent-role-client"
import { buildHeadlessTurnLlmClient } from "@/lib/ai/headless-turn-llm-client"

export interface BuildAgentBackedClientArgs {
  /** Which of the Agent's routed models to prefer. Background chores use `"utility"`. */
  role?: AgentModelRole
  session: ChatSession | null | undefined
  appSettings: AppSettings | null | undefined
  /** Per-feature provider/model override, when the feature has its own setting. */
  override?: UtilityModelConfig
  /** Telemetry-only feature id forwarded to the provider resolver. */
  featureId: string
  /** Broker lease label — what the fallback turn shows up as in the runs console. */
  label: string
}

/**
 * Build a client, or `null` when neither leg can run (pure web with no paired
 * companion has no transport to fall back to).
 */
export async function buildAgentBackedLlmClient({
  role = "utility",
  session,
  appSettings,
  override,
  featureId,
  label,
}: BuildAgentBackedClientArgs): Promise<LlmClient | null> {
  const direct = await buildAgentRoleLlmClient({
    role,
    session: session ?? null,
    appSettings: appSettings ?? null,
    ...(override ? { override } : {}),
    featureId,
  }).catch(() => null)
  if (direct) return direct
  return buildHeadlessTurnLlmClient({ session: session ?? null, label })
}
