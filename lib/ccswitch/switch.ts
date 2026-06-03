// Provider-switch orchestrator. Three pure-ish entry points:
//
//   planSwitch(provider, scope)
//     Build a SwitchPlan describing every change a switch will make.
//     No I/O — used to render the preview dialog.
//
//   applySwitch(plan)
//     Execute the plan. Order:
//       1. Persist apiKey/apiBaseUrl/activeProviderId to AppSettings (Dexie).
//       2. Push the new env to the sidecar via setProviderEnv() and restart.
//       3. For each supported agent, write the env block via the per-agent
//          IPC and collect any errors.
//     Returns per-agent success/failure rather than throwing on the first
//     error so the user sees a coherent post-state and can retry the failed
//     parts.
//
//   detectActive()
//     Probe cognia-next + every writable agent we know how to read, return
//     which CCSwitch provider id (if any) is currently active in each.
//     Powers the "active" badges and the drift banner.
//
// CCSwitch's `~/.claude/settings.json` write-target is the same file CCSwitch
// itself writes to. The "two writers" risk is acknowledged in the plan
// invariants — `detectActive()` running on focus is what closes the loop.

import { hasApiKey, restartSidecar, setProviderEnv } from "@/lib/claude/ipc"
import { saveSettings, getSettings } from "@/lib/db/settings"
import { isTauri } from "@/lib/tauri"

import {
  writeClaudeSettingsEnv,
  writeCodexAuthEnv,
  writeGeminiSettingsEnv,
  writeOpencodeAuthEnv,
} from "./client"
import type {
  AgentEnvPatch,
  ActiveProviderState,
  CcswitchAgentId,
  CcswitchProvider,
  SwitchPlan,
  SwitchScope,
} from "@/types/ccswitch"

/** Stable id used to mark cognia-next's active CCSwitch provider. */
export function ccswitchProviderRefId(provider: CcswitchProvider): string {
  return `ccswitch:${provider.id}`
}

/**
 * Agents we currently know how to write a provider env into.
 *
 * v1: `claude-code` (the dominant target).
 * v2: `codex` — writes `OPENAI_API_KEY` + `auth_mode = "ApiKey"`
 * to `~/.codex/auth.json`. `baseUrl` propagation is **not** implemented for
 * codex because codex-cli reads base URLs from the `[model_providers.*]`
 * tables in `config.toml`, which requires picking / creating a stable
 * `model_provider` id and rewriting profile refs — out of scope. The dialog
 * surfaces a warning when a selected codex provider has a baseUrl set.
 *
 * v3 (this update): `gemini` + `opencode`.
 *   - `gemini` → writes `GEMINI_API_KEY` + `GOOGLE_GEMINI_BASE_URL` into the
 *     `env` block of `~/.gemini/settings.json` (both keys verified against
 *     google-gemini/gemini-cli docs).
 *   - `opencode` → writes `{ type: "api", key }` for the matching provider
 *     entry in `~/.local/share/opencode/auth.json` (the file we already read
 *     in discovery). opencode reads base URLs from its own `opencode.json`
 *     provider config, not auth.json, so baseUrl is not propagated here.
 *
 * `claude-desktop` and `openclaw` remain `unsupported: true` — we could not
 * verify a stable, documented config path + env shape to write safely, and
 * we never write to a guessed path.
 */
const SUPPORTED_AGENTS: ReadonlySet<CcswitchAgentId> = new Set<CcswitchAgentId>([
  "claude-code",
  "codex",
  "gemini",
  "opencode",
])

/**
 * Map a ccswitch provider's `kind` to the OpenCode auth.json provider id we
 * write the key under. OpenCode keys entries by provider id (anthropic /
 * openai / …); ccswitch's `kind` is the closest signal we have. Anything we
 * don't recognise defaults to `anthropic` (the dominant relay case).
 */
function opencodeProviderFor(provider: CcswitchProvider): string {
  switch ((provider.kind ?? "").toLowerCase()) {
    case "codex":
    case "openai":
      return "openai"
    case "gemini":
    case "google":
      return "google"
    case "claude":
    case "anthropic":
    default:
      return "anthropic"
  }
}

function envUpdatesForProvider(
  agent: CcswitchAgentId,
  provider: CcswitchProvider
): Array<{ key: string; value: string | null }> {
  switch (agent) {
    case "codex":
      // codex-cli persists its OpenAI API key under the top-level
      // `OPENAI_API_KEY` field in `~/.codex/auth.json` (alongside the
      // ChatGPT bearer in `tokens`). We treat the field like an env-update:
      // Some(v) sets it + flips auth_mode to "ApiKey"; null removes it.
      return [{ key: "OPENAI_API_KEY", value: provider.apiKey?.trim() || null }]
    case "gemini":
      // gemini-cli reads GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL; we write
      // both into the `env` block of ~/.gemini/settings.json.
      return [
        { key: "GEMINI_API_KEY", value: provider.apiKey?.trim() || null },
        { key: "GOOGLE_GEMINI_BASE_URL", value: provider.baseUrl?.trim() || null },
      ]
    case "opencode":
      // OpenCode auth.json keys entries by provider id. We carry the api key
      // under OPENCODE_API_KEY plus an out-of-band `__provider` field (consumed
      // by the Rust writer, never persisted) selecting the entry to patch.
      // opencode reads base URLs from its own opencode.json, not auth.json, so
      // baseUrl is not propagated here.
      return [
        { key: "OPENCODE_API_KEY", value: provider.apiKey?.trim() || null },
        { key: "__provider", value: opencodeProviderFor(provider) },
      ]
    case "claude-code":
    default:
      return [
        { key: "ANTHROPIC_API_KEY", value: provider.apiKey?.trim() || null },
        { key: "ANTHROPIC_BASE_URL", value: provider.baseUrl?.trim() || null },
      ]
  }
}

