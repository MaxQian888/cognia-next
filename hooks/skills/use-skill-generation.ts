"use client"

/**
 * useSkillGeneration — turn a recording trace into a Skill draft via the utility
 * LLM. Resolves the model through `buildUtilityLlmClient` (honors the app's
 * provider/model default, works across providers). The pure generator
 * (`generateSkillFromTrace`) owns the PII gate; this hook owns model resolution,
 * loading state, and user-facing toasts.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { generateSkillFromTrace, type SkillGenerationDraft } from "@/lib/skills/generate-from-trace"
import type { RecordingTrace } from "@/lib/skills/recording/types"
import { useSettingsStore } from "@/stores/settings/settings-store"

export interface UseSkillGeneration {
  generating: boolean
  generate: (trace: RecordingTrace) => Promise<SkillGenerationDraft | null>
}

export function useSkillGeneration(): UseSkillGeneration {
  const t = useTranslations("skills")
  const [generating, setGenerating] = useState(false)
  const settings = useSettingsStore((s) => s.settings)

  const generate = useCallback(
    async (trace: RecordingTrace): Promise<SkillGenerationDraft | null> => {
      setGenerating(true)
      try {
        const client = buildUtilityLlmClient({
          session: null,
          appSettings: settings,
          featureId: "skills.recorder",
        })
        if (!client) {
          toast.error(t("recorder.generateFailed"))
          return null
        }
        const { draft, redacted } = await generateSkillFromTrace(trace, client)
        if (redacted) toast.warning(t("recorder.redacted"))
        return draft
      } catch {
        toast.error(t("recorder.generateFailed"))
        return null
      } finally {
        setGenerating(false)
      }
    },
    [settings, t]
  )

  return { generating, generate }
}
