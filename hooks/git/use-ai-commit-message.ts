"use client"

/**
 * useAiCommitMessage — generate a commit message from the staged diff and write
 * it into the commit draft. Owns its own loading/error state (AI generation is
 * not a git mutation, so it stays out of `useGitActions`).
 *
 * WHO writes it follows the agent the composer has selected for the active
 * conversation (`useRuntimeRefForSession`), unless
 * `gitSettings.commitMessageAI.source` is `"model"`:
 *
 *  - a local external agent (Codex, Claude Code, …) runs read-only in the
 *    repository and may read files for context (`lib/git/ai-commit-agent.ts`);
 *  - a paired host's configuration runs on the host;
 *  - the built-in lane, and `source: "model"`, use `buildUtilityLlmClient`
 *    (the same background helper path as conversation-title), which honors the
 *    commit-message provider/model override.
 *
 * Either way the text streams into `preview` while it is written, and
 * `cancel()` stops the run. Whatever the user had already typed rides along as
 * a hint, so "fix login race" becomes a full message rather than being thrown
 * away.
 *
 * Privacy: the staged diff and the draft are gated through `hasNoLeakingPii`;
 * on a hit they are redacted with placeholders before being sent (redact-and-
 * send), with a non-blocking toast so the user knows. The feature is gated
 * behind `gitSettings.commitMessageAI.enabled`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { gitDiffStagedAll } from "@/lib/git/commands"
import {
  buildCommitAgentPrompt,
  buildCommitAgentSystemPrompt,
  extractCommitMessage,
  generateCommitMessage,
} from "@/lib/git/ai-commit"
import {
  CommitAgentAbortedError,
  commitMessageTarget,
  runCommitMessageAgent,
  type CommitAgentDeps,
  type CommitMessageTarget,
} from "@/lib/git/ai-commit-agent"
import { parseGitTarget } from "@/lib/git/target"
import { useGitStore } from "@/stores/git/git-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useChatStore } from "@/stores/chat"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { DEFAULT_GIT_SETTINGS } from "@/types/git"

export interface UseAiCommitMessageResult {
  generating: boolean
  /** The message as it streams in. Empty when not generating. */
  preview: string
  error: string | null
  /**
   * The agent that will write the message, by name. `null` on the model lane
   * (the built-in agent, or `source: "model"`), which has no name of its own.
   */
  agentName: string | null
  /** Generate + populate the draft. Returns the message, or null if skipped. */
  generate: () => Promise<string | null>
  /** Stop a generation in flight. The draft is left as it was. */
  cancel: () => void
}

/** The heavy executors, loaded the first time an agent lane is used. */
async function loadAgentDeps(): Promise<CommitAgentDeps> {
  const [manager, remote] = await Promise.all([
    import("@/lib/ai/agent/external/manager"),
    import("@/lib/ai/agent/external/runtimes/remote/remote-execute"),
  ])
  return {
    executeExternal: (prompt, options) => manager.executeOnExternalAgent(prompt, options),
    cancelExternal: (agentId, sessionId) =>
      manager.getExternalAgentManager().cancel(agentId, sessionId),
    executeHost: (prompt, options) => remote.executeOnRemoteHostAgent(prompt, options),
    interruptHost: (runId) => remote.interruptRemoteHostAgent(runId),
    newId: () => crypto.randomUUID(),
  }
}

/** PII-gate one piece of outbound text; reports whether anything was redacted. */
function gate(text: string): { text: string; redacted: boolean } {
  if (!text || hasNoLeakingPii(text)) return { text, redacted: false }
  return { text: redactText(text).redacted, redacted: true }
}