function targetPathFor(agent: CcswitchAgentId): string | null {
  switch (agent) {
    case "claude-code":
      // ~/.claude/settings.json — the env block file, NOT ~/.claude.json
      // (which is the MCP config). The Rust side computes the actual path.
      return "~/.claude/settings.json"
    case "codex":
      // ~/.codex/auth.json — owned by codex-cli. Our write touches only the
      // top-level `OPENAI_API_KEY` + `auth_mode` fields; tokens/agent_identity
      // are preserved verbatim. Rust side enforces atomic write + mtime
      // drift detection via fs_atomic.
      return "~/.codex/auth.json"
    case "gemini":
      // ~/.gemini/settings.json — owned by gemini-cli. We patch only the
      // `env` block; all other keys are preserved verbatim.
      return "~/.gemini/settings.json"
    case "opencode":
      // ~/.local/share/opencode/auth.json (Windows: %LOCALAPPDATA%\opencode\).
      // The Rust side computes the actual OS-specific path; this is the Unix
      // display path shown in the dialog.
      return "~/.local/share/opencode/auth.json"
    default:
      return null
  }
}

function unsupportedReason(agent: CcswitchAgentId): string {
  // The frontend i18n layer will replace this with a translated string;
  // returning the agent id keeps tests readable and gives the i18n hook
  // a stable lookup key.
  return `agent.${agent}.providerEnv.unsupported`
}

/**
 * Build a preview of the switch. Pure — no I/O. The caller is responsible
 * for fetching the current `AppSettings` and passing the relevant fields in
 * via `current`. (Keeping this dependency-free makes it trivial to unit-test
 * and to render dialogs without flickering through async boundaries.)
 */
export function planSwitch(
  provider: CcswitchProvider,
  scope: SwitchScope,
  current: { apiKey?: string; apiBaseUrl?: string; activeProviderId?: string }
): SwitchPlan {
  const nextActiveId = ccswitchProviderRefId(provider)
  const nextApiKey = provider.apiKey?.trim() || undefined
  const nextBaseUrl = provider.baseUrl?.trim() || undefined

  const restart = nextApiKey !== current.apiKey || nextBaseUrl !== current.apiBaseUrl

  const agentChanges: AgentEnvPatch[] = scope.agents.map((agentId) => {
    if (!SUPPORTED_AGENTS.has(agentId)) {
      return {
        agentId,
        targetPath: null,
        unsupported: true,
        unsupportedReason: unsupportedReason(agentId),
        envUpdates: [],
      }
    }
    return {
      agentId,
      targetPath: targetPathFor(agentId),
      unsupported: false,
      envUpdates: envUpdatesForProvider(agentId, provider),
    }
  })

  return {
    provider,
    scope,
    cogniaChanges: {
      apiKeyBefore: current.apiKey,
      apiKeyAfter: nextApiKey,
      baseUrlBefore: current.apiBaseUrl,
      baseUrlAfter: nextBaseUrl,
      activeProviderIdBefore: current.activeProviderId,
      activeProviderIdAfter: nextActiveId,
      restartSidecar: restart,
    },
    agentChanges,
  }
}

export interface ApplyResult {
  /** True iff cognia-next side committed (Dexie + sidecar). */
  cogniaApplied: boolean
  /** Per-agent outcomes. Failures don't abort; the user sees a partial result. */
  agentResults: Array<{
    agentId: CcswitchAgentId
    ok: boolean
    /** Path written, when ok. */
    path?: string
    /** Backup path that was created, when ok. */
    backupPath?: string
    /** Error message when not ok or skipped. */
    error?: string
  }>
}

/**
 * Apply a plan. Order is deliberate: cognia-next first (cheap, reversible
 * — just a Dexie write + sidecar respawn), then per-agent writes (each
 * atomic but file-system-touching).
 */
