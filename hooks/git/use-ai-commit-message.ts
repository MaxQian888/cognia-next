"use client"

/**
 * useAiCommitMessage — generate a commit message from the staged diff and write
 * it into the commit draft. Owns its own loading/error state (AI generation is
 * not a git mutation, so it stays out of `useGitActions`).
 *
 * The model is resolved through `buildUtilityLlmClient` (the same background
 * helper path as conversation-title), so it honors the user's provider/model
 * override and works across providers — not just Anthropic.
 *
 * Privacy: the staged diff is gated through `hasNoLeakingPii`; on a hit it is
 * redacted with placeholders before being sent to the model (redact-and-send),
 * with a non-blocking toast so the user knows. The feature is gated behind
 * `gitSettings.commitMessageAI.enabled`.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { hasNoLeakingPii, redactText } from "@/lib/twin/ingest/redact"
import { gitDiffStagedAll } from "@/lib/git/commands"
import { generateCommitMessage } from "@/lib/git/ai-commit"
import { useGitStore } from "@/stores/git/git-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_GIT_SETTINGS } from "@/types/git"

export interface UseAiCommitMessageResult {
  generating: boolean
  error: string | null
  /** Generate + populate the draft. Returns the message, or null if skipped. */
  generate: () => Promise<string | null>
}

export function useAiCommitMessage(rootDir: string): UseAiCommitMessageResult {
  const t = useTranslations("sourceControl")
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const settings = useSettingsStore((s) => s.settings)
  const config = settings?.gitSettings?.commitMessageAI ?? DEFAULT_GIT_SETTINGS.commitMessageAI
  const setCommitDraft = useGitStore((s) => s.setCommitDraft)

  const generate = useCallback(async (): Promise<string | null> => {
    setError(null)
    setGenerating(true)
    try {
      const diffText = await gitDiffStagedAll(rootDir)
      if (!diffText.trim()) {
        toast.info(t("commit.ai.noStaged"))
        return null
      }

      // PII gate: redact-and-send so config files with emails/keys don't block
      // the feature, but the user is told placeholders went to the model.
      let gated = diffText
      if (!hasNoLeakingPii(diffText)) {
        gated = redactText(diffText).redacted
        toast.warning(t("commit.ai.redacted"))
      }

      const files = useGitStore
        .getState()
        .status?.staged.map((f) => ({ path: f.path, status: f.status }))

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

      const message = await generateCommitMessage(
        { diffText: gated, files: files ?? [], config },
        client
      )

      if (!message) {
        toast.error(t("commit.ai.failed"))
        return null
      }
      setCommitDraft(rootDir, message)
      return message
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t("commit.ai.failed"))
      return null
    } finally {
      setGenerating(false)
    }
  }, [rootDir, settings, config, setCommitDraft, t])

  return { generating, error, generate }
}
