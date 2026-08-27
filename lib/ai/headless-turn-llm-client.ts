/**
 * `LlmClient` backed by ONE headless Claude turn, for renderer features that
 * must keep working without a renderer-visible API key.
 *
 * The sibling factory (`lib/ai/renderer-llm-client.ts`) calls the provider
 * DIRECTLY from the renderer with the AI SDK, so it needs
 * `AppSettings.providerSettings[provider].apiKey` and returns `null` without
 * one. That is correct for silent background chores — but it also means every
 * feature built on it is dead for the app's primary auth mode: a Claude
 * subscription keeps its OAuth bearer in the keyring / sidecar (ADR-0025) and
 * never exposes it to the renderer. A user-invoked action that answers "not
 * configured" on a perfectly configured install reads as a broken feature.
 *
 * This client closes that gap over the transport the chat itself uses:
 * `runAndCaptureAssistantReply` runs one turn against a memory-only session id
 * that is never persisted (same pattern as `lib/a2ui/ai-generate.ts`), so the
 * subscription bearer is used where it lives — in the host — and nothing lands
 * in the user's history.
 *
 * Scope, deliberately: this is for EXPLICIT, user-invoked one-shots (the
 * composer's prompt-enhance wand). Per-keystroke helpers — ghost text,
 * starter / follow-up suggestions — must NOT fall back here: a full agent turn
 * per burst is the wrong cost shape, and their silent `null` is a correct
 * degradation. Try the direct client first and use this only as a fallback,
 * so a configured BYOK key still gets the cheap fast model.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { isTauri } from "@/lib/tauri"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { useSettingsStore } from "@/stores/settings"

export interface BuildHeadlessTurnClientArgs {
  /**
   * The session whose model / provider the turn should inherit. Only those two
   * fields are read — the turn runs under a fresh, unpersisted id, so the
   * user's conversation is never touched.
   */
  session: ChatSession | null | undefined
  /** Broker lease label, i.e. what this shows up as in the runs console. */
  label: string
}

/**
 * Is a live model turn reachable from this renderer at all? Pure web with no
 * paired companion has no transport, so there is nothing to fall back TO.
 */
export function canRunHeadlessTurn(): boolean {
  return isTauri() || hasWebCompanionTarget()
}

function mintTurnId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Build the fallback client, or `null` when no transport can carry a turn.
 *
 * `stream` / `getUsageSnapshot` are intentionally not implemented: the capture
 * wrapper resolves with the whole reply, and usage is already attributed to the
 * turn by the normal execution path.
 */
export function buildHeadlessTurnLlmClient({
  session,
  label,
}: BuildHeadlessTurnClientArgs): LlmClient | null {
  if (!canRunHeadlessTurn()) return null

  return {
    async complete(prompt, options) {
      const turnSessionId = mintTurnId()
      // The full resolver, then a clamp — same order as every other
      // programmatic turn in the app. It is what picks the provider, the
      // runtime and the credentials; skipping it would mean re-deriving that
      // chain here and drifting from it.
      const {
        // A rewrite is not the assistant answering: `system` fully REPLACES the
        // SDK prompt, and the two fields are mutually exclusive, so the
        // resolver's append has to come off with it.
        appendSystemPrompt: _appendedByResolver,
        ...base
      } = await resolveSendOptions({
        session: {
          id: turnSessionId,
          ...(session?.model ? { model: session.model } : {}),
          ...(session?.providerOverride ? { providerOverride: session.providerOverride } : {}),
        } as unknown as ChatSession,
        appSettings: useSettingsStore.getState().settings,
      })

      const result = await runAndCaptureAssistantReply(
        turnSessionId,
        prompt,
        {
          ...base,
          ...(options?.system ? { systemPrompt: options.system } : {}),
          // One shot, no tools, no MCP: the caller wants text back, and an
          // agent that can reach for Read/Bash here would be answering the
          // draft instead of rewriting it.
          toolSurface: "none",
          allowedTools: [],
          mcpServers: {},
          maxTurns: 1,
        },
        {
          execution: { kind: "subagent", label },
          ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
        }
      )
      return result.text
    },
  }
}
