/**
 * The real `RoomRunnerDeps`: the same lib modules `use-team-chat.ts` always
 * imported, gathered behind one factory so the desktop renderer, the
 * headless brain and the `room_send` RPC arm construct one runner the same
 * way. Nothing here is React or store bound, which is the whole point.
 *
 * Tests that mock a module by specifier (`jest.mock("@/lib/claude/ipc")`)
 * keep working through this file, because it imports the same specifiers.
 */

import { approveTool, closeSession, interruptSession, sendPrompt } from "@/lib/claude/ipc"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { runTurnMemory } from "@/lib/memory/run-turn-memory"
import { tryBuildMemoryDeps } from "@/lib/memory/runtime/build-deps"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import { generateSafeEmbedding } from "@/lib/rag/safe-embedding"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { runTitleTask } from "@/lib/ai/generation/run-title-task"
import { listMessages, persistMessages } from "@/lib/db/messages"
import { getSession, touchSession, updateSession } from "@/lib/db/sessions"
import { listCharactersByIds } from "@/lib/db/characters"
import { recordResultUsage } from "@/lib/db/session-usage"
import { bumpUnread } from "@/lib/db/session-state"
import { getTeam } from "@/lib/db/teams"
import { getExecutionBroker } from "@/lib/execution/broker"
import { runWithExecutionLease } from "@/lib/execution/admit"
import { slotKeyForTurn } from "@/lib/execution/slot-key"
import { resolveEffectiveCwdForSession } from "@/hooks/chat/use-effective-cwd"
import { acquireChatLease, releaseChatLease } from "@/lib/execution/chat-lease"
import { recordChatToolApprovalDecision } from "@/lib/policy/action-review/chat-tool-channel"
import { pendingRecoveryPhase } from "@/lib/usage/compaction-metrics"
import type { RoomRunnerDeps } from "./runner-deps"

export interface ProductionRoomDepsOptions {
  /** Debounce for the streaming Dexie write. Defaults to 250ms, 0 under test. */
  persistDelayMs?: number
}

export function createProductionRoomDeps(opts: ProductionRoomDepsOptions = {}): RoomRunnerDeps {
  return {
    ipc: {
      sendPrompt: (sessionId, prompt, options) => sendPrompt(sessionId, prompt, options),
      interruptSession: (sessionId) => interruptSession(sessionId),
      closeSession: (sessionId) => closeSession(sessionId),
      approveTool: (...args) => approveTool(...(args as Parameters<typeof approveTool>)),
    },
    db: {
      getSession,
      updateSession,
      touchSession,
      getTeam,
      listCharactersByIds,
      listMessages,
      persistMessages,
      bumpUnread,
      recordResultUsage: async (input) => {
        await recordResultUsage(input as never)
      },
    },
    execution: {
      isAtCapacity: (kind, sessionId) => getExecutionBroker().isAtCapacity(kind, sessionId),
      runWithExecutionLease: (request, run) => runWithExecutionLease(request as never, run),
      releaseChatLease,
      acquireChatLease: (input) => acquireChatLease(input as never),
      slotKeyForTurn: (input) => slotKeyForTurn(input as never),
      resolveEffectiveCwdForSession: (session) => resolveEffectiveCwdForSession(session),
    },
    ai: {
      resolveSendOptions,
      tryBuildTwinDeps: () => tryBuildTwinDeps(),
      tryBuildMemoryDeps: (config, twin) => tryBuildMemoryDeps(config as never, twin),
      generateSafeEmbedding: (text, options) => generateSafeEmbedding(text, options as never),
      runTurnMemory: (sessionId, input) => runTurnMemory(sessionId, input as never),
      buildUtilityLlmClient: (args) => buildUtilityLlmClient(args as never),
      runTitleTask: (args) => runTitleTask(args as never),
      resolveProviderAttemptOptions: async (providerId, settings, modelId, previousOptions) => {
        const { resolveProviderAttemptOptions, applyProviderAttemptLimits } =
          await import("@/lib/claude/provider-attempt-options")
        const attempt = await resolveProviderAttemptOptions(
          providerId,
          settings,
          undefined,
          false,
          modelId
        )
        return {
          ...attempt,
          ...applyProviderAttemptLimits(
            {
              ...previousOptions,
              provider: providerId,
              model: modelId ?? attempt.defaultModel,
              modelParams: attempt.modelParams,
            },
            settings,
            previousOptions?.modelParams?.maxOutputTokens
          ),
        }
      },
      pendingRecoveryPhase: (messages) => pendingRecoveryPhase(messages as never),
      applySdkSubagentBridge: (event, teamSessionId) => {
        // Guarded and lazy, exactly as the hook loaded it: a bridge throw must
        // never break the room loop, and the module is renderer-heavy.
        void import("@/lib/claude/sdk-subagent-bridge")
          .then(({ applySdkSubagentBridge }) => applySdkSubagentBridge(event, teamSessionId))
          .catch((err) => console.warn("sdkSubagentBridge (room) failed", err))
      },
      recordChatToolApprovalDecision,
    },
    now: () => Date.now(),
    newTurnId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    persistDelayMs: opts.persistDelayMs ?? (process.env.NODE_ENV === "test" ? 0 : 250),
  }
}
