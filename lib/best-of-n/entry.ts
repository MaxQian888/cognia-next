import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"
import { getSession } from "@/lib/db/sessions"
import { commitMessageDelta } from "@/lib/db/messages"
import { resolveEffectiveCwdForSession } from "@/hooks/chat/use-effective-cwd"
import { getSourceControlService } from "@/lib/scm/service"
import { readReviewPolicyAtRef } from "@/lib/scm/review/review-policy"
import { useChatStore } from "@/stores/chat/chat-store"
import { getRuntimeTranslator } from "@/lib/i18n/runtime-translator"
import { startBestOfN } from "./service"
import { canManageBestOfNRuns, projectBestOfNGroup } from "./projection"

export interface PreparedBestOfN {
  session: ChatSession
  requestId: string
  prompt: string
  n: 2 | 3 | 4
  sourceRoot: string
  baseSha: string
  dirty: boolean
  branches: string[]
  targetRef: string
  requiredChecks: string[]
}

/** Preview the exact committed base before either entry point spends anything. */
export async function prepareBestOfNChat(
  sessionId: string,
  prompt: string,
  n: 2 | 3 | 4
): Promise<PreparedBestOfN> {
  const t = await getRuntimeTranslator("bestOfNEntry")
  if (!canManageBestOfNRuns()) throw new Error(t("unavailable"))
  const session = await getSession(sessionId)
  if (!session || !session.characterId || session.kind !== "direct" || session.platformBinding)
    throw new Error(t("needsSession"))
  if (!prompt.trim() || ![2, 3, 4].includes(n)) throw new Error(t("usage"))
  const sourceRoot = await resolveEffectiveCwdForSession(session)
  if (!sourceRoot) throw new Error(t("needsRepository"))
  const scm = getSourceControlService()
  const [status, history, branches] = await Promise.all([
    scm.status(sourceRoot),
    scm.history(sourceRoot, { maxCount: 1 }),
    scm.branches(sourceRoot),
  ])
  const baseSha = history[0]?.hash
  if (!baseSha) throw new Error(t("needsCommit"))
  const policy = await readReviewPolicyAtRef(sourceRoot, baseSha, scm.readFileAt)
  if (!policy.ok) throw new Error(t("invalidPolicy"))
  const requestId = crypto.randomUUID()
  return {
    session,
    requestId,
    prompt: prompt.trim(),
    n,
    sourceRoot,
    baseSha,
    dirty: status.staged.length + status.changes.length + status.merge.length > 0,
    branches: branches.filter((branch) => !branch.isRemote).map((branch) => branch.name),
    targetRef: `best-of-n/${requestId}`,
    requiredChecks: policy.policy.requiredChecks,
  }
}

/** Both composer entry points consume their ordinary send through this one call. */
export async function startPreparedBestOfN(
  prepared: PreparedBestOfN,
  target: { targetRef: string; targetIsNew: boolean }
) {
  const t = await getRuntimeTranslator("bestOfNEntry")
  if (!canManageBestOfNRuns()) throw new Error(t("unavailable"))
  const { session, requestId, prompt, n, sourceRoot, baseSha, requiredChecks } = prepared
  const handle = await startBestOfN({
    requestId,
    repositoryId: sourceRoot,
    sourceRoot,
    baseRef: baseSha,
    ...target,
    prompt,
    projectId: session.projectId,
    requiredChecks,
    budgetPolicy: {},
    candidates: Array.from({ length: n }, () => ({
      agentId: session.characterId!,
      ...(session.model ? { model: session.model } : {}),
      ...(session.providerOverride ? { provider: session.providerOverride } : {}),
    })),
  })
  // Observe rejection immediately, even if local projection persistence takes time.
  void handle.completion.catch(() => undefined)
  const binding = {
    parentSessionId: session.id,
    parentMessageId: requestId,
    projectId: session.projectId,
    requiredChecks,
  }
  await projectBestOfNGroup(handle.group, binding)
  const messages: UIMessage[] = [
    { id: `${requestId}-prompt`, role: "user", parts: [{ type: "text", text: prompt }] },
    {
      id: requestId,
      role: "assistant",
      parts: [
        {
          type: "text",
          text:
            t("started", {
              count: n,
              base: handle.group.baseSha,
              target: handle.group.targetRef,
            }) + (handle.group.checkoutHadUncommittedChanges ? `\n${t("dirty")}` : ""),
        },
      ],
      metadata: { bestOfN: { groupId: handle.group.groupId, sessionId: session.id } },
    },
  ]
  await commitMessageDelta(session.id, { upserts: messages })
  for (const message of messages)
    useChatStore.getState().appendMessageToSession(session.id, message)
  void handle.completion.then((group) => projectBestOfNGroup(group, binding)).catch(() => undefined)
  return handle.group
}
