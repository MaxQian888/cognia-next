"use client"

/**
 * useAiDiffExplain — generate a natural-language explanation of a diff (a
 * working-tree/staged file, or a commit's file). Mirrors `useAiCommitMessage`:
 * own loading/error state, model via `buildUtilityLlmClient`, and a PII gate
 * that redacts the diff (redact-and-send) with a non-blocking toast on a hit.
 * Gated behind `gitSettings.explainAI.enabled`.
 *
 * The caller supplies the already-assembled `subject` + `diffText` (built from a
 * `GitDiff`'s hunk patches), so this hook stays agnostic to where the diff came
 * from and is reused by both the working-tree pane and the commit detail view.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { generateDiffExplanation } from "@/lib/git/ai-explain"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_GIT_SETTINGS } from "@/types/git"

export interface UseAiDiffExplainResult {
  explaining: boolean
  error: string | null
  /** The last generated explanation, or null before the first run. */
  text: string | null
  /** Generate + store the explanation. Returns it, or null if skipped. */
  explain: () => Promise<string | null>
}

export function useAiDiffExplain(subject: string, diffText: string): UseAiDiffExplainResult {
  const t = useTranslations("sourceControl")
  const [explaining, setExplaining] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)

  const settings = useSettingsStore((s) => s.settings)
  const config = useMemo(
    () => settings?.gitSettings?.explainAI ?? DEFAULT_GIT_SETTINGS.explainAI ?? { enabled: false },
    [settings]
  )

  // Reset the cached explanation whenever the diff being explained changes, so a
  // popover reused across a file/commit switch doesn't keep showing the previous
  // diff's summary — and its `!text` auto-run guard re-fires for the new diff.
  const [prevInput, setPrevInput] = useState({ subject, diffText })
  if (prevInput.subject !== subject || prevInput.diffText !== diffText) {
    setPrevInput({ subject, diffText })
    setText(null)
    setError(null)
  }

  const explain = useCallback(async (): Promise<string | null> => {
    setError(null)
    if (!diffText.trim()) {
      toast.info(t("explain.empty"))
      return null
    }
    setExplaining(true)
    try {
      let gated = diffText
      if (!hasNoLeakingPii(diffText)) {
        gated = redactText(diffText).redacted
        toast.warning(t("explain.redacted"))
      }

      const client = buildUtilityLlmClient({
        session: null,
        appSettings: settings,
        override: { providerOverride: config.providerOverride, model: config.model },
        featureId: "git.explainDiff",
      })
      if (!client) {
        toast.error(t("explain.failed"))
        return null
      }

      const explanation = await generateDiffExplanation(
        { subject, diffText: gated, config: { customInstructions: config.customInstructions } },
        client
      )
      if (!explanation) {
        toast.error(t("explain.failed"))
        return null
      }
      setText(explanation)
      return explanation
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t("explain.failed"))
      return null
    } finally {
      setExplaining(false)
    }
  }, [subject, diffText, settings, config, t])

  return { explaining, error, text, explain }
}
