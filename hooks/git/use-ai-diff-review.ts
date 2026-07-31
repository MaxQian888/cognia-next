"use client"

/**
 * useAiDiffReview — run an AI code review over a working-tree file's diff and
 * write per-hunk findings into the diff-review store, where they render beside
 * the human accept/reject/comment controls in `HunkReviewList`.
 *
 * Mirrors `useAiCommitMessage`: owns its own loading/error state, resolves the
 * model through `buildUtilityLlmClient` (honors the provider/model override,
 * works across providers), and gates the diff through `hasNoLeakingPii` —
 * redacting each hunk patch (redact-and-send) with a non-blocking toast on a
 * hit. Gated behind `gitSettings.reviewAI.enabled`.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { generateDiffReview } from "@/lib/git/ai-review"
import { hunkContentHash, normalizeReviewKey } from "@/lib/git/hunk-review"
import { useDiffReviewStore } from "@/stores/git/diff-review-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_GIT_SETTINGS, type GitDiff, type GitFileChange } from "@/types/git"

export interface UseAiDiffReviewResult {
  reviewing: boolean
  error: string | null
  /** Run the review + write findings. Returns the finding count, or null if skipped. */
  review: () => Promise<number | null>
}

export function useAiDiffReview(
  rootDir: string,
  change: GitFileChange,
  diff: GitDiff
): UseAiDiffReviewResult {
  const t = useTranslations("sourceControl")
  const [reviewing, setReviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const settings = useSettingsStore((s) => s.settings)
  const config = useMemo(
    () => settings?.gitSettings?.reviewAI ?? DEFAULT_GIT_SETTINGS.reviewAI ?? { enabled: false },
    [settings]
  )
  const setAiFinding = useDiffReviewStore((s) => s.setAiFinding)
  const clearAiFindings = useDiffReviewStore((s) => s.clearAiFindings)

  const review = useCallback(async (): Promise<number | null> => {
    setError(null)
    if (diff.hunks.length === 0) {
      toast.info(t("review.ai.noHunks"))
      return null
    }
    setReviewing(true)
    try {
      // PII gate on the combined patch text; redact each hunk on a hit so the
      // per-hunk mapping to the model is preserved (redact-and-send).
      const combined = diff.hunks.map((h) => h.patch).join("\n")
      const leaking = !hasNoLeakingPii(combined)
      if (leaking) toast.warning(t("review.ai.redacted"))
      const hunks = diff.hunks.map((h) => ({
        patch: leaking ? redactText(h.patch).redacted : h.patch,
      }))

      const client = buildUtilityLlmClient({
        session: null,
        appSettings: settings,
        override: { providerOverride: config.providerOverride, model: config.model },
        featureId: "git.reviewDiff",
      })
      if (!client) {
        toast.error(t("review.ai.failed"))
        return null
      }

      const findings = await generateDiffReview(
        {
          file: { path: change.path, status: change.status },
          hunks,
          config: { customInstructions: config.customInstructions },
        },
        client
      )

      // Replace any prior AI findings for this file, then write the new set.
      const reviewKey = normalizeReviewKey(change)
      clearAiFindings(rootDir, reviewKey)
      for (const f of findings) {
        const index = f.hunk - 1
        const hunk = diff.hunks[index]
        if (!hunk) continue
        setAiFinding(rootDir, reviewKey, index, hunkContentHash(hunk), {
          severity: f.severity,
          note: f.note,
        })
      }

      if (findings.length === 0) toast.info(t("review.ai.noFindings"))
      return findings.length
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t("review.ai.failed"))
      return null
    } finally {
      setReviewing(false)
    }
  }, [rootDir, change, diff, settings, config, setAiFinding, clearAiFindings, t])

  return { reviewing, error, review }
}
