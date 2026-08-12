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
import { allRootPaths } from "@/lib/workspace/roots"
import { resolveWorkspaceTrustForSend } from "@/lib/workspace/trust-gate"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import { tryBuildMemoryDeps } from "@/lib/memory/runtime/build-deps"
import { generateEmbedding } from "@cognia/provider-embedding/embedding"
import { resolveMemoryConfig } from "@/types/memory/memory"
import type { ChatSession, SendOptions } from "@cognia/agent-config-types"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import { renderWorkingSetForCompaction } from "@/lib/chat/working-set"

export function buildWorkingSetPostCompaction(
  phaseNumber: number | null,
  workingSet: ChatSession["workingSet"]
): { phaseNumber: number; durableInstructions?: string } | undefined {
  if (phaseNumber === null) return undefined
  const durableInstructions = workingSet ? renderWorkingSetForCompaction(workingSet) : ""
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
    const ps = useProjectStore.getState()
    const activeProjectForAgents = ps.activeProjectId
      ? (ps.projects.find((p) => p.id === ps.activeProjectId) ?? null)
      : null
    const markdownTargets = await discoverMarkdownAgentTargets({
      cwd: session?.workingDir ?? undefined,
      roots: activeProjectForAgents ? allRootPaths(activeProjectForAgents) : [],
    })
    const mentionTargets = [...buildChatMentionTargets(), ...markdownTargets]
    targetAgentId = resolveTargetAgentId(userMessage, mentionTargets) ?? undefined
  }

  // Active workspace (project). Its `rootDir` joins the cwd resolution chain
  // and its `additionalDirs` are unioned into `additionalDirectories` for this
  // turn. `null` when no workspace is active (resolver falls back as before).
  const projectState = useProjectStore.getState()
  const activeProject = projectState.activeProjectId
    ? (projectState.projects.find((p) => p.id === projectState.activeProjectId) ?? null)
    : null

  // Workspace Trust gate: an untrusted active workspace runs in Restricted Mode
  // (disk/host tools denied by `resolveSendOptions`). Authoritative at send time
  // — independent of the React banner state. Web + disabled setting bypass.
  const workspaceTrust = await resolveWorkspaceTrustForSend(activeProject, {
    enabled: appSettings?.workspaceTrust?.enabled !== false,
    onWeb: !isTauri(),
  })

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
      turnEmbedding = (await generateEmbedding(userMessage, twinHandshake.embedding)).embedding
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
  const ephemeralSkillIds = useChatStore.getState().ephemeralSkillIds ?? []

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
  const postCompaction = buildWorkingSetPostCompaction(recoveryPhase, session?.workingSet)
  const memoryBranch = useGitStore.getState().status?.branch ?? undefined
  const primaryRoot = activeProject ? primaryRootOf(activeProject)?.path : undefined
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
    appSettings,
    activeProject,
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