export function useAiCommitMessage(rootDir: string): UseAiCommitMessageResult {
  const t = useTranslations("sourceControl")
  const [generating, setGenerating] = useState(false)
  const [preview, setPreview] = useState("")
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  const settings = useSettingsStore((s) => s.settings)
  const config = settings?.gitSettings?.commitMessageAI ?? DEFAULT_GIT_SETTINGS.commitMessageAI
  const setCommitDraft = useGitStore((s) => s.setCommitDraft)
  const activeSessionId = useChatStore((s) => s.activeSessionId) ?? undefined
  const runtimeRef = useRuntimeRefForSession(activeSessionId)
  const externalAgent = useExternalAgentStore((s) =>
    runtimeRef.kind === "external" ? s.agents[runtimeRef.agentId] : undefined
  )

  // A ref naming a local agent that has since been removed has nothing to run;
  // the model lane answers instead of a failure on every click.
  const hasExternalAgent = externalAgent !== undefined
  const target = useMemo<CommitMessageTarget>(() => {
    const resolved = commitMessageTarget(config.source, runtimeRef)
    return resolved.kind === "external" && !hasExternalAgent ? { kind: "model" } : resolved
  }, [config.source, runtimeRef, hasExternalAgent])
  const agentName =
    target.kind === "external"
      ? (externalAgent?.name ?? null)
      : target.kind === "host" && runtimeRef.kind === "host"
        ? (runtimeRef.name ?? t("commit.ai.hostAgent"))
        : null

  // A generation outliving the box that started it must not keep running.
  useEffect(() => () => controllerRef.current?.abort(), [])

  const cancel = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  const generate = useCallback(async (): Promise<string | null> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setError(null)
    setPreview("")
    setGenerating(true)
    try {
      const diffText = await gitDiffStagedAll(rootDir)
      if (!diffText.trim()) {
        toast.info(t("commit.ai.noStaged"))
        return null
      }

      // PII gate: redact-and-send so config files with emails/keys don't block
      // the feature, but the user is told placeholders went to the model.
      const diff = gate(diffText)
      const draft = gate(useGitStore.getState().commitDraft[rootDir] ?? "")
      if (diff.redacted || draft.redacted) toast.warning(t("commit.ai.redacted"))

      const files = useGitStore
        .getState()
        .status?.staged.map((f) => ({ path: f.path, status: f.status }))
      const input = {
        diffText: diff.text,
        files: files ?? [],
        config,
        draftHint: draft.text,
      }

      let message: string
      if (target.kind === "model") {
        // Resolve the model via the shared utility-client path (honors the
        // provider/model override, falls back to the chat default).
        const client = buildUtilityLlmClient({
          session: null,
          appSettings: settings,
          override: { providerOverride: config.providerOverride, model: config.model },
          featureId: "git.commitMessage",
        })
        if (!client) {
          toast.error(t("commit.ai.failed"))
          return null
        }
        message = await generateCommitMessage(input, client, {
          onText: setPreview,
          abortSignal: controller.signal,
        })
      } else {
        const local = parseGitTarget(rootDir)
        const raw = await runCommitMessageAgent(
          target,
          {
            prompt: buildCommitAgentPrompt(input),
            systemPrompt: buildCommitAgentSystemPrompt(config),
            // A repository on a paired host is not a directory this machine's
            // agent can open; the diff in the prompt is all it gets.
            ...(local.kind === "local" ? { workingDirectory: local.repoPath } : {}),
            signal: controller.signal,
            onText: (text) => setPreview(extractCommitMessage(text)),
          },
          await loadAgentDeps()
        )
        message = extractCommitMessage(raw)
      }

      if (controller.signal.aborted) return null
      if (!message) {
        toast.error(t("commit.ai.failed"))
        return null
      }
      setCommitDraft(rootDir, message)
      return message
    } catch (err) {
      if (err instanceof CommitAgentAbortedError || controller.signal.aborted) return null
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t("commit.ai.failed"), { description: message })
      return null
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null
        setGenerating(false)
        setPreview("")
      }
    }
  }, [rootDir, settings, config, target, setCommitDraft, t])

  return { generating, preview, error, agentName, generate, cancel }
}
