"use client"

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { MemoryConfig, MemoryScope } from "@/types/memory/memory"
import { GatedGroup, MemoryToggleRow } from "../memory-controls"

export interface LearningPanelProps {
  config: MemoryConfig
  update: (patch: Partial<MemoryConfig>) => void
}

export function LearningPanel({ config, update }: LearningPanelProps) {
  const t = useTranslations("settings.memory.learning")

  return (
    <div className="space-y-4">
      <MemoryToggleRow
        id="mem-learn"
        label={t("learnFromChats.label")}
        description={t("learnFromChats.description")}
        checked={config.learnFromChats}
        disabled={!config.enabled}
        onCheckedChange={(v) => update({ learnFromChats: v })}
      />

      <GatedGroup
        gated={!config.enabled || !config.learnFromChats}
        reason={!config.enabled ? t("gates.memoryOff") : t("gates.learningOff")}
        className="space-y-2 border-l-2 pl-3"
      >
        {/*
          `autoExtract` is not a duplicate of `learnFromChats`, despite the
          overlap: the former gates the runner (`run-memory-extraction.ts:78`
          and the session-distill worker), the latter gates policy
          (`resolveMemoryTurnPolicy`), which a single chat can override. Turning
          this off leaves `/remember` working — it deliberately ignores the flag.
        */}
        <MemoryToggleRow
          id="mem-auto-extract"
          label={t("autoExtract.label")}
          description={t("autoExtract.description")}
          checked={config.autoExtract}
          onCheckedChange={(v) => update({ autoExtract: v })}
        />

        <MemoryToggleRow
          id="mem-external-context"
          label={t("externalContext.label")}
          description={t("externalContext.description")}
          checked={config.disableLearningOnExternalContext}
          onCheckedChange={(v) => update({ disableLearningOnExternalContext: v })}
        />
      </GatedGroup>

      <div className="space-y-1.5">
        <Label htmlFor="mem-scope" className="text-sm font-medium">
          {t("scope.label")}
        </Label>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("scope.description")}
        </p>
        <Select
          value={config.scopeDefault}
          onValueChange={(v) => update({ scopeDefault: v as MemoryScope })}
        >
          <SelectTrigger id="mem-scope" className="w-full sm:w-72" aria-label={t("scope.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="global">{t("scope.options.global")}</SelectItem>
            <SelectItem value="workspace">{t("scope.options.workspace")}</SelectItem>
            <SelectItem value="character">{t("scope.options.character")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
