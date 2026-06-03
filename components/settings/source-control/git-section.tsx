"use client"

/**
 * Settings → Source Control. Currently hosts the AI commit-message generation
 * preferences (enable, Conventional Commits constraint, custom instructions).
 * Future git panel preferences land here too.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { GitBranchIcon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_GIT_SETTINGS, type GitCommitAiSettings } from "@/types/git"
import { SettingsCard } from "../common/settings-section"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const DEFAULT_PROVIDER_VALUE = "__default__"

export function GitSection() {
  const t = useTranslations("settings.sourceControl")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const commitAi = settings?.gitSettings?.commitMessageAI ?? DEFAULT_GIT_SETTINGS.commitMessageAI

  const providers = useMemo<{ id: string; name: string }[]>(() => {
    const map = new Map<string, { id: string; name: string }>()
    for (const id of Object.keys(settings?.providerSettings ?? {})) map.set(id, { id, name: id })
    for (const p of settings?.customProviders ?? []) {
      const cp = p as { id: string; name?: string }
      map.set(cp.id, { id: cp.id, name: cp.name ?? cp.id })
    }
    return [...map.values()]
  }, [settings?.providerSettings, settings?.customProviders])

  const saveCommitAi = (patch: Partial<GitCommitAiSettings>) =>
    void save({
      gitSettings: {
        ...settings?.gitSettings,
        commitMessageAI: { ...commitAi, ...patch },
      },
    })

  return (
    <SettingsCard
      icon={<GitBranchIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="git-ai-commit">{t("commitAi.heading")}</Label>
            <p className="text-sm text-muted-foreground">{t("commitAi.description")}</p>
          </div>
          <Switch
            id="git-ai-commit"
            aria-label={t("commitAi.heading")}
            checked={commitAi.enabled}
            onCheckedChange={(v) => saveCommitAi({ enabled: v })}
          />
        </div>

        {commitAi.enabled && (
          <div className="space-y-4 rounded-md border p-3">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="git-conventional">{t("commitAi.conventional.heading")}</Label>
                <p className="text-sm text-muted-foreground">
                  {t("commitAi.conventional.description")}
                </p>
              </div>
              <Switch
                id="git-conventional"
                aria-label={t("commitAi.conventional.heading")}
                checked={commitAi.conventionalCommits}
                onCheckedChange={(v) => saveCommitAi({ conventionalCommits: v })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="git-custom-instructions">
                {t("commitAi.customInstructions.heading")}
              </Label>
              <Textarea
                id="git-custom-instructions"
                rows={3}
                value={commitAi.customInstructions ?? ""}
                placeholder={t("commitAi.customInstructions.placeholder")}
                onChange={(e) => saveCommitAi({ customInstructions: e.target.value || undefined })}
                className="resize-none text-sm"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("commitAi.model.provider")}</Label>
                <Select
                  value={commitAi.providerOverride || DEFAULT_PROVIDER_VALUE}
                  onValueChange={(v) =>
                    saveCommitAi({
                      providerOverride: v === DEFAULT_PROVIDER_VALUE ? undefined : v,
                    })
                  }
                >
                  <SelectTrigger data-testid="git-ai-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_PROVIDER_VALUE}>
                      {t("commitAi.model.useDefault")}
                    </SelectItem>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="git-ai-model">{t("commitAi.model.model")}</Label>
                <Input
                  id="git-ai-model"
                  value={commitAi.model ?? ""}
                  placeholder={t("commitAi.model.useDefault")}
                  onChange={(e) => saveCommitAi({ model: e.target.value || undefined })}
                />
              </div>
            </div>
          </div>
        )}
      </section>
    </SettingsCard>
  )
}
