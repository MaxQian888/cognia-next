"use client"

/**
 * Settings → Source Control. Currently hosts the AI commit-message generation
 * preferences (enable, Conventional Commits constraint, custom instructions).
 * Future git panel preferences land here too.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { GitBranchIcon, RotateCcwIcon, SlidersHorizontalIcon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_GIT_SETTINGS, type GitCommitAiSettings } from "@/types/git"
import {
  AUTO_FETCH_INTERVAL_MAX,
  AUTO_FETCH_INTERVAL_MIN,
  clampAutoFetchInterval,
  type BranchSortMode,
  type DiffViewMode,
  type PostCommitAction,
  type TimelineDefaultView,
} from "@/lib/git/panel-prefs"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"
import { SettingsCard } from "../common/settings-section"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
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

/** A labeled on/off row: title + helper text left, Switch right. */
function SwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} aria-label={label} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

export function GitSection() {
  const t = useTranslations("settings.sourceControl")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const {
    prefs,
    setDiffView,
    setIgnoreWhitespace,
    setConfirmDiscard,
    setConfirmForcePush,
    setSmartCommit,
    setPostCommit,
    setPullRebase,
    setFetchPrune,
    setAutoFetch,
    setAutoFetchInterval,
    setBranchSort,
    setDefaultTimelineView,
    isDefault,
    reset,
  } = useSourceControlPrefs()

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
    <>
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
                  onChange={(e) =>
                    saveCommitAi({ customInstructions: e.target.value || undefined })
                  }
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

      <SettingsCard
        icon={<SlidersHorizontalIcon className="size-5" />}
        title={t("panel.title")}
        description={t("panel.description")}
      >
        <section className="space-y-5">
          {/* Diff presentation */}
          <div className="space-y-1.5">
            <Label htmlFor="git-diff-view">{t("panel.diffView.label")}</Label>
            <Select
              value={prefs.diffView}
              onValueChange={(v) => void setDiffView(v as DiffViewMode)}
            >
              <SelectTrigger id="git-diff-view" data-testid="git-diff-view">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sideBySide">{t("panel.diffView.sideBySide")}</SelectItem>
                <SelectItem value="inline">{t("panel.diffView.inline")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <SwitchRow
            id="git-ignore-whitespace"
            label={t("panel.ignoreWhitespace.label")}
            description={t("panel.ignoreWhitespace.description")}
            checked={prefs.ignoreWhitespace}
            onCheckedChange={(v) => void setIgnoreWhitespace(v)}
          />

          <Separator />

          {/* Guardrails */}
          <SwitchRow
            id="git-confirm-discard"
            label={t("panel.confirmDiscard.label")}
            description={t("panel.confirmDiscard.description")}
            checked={prefs.confirmDiscard}
            onCheckedChange={(v) => void setConfirmDiscard(v)}
          />
          <SwitchRow
            id="git-confirm-force-push"
            label={t("panel.confirmForcePush.label")}
            description={t("panel.confirmForcePush.description")}
            checked={prefs.confirmForcePush}
            onCheckedChange={(v) => void setConfirmForcePush(v)}
          />

          <Separator />

          {/* Commit automation */}
          <SwitchRow
            id="git-smart-commit"
            label={t("panel.smartCommit.label")}
            description={t("panel.smartCommit.description")}
            checked={prefs.smartCommit}
            onCheckedChange={(v) => void setSmartCommit(v)}
          />
          <div className="space-y-1.5">
            <Label htmlFor="git-post-commit">{t("panel.postCommit.label")}</Label>
            <p className="text-sm text-muted-foreground">{t("panel.postCommit.description")}</p>
            <Select
              value={prefs.postCommit}
              onValueChange={(v) => void setPostCommit(v as PostCommitAction)}
            >
              <SelectTrigger id="git-post-commit" data-testid="git-post-commit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("panel.postCommit.none")}</SelectItem>
                <SelectItem value="push">{t("panel.postCommit.push")}</SelectItem>
                <SelectItem value="sync">{t("panel.postCommit.sync")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* Network defaults */}
          <SwitchRow
            id="git-pull-rebase"
            label={t("panel.pullRebase.label")}
            description={t("panel.pullRebase.description")}
            checked={prefs.pullRebase}
            onCheckedChange={(v) => void setPullRebase(v)}
          />
          <SwitchRow
            id="git-fetch-prune"
            label={t("panel.fetchPrune.label")}
            description={t("panel.fetchPrune.description")}
            checked={prefs.fetchPrune}
            onCheckedChange={(v) => void setFetchPrune(v)}
          />
          <SwitchRow
            id="git-auto-fetch"
            label={t("panel.autoFetch.label")}
            description={t("panel.autoFetch.description")}
            checked={prefs.autoFetch}
            onCheckedChange={(v) => void setAutoFetch(v)}
          />
          {prefs.autoFetch && (
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <Label htmlFor="git-auto-fetch-interval">{t("panel.autoFetch.interval")}</Label>
              <Input
                id="git-auto-fetch-interval"
                type="number"
                min={AUTO_FETCH_INTERVAL_MIN}
                max={AUTO_FETCH_INTERVAL_MAX}
                value={prefs.autoFetchIntervalMinutes}
                onChange={(e) =>
                  void setAutoFetchInterval(clampAutoFetchInterval(e.target.valueAsNumber))
                }
                className="w-24"
                data-testid="git-auto-fetch-interval"
              />
            </div>
          )}

          <Separator />

          {/* List / history */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="git-branch-sort">{t("panel.branchSort.label")}</Label>
              <Select
                value={prefs.branchSort}
                onValueChange={(v) => void setBranchSort(v as BranchSortMode)}
              >
                <SelectTrigger id="git-branch-sort" data-testid="git-branch-sort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t("panel.branchSort.default")}</SelectItem>
                  <SelectItem value="name">{t("panel.branchSort.name")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="git-timeline-view">{t("panel.timelineView.label")}</Label>
              <Select
                value={prefs.defaultTimelineView}
                onValueChange={(v) => void setDefaultTimelineView(v as TimelineDefaultView)}
              >
                <SelectTrigger id="git-timeline-view" data-testid="git-timeline-view">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="list">{t("panel.timelineView.list")}</SelectItem>
                  <SelectItem value="graph">{t("panel.timelineView.graph")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          <Button
            variant="ghost"
            size="sm"
            className="justify-center"
            disabled={isDefault}
            onClick={() => void reset()}
            data-testid="git-panel-reset"
          >
            <RotateCcwIcon className="size-3.5" />
            {t("panel.reset")}
          </Button>
        </section>
      </SettingsCard>
    </>
  )
}