export async function applySwitch(plan: SwitchPlan): Promise<ApplyResult> {
  const result: ApplyResult = {
    cogniaApplied: false,
    agentResults: [],
  }

  // Cognia-next: persist + push to sidecar.
  await saveSettings({
    apiKey: plan.cogniaChanges.apiKeyAfter,
    apiBaseUrl: plan.cogniaChanges.baseUrlAfter,
    activeProviderId: plan.cogniaChanges.activeProviderIdAfter,
  })
  if (isTauri()) {
    await setProviderEnv(
      plan.cogniaChanges.apiKeyAfter ?? null,
      plan.cogniaChanges.baseUrlAfter ?? null
    )
    if (plan.cogniaChanges.restartSidecar) {
      await restartSidecar()
    }
  }
  result.cogniaApplied = true

  // Per-agent: write the env patch via the appropriate IPC.
  for (const patch of plan.agentChanges) {
    if (patch.unsupported) {
      result.agentResults.push({
        agentId: patch.agentId,
        ok: false,
        error: patch.unsupportedReason,
      })
      continue
    }
    try {
      const updates: Record<string, string | null> = {}
      for (const u of patch.envUpdates) updates[u.key] = u.value
      switch (patch.agentId) {
        case "claude-code": {
          const out = await writeClaudeSettingsEnv(updates)
          result.agentResults.push({
            agentId: patch.agentId,
            ok: true,
            path: out.path,
            backupPath: out.backupPath,
          })
          break
        }
        case "codex": {
          // codex-cli's `~/.codex/auth.json` doesn't use an `env` block —
          // updates apply at the top level. The Rust command handles the
          // `auth_mode` flip when `OPENAI_API_KEY` is set/cleared.
          const out = await writeCodexAuthEnv(updates)
          result.agentResults.push({
            agentId: patch.agentId,
            ok: true,
            path: out.path,
            backupPath: out.backupPath,
          })
          break
        }
        case "gemini": {
          // gemini-cli's `~/.gemini/settings.json` — the Rust command writes
          // the keys into the nested `env` block.
          const out = await writeGeminiSettingsEnv(updates)
          result.agentResults.push({
            agentId: patch.agentId,
            ok: true,
            path: out.path,
            backupPath: out.backupPath,
          })
          break
        }
        case "opencode": {
          // opencode's `auth.json` — the Rust command writes a
          // `{ type: "api", key }` entry for the `__provider` carried in the
          // updates map.
          const out = await writeOpencodeAuthEnv(updates)
          result.agentResults.push({
            agentId: patch.agentId,
            ok: true,
            path: out.path,
            backupPath: out.backupPath,
          })
          break
        }
        default:
          // Should be unreachable — SUPPORTED_AGENTS gating in planSwitch
          // means we never get here with an unsupported id.
          result.agentResults.push({
            agentId: patch.agentId,
            ok: false,
            error: "unsupported agent",
          })
      }
    } catch (err) {
      result.agentResults.push({
        agentId: patch.agentId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

/**
 * Probe each surface for which CCSwitch provider it is currently using.
 * Comparison is by `(apiKey, baseUrl)` tuple — provider records with the
 * same key+URL pair are considered equivalent regardless of name.
 *
 * The `agentReaders` parameter is injected so callers (and tests) can plug
 * in their own probes; the default uses no I/O for now (claude-code's env
 * block lives outside cognia-next's existing `read_agent_config`, and we
 * don't want this function to silently start hitting disk on every render).
 * The Settings → CCSwitch overview tab passes a real reader that calls
 * `read_claude_user_settings` to populate the `claude-code` slot.
 */
export async function detectActive(
  providers: CcswitchProvider[],
  options: {
    agentReaders?: Partial<
      Record<CcswitchAgentId, () => Promise<{ apiKey?: string; baseUrl?: string } | null>>
    >
  } = {}
): Promise<ActiveProviderState> {
  const settings = await getSettings()
  const cognia = matchProvider(providers, {
    apiKey: settings.apiKey,
    baseUrl: settings.apiBaseUrl,
  })?.id

  const agents: Partial<Record<CcswitchAgentId, string | undefined>> = {}
  const readers = options.agentReaders ?? {}
  for (const agentId of Object.keys(readers) as CcswitchAgentId[]) {
    const reader = readers[agentId]
    if (!reader) continue
    try {
      const env = await reader()
      if (env) {
        const match = matchProvider(providers, env)
        agents[agentId] = match?.id
      } else {
        agents[agentId] = undefined
      }
    } catch {
      agents[agentId] = undefined
    }
  }

  const drift = detectDrift(cognia, agents)
  return { cognia, agents, drift }
}

function matchProvider(
  providers: CcswitchProvider[],
  env: { apiKey?: string; baseUrl?: string }
): CcswitchProvider | undefined {
  const k = (env.apiKey ?? "").trim()
  const u = (env.baseUrl ?? "").trim()
  if (!k && !u) return undefined
  return providers.find((p) => (p.apiKey ?? "").trim() === k && (p.baseUrl ?? "").trim() === u)
}

function detectDrift(
  cognia: string | undefined,
  agents: Partial<Record<CcswitchAgentId, string | undefined>>
): boolean {
  for (const id of Object.values(agents)) {
    if (id === undefined) continue
    if (cognia === undefined) return true
    if (id !== cognia) return true
  }
  return false
}

// Exposed for tests.
export const _internals = {
  matchProvider,
  detectDrift,
  envUpdatesForProvider,
  SUPPORTED_AGENTS,
  hasApiKey, // re-export so the test harness doesn't have to mock the same module twice
}
