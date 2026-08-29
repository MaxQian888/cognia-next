"use client"

import { getGoalRuntime } from "@/lib/goal/runtime"
import { getLoopRuntime } from "@/lib/loop/runtime"
import type { AgentPlan } from "@/types/agent/plan"
import { resolveSendOptions } from "@/lib/claude/build-options"
import type { ResolvedAgentExecutionSpec } from "@cognia/agent-config-types/agent-execution"
import { useGitStore } from "@/stores/git/git-store"
import { primaryRootOf } from "@/lib/workspace/roots"
import { pendingRecoveryPhase } from "@/lib/usage/compaction-metrics"
import {
  buildChatMentionTargets,
  resolveTargetAgentId,
} from "@/lib/claude/agents/chat-mention-targets"
import { discoverMarkdownAgentTargets } from "@/lib/claude/agents/markdown-mention-targets"
import { useProjectStore } from "@/stores/project/project-store"
import { resolveSessionWorkspace } from "@/lib/workspace/session-workspace"
import { allRootPaths } from "@/lib/workspace/roots"
import { resolveWorkspaceTrustForSend } from "@/lib/workspace/trust-gate"
import { decideSessionTierPin } from "@/lib/sandbox/pin-session-tier"
import { resolveSandboxEnabled } from "@/lib/sandbox/binding"
import { resolveCharacterById } from "@/lib/db/characters"
import { updateSession } from "@/lib/db/sessions"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import { tryBuildMemoryDeps } from "@/lib/memory/runtime/build-deps"
import { generateSafeEmbedding } from "@/lib/rag/safe-embedding"
import { resolveMemoryConfig } from "@/types/memory/memory"
import type { ChatSession, SendOptions } from "@cognia/agent-config-types"
import { selectComposerEphemeralSkillIds, useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import { renderWorkingSetForCompaction } from "@/lib/chat/working-set"
import { loadCapturedCompactionCheckpoint } from "@/lib/rag/compaction-runtime"
import { renderCompactionCheckpointForRecovery } from "@/lib/rag/compaction-checkpoint"

export function buildWorkingSetPostCompaction(
  phaseNumber: number | null,
  workingSet: ChatSession["workingSet"],
  checkpointInstructions = ""
): { phaseNumber: number; durableInstructions?: string } | undefined {
  if (phaseNumber === null) return undefined
  const workingSetInstructions = workingSet ? renderWorkingSetForCompaction(workingSet) : ""
  const durableInstructions = [checkpointInstructions.trim(), workingSetInstructions]
    .filter(Boolean)
    .join("\n\n")
  return {
    phaseNumber,
    ...(durableInstructions ? { durableInstructions } : {}),
  }
}

export async function buildSendOptions(
  session: ChatSession | null | undefined,
  userMessage?: string,
  onResolvedExecutionSpec?: (spec: ResolvedAgentExecutionSpec) => void
): Promise<SendOptions> {
  const appSettings = useSettingsStore.getState().settings
  // The composer keeps @-referenced files/folders in the chat store. Hand
  // them to resolveSendOptions so each turn announces the directories the
  // SDK's Read tool may need.
  const referencedPaths = useChatStore
    .getState()
    .referencedPaths.map((r) => ({ absolute: r.absolute, isDir: r.isDir }))

  // The workspace THIS TURN runs in. Resolved from the session's own
  // `projectId` first and only then from the UI-active workspace — the two
  // diverge whenever the conversation list spans workspaces, a background pane
  // keeps streaming after the user switches, or the turn has no UI focus at all
  // (connector / scheduler legs). Resolving against the active workspace in
  // those cases sends the turn against another project's roots. Everything
  // downstream — cwd, allRootPaths, workspace trust, additionalDirectories,
  // project RAG — reads this one value.
  const projectState = useProjectStore.getState()
  const turnProject = resolveSessionWorkspace(
    session,
    projectState.projects,
    projectState.activeProjectId
  )

  // `@agent` single-turn routing: resolve the first @-mentioned subagent in the
  // message to its dispatcher id. `resolveSendOptions` only honours it when the
  // id is actually registered in this turn's agent map (membership guard), so a
  // stale / unknown mention is harmless here. The target list unions the
  // reactive subagents with on-disk markdown agents (`.cognia/agents/*.md`) —
  // the SAME projection the composer `@` picker shows — so a picked markdown
  // handle (handle === id === the `opts.agents` key) actually routes. Discovery
  // is cached (3s) and returns `[]` off-Tauri, so this stays cheap.
  let targetAgentId: string | undefined
  if (userMessage) {
    const markdownTargets = await discoverMarkdownAgentTargets({
      cwd: session?.workingDir ?? undefined,
      roots: turnProject ? allRootPaths(turnProject) : [],
    })
    const mentionTargets = [...buildChatMentionTargets(), ...markdownTargets]
    targetAgentId = resolveTargetAgentId(userMessage, mentionTargets) ?? undefined
  }

  // Workspace Trust gate: an untrusted active workspace runs in Restricted Mode
  // (disk/host tools denied by `resolveSendOptions`). Authoritative at send time
  // — independent of the React banner state. Web + disabled setting bypass.
  const workspaceTrust = await resolveWorkspaceTrustForSend(turnProject, {
    enabled: appSettings?.workspaceTrust?.enabled !== false,
    onWeb: !isTauri(),
  })

  // The turn's character, resolved ONCE. Both the tier pin below and
  // `resolveSendOptions` need it, and each used to load it for itself — two
  // Dexie reads per send for one row. Handed down as `ctx.character`, which
  // `resolveSendOptions` already accepts precisely so a caller that has it can
  // skip the lookup.
  // `resolveCharacterById`, not `getCharacter`: it falls through to the
  // plugin-overlay pack registry for a synthetic `cognia-pack:` id, which is
  // the same reader `resolveSendOptions` uses. The plain Dexie read answered
  // nothing for a pack-bound session, so the pin saw no character tier at all.
  const turnCharacter = session?.characterId
    ? ((await resolveCharacterById(session.characterId).catch(() => undefined)) ?? null)
    : null

  // Freeze the sandbox tier onto the session the first time it runs sandboxed.
  // The ladder is re-read every send and nothing else writes the session's own
  // tier, so without this a conversation follows `AppSettings.sandboxTier`
  // forever and can lose isolation because of a setting changed elsewhere.
  // BOTH halves go through `lib/sandbox/binding.ts` — `resolveSandboxEnabled`
  // for the switch and `resolveSandboxSessionBinding` for the tier — so this
  // cannot drift from what `resolveSendOptions` binds with. Best-effort: a
  // failed pin must never block a send.
  if (session?.id) {
    try {
      const pin = decideSessionTierPin({
        sandboxEnabled: resolveSandboxEnabled({
          session: { sandboxEnabled: session.sandboxEnabled },
          character: { sandboxEnabled: turnCharacter?.sandboxEnabled },
          appSettings: { sandboxDefaultEnabled: appSettings?.sandboxDefaultEnabled },
        }),
        followsDefault: session.sandboxTierFollowsDefault,
        inputs: {
          session: { sandboxTier: session.sandboxTier },
          character: { sandboxTier: turnCharacter?.sandboxTier },
          appSettings: { sandboxTier: appSettings?.sandboxTier },
        },
      })
      if (pin.pin) await updateSession(session.id, { sandboxTier: pin.tier })
    } catch (err) {
      console.warn("buildSendOptions: sandbox tier pin failed", err)
    }
  }

  // Twin runtime injection: when the user has populated the runtime config
  // (vector store + embedding API key) and the message is a plain string,
  // hand resolveSendOptions the deps so it can call applyTwinContext for
  // any twin-bound character. resolveSendOptions itself decides whether to
  // run the injection based on `character.twinId`.
  const twinHandshake = userMessage?.trim() ? await tryBuildTwinDeps() : undefined

  // Embed the user message ONCE per turn (when twin deps exist) so the twin RAG
  // leg and the memory recall leg share one query vector instead of embedding
  // the same text twice. Memory's vector backend shares the twin embedding model
  // (resolveMemoryBackend), so the vector is valid for both. Best-effort — on
  // failure the resolver falls back to per-leg embedding.
  let turnEmbedding: number[] | undefined
  if (twinHandshake && userMessage?.trim()) {
    try {
      turnEmbedding = (
        await generateSafeEmbedding(userMessage, {
          profileId: "chat-shared",
          purpose: "query",
          embedding: twinHandshake.embedding,
          vectorBackend: twinHandshake.vectorBackend ?? "native",
        })
      ).embedding
    } catch {
      turnEmbedding = undefined
    }
  }

  // Long-term memory: build the read-runtime deps when memory is enabled and
  // the turn carries a user message. `resolveSendOptions` decides (per its own
  // enabled/temporary gate) whether to actually recall + inject.
  const memoryHandshake = userMessage?.trim()
    ? await tryBuildMemoryDeps(resolveMemoryConfig(appSettings?.memory), twinHandshake)
    : undefined

  // Per-message ephemeral skills attached via the composer's SkillPicker.
  // These are unioned with character.skillIds in resolveSendOptions and
  // cleared after the send dispatches.
  //
  // Keyed by THIS session, matching where the picker writes them: the bare
  // top-level field is the FOCUSED conversation, so a send from an unfocused
  // split pane attached the other pane's skills and never its own.
  const ephemeralSkillIds =
    selectComposerEphemeralSkillIds(useChatStore.getState(), session?.id ?? null) ?? []

  // ADR-0019 — when this session has an active goal, hand it to the resolver
  // so the goal's `<objective>` system section is appended to this turn. The
  // resolver only injects when `status === "active"`, so a paused goal (e.g.
  // after the user typed a fresh message) is correctly skipped.
  const activeGoal = session?.id
    ? ((await getGoalRuntime().getActiveGoalForSession(session.id)) ?? null)
    : null

  // ADR-0045 — same contract for an EXECUTING plan: hand it to the resolver so
  // `appendPlanContext` appends the plan's checklist + current-step callout to
  // this turn. `getExecutingPlanForSession` already filters by status, and the
  // resolver re-checks, so a paused / awaiting-approval plan never injects.
  // Lazy import (like the other plan touchpoints in this file) keeps the plan
  // runtime + its Dexie tables off the eager module graph; best-effort, since a
  // read hiccup must not block the send.
  let activePlan: AgentPlan | null = null
  try {
    if (session?.id) {
      const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")
      activePlan = (await getPlanRuntime().getExecutingPlanForSession(session.id)) ?? null
    }
  } catch {
    activePlan = null
  }

  // When a `/loop` run is driving this session, flag it so the surface-aware
  // goal/loop guidance skill activates (parallel to `activeGoal` above; the
  // loop has no per-turn Dexie context block of its own). Best-effort.
  let activeLoop = false
  try {
    activeLoop = session?.id
      ? Boolean(await getLoopRuntime().getActiveLoopForSession(session.id))
      : false
  } catch {
    activeLoop = false
  }

  // One-shot post-compaction recovery: if a compaction boundary just landed and
  // no assistant turn has followed it yet, this upcoming turn is the first of a
  // new context phase — re-inject the recovery preamble. Stateless (derived from
  // the transcript), so it fires exactly once per boundary.
  const chatState = useChatStore.getState()
  const sessionMessages = session?.id
    ? chatState.activeSessionId === session.id
      ? chatState.messages
      : (chatState.sessions[session.id]?.messages ?? [])
    : chatState.messages
  const recoveryPhase = pendingRecoveryPhase(sessionMessages)
  const recoveryBoundaryId =
    recoveryPhase === null
      ? undefined
      : [...sessionMessages]
          .reverse()
          .find(
            (message) =>
              message.role === "system" &&
              (message.parts[0] as { type?: string } | undefined)?.type === "compact-boundary"
          )?.id
  let checkpointInstructions = ""
  if (recoveryBoundaryId && session?.id) {
    try {
      const checkpoint = await loadCapturedCompactionCheckpoint(recoveryBoundaryId, session.id)
      if (checkpoint) checkpointInstructions = renderCompactionCheckpointForRecovery(checkpoint)
    } catch {
      // Locked Vault and corrupt/missing checkpoints never downgrade to plaintext.
    }
  }
  const postCompaction = buildWorkingSetPostCompaction(
    recoveryPhase,
    session?.workingSet,
    checkpointInstructions
  )
  const memoryBranch = useGitStore.getState().status?.branch ?? undefined
  const primaryRoot = turnProject ? primaryRootOf(turnProject)?.path : undefined
  const referencedMemoryPath =
    primaryRoot && referencedPaths
      ? referencedPaths
          .map((item) => item.absolute)
          .find((absolute) => absolute === primaryRoot || absolute.startsWith(`${primaryRoot}/`))
      : undefined
  const memoryPath =
    referencedMemoryPath && primaryRoot
      ? referencedMemoryPath.slice(primaryRoot.length).replace(/^\/+/, "") || undefined
      : undefined

  return resolveSendOptions({
    postCompaction,
    session,
    character: turnCharacter,
    appSettings,
    activeProject: turnProject,
    workspaceRestricted: workspaceTrust.restricted,
    trustedWorkspaceRoots: workspaceTrust.trustedRoots,
    referencedPaths,
    targetAgentId,
    memoryBranch,
    memoryPath,
    twinDeps: twinHandshake,
    twinUserMessage: twinHandshake ? userMessage : undefined,
    memoryDeps: memoryHandshake,
    memoryUserMessage: memoryHandshake ? userMessage : undefined,
    // Project-scoped RAG (workspace knowledge base). Reuses the same twin deps
    // (shared vector store + embedding); `resolveSendOptions` gates injection on
    // the active workspace having knowledge files + project RAG enabled. Shares
    // the turn's query embedding — no extra embed call.
    projectKnowledgeDeps: twinHandshake,
    projectKnowledgeUserMessage: twinHandshake ? userMessage : undefined,
    precomputedQueryEmbedding: turnEmbedding,
    // Routing context-window pre-check input (B4): always pass the raw user
    // message (unlike twin/memory it needs no handshake gate).
    routingContextHint: userMessage ? { promptText: userMessage } : undefined,
    routingSurface: "chat",
    ephemeralSkillIds,
    skillRenderMode: "hybrid",
    activeGoal,
    activePlan,
    activeLoop,
    // Open this turn's agent-trace ROOT span here (one mint per turn). The hook
    // owns `endSpan` (result / error branches of `handleEvent`, keyed off the
    // cached `sendOptions.spanId`). The inline `startSpan` fallback below stays
    // only for the `opts`-bypass path (retry / loop) where buildSendOptions —
    // and thus this resolver — is skipped.
    emitTrace: true,
    traceSurface: "chat",
    onResolvedExecutionSpec,
  })
}
