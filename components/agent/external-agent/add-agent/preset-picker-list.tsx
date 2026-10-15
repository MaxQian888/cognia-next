"use client"

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, SearchIcon } from "lucide-react"

import { BrandIcon } from "@/components/icons/brand-icon"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RuntimeDetectionBadge } from "@/components/agent/external-agent/runtime-detection-badge"
import { useInstalledAgentRuntimes } from "@/hooks/agent/use-installed-agent-runtimes"
import { resolvePreferredCodexExecutablePresetId } from "@/lib/ai/agent/external/config/presets"
import { availablePresetEntries, groupPresetEntries, type PresetEntry } from "./preset-catalog"
import { presetDescription, presetName, supportTierLabel } from "./preset-copy"

export interface PresetPickerListProps {
  onPick: (presetId: string) => void
  disabled?: boolean
  autoFocusSearch?: boolean
}

const ROW_CLASS =
  "flex w-full min-w-0 items-start gap-3 px-1 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"

export function PresetPickerList({
  onPick,
  disabled = false,
  autoFocusSearch = false,
}: PresetPickerListProps) {
  const t = useTranslations("externalAgent.picker")
  const tSettings = useTranslations("externalAgent.settings")
  const tTier = useTranslations("externalAgent.supportTier")
  const detection = useInstalledAgentRuntimes(true)
  const [query, setQuery] = useState("")
  const [showExperimental, setShowExperimental] = useState(false)
  const [preferredCodexPreset, setPreferredCodexPreset] = useState("codex")
  const experimentalId = useId()
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    void resolvePreferredCodexExecutablePresetId().then((id) => {
      if (active) setPreferredCodexPreset(id)
    })
    return () => {
      active = false
    }
  }, [])

  const entries = useMemo(
    () =>
      availablePresetEntries((id, preset) => ({
        name: presetName(tSettings, id, preset),
        description: presetDescription(tSettings, id, preset),
      })),
    [tSettings]
  )
  const groups = groupPresetEntries(entries, detection.forPreset, query)
  const visibleCount =
    groups.installed.length +
    groups.others.length +
    (showExperimental ? groups.experimental.length : 0)

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const rows = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-preset-row]:not(:disabled)"
      ) ?? []
    )
    const index = rows.indexOf(event.currentTarget)
    if (index === -1 || rows.length === 0) return
    event.preventDefault()
    rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus()
  }

  function renderGroup(title: string, groupEntries: PresetEntry[], group: string) {
    if (groupEntries.length === 0) return null
    return (
      <section className="min-w-0" data-testid={`preset-group-${group}`}>
        <h3 className="py-2 text-xs font-medium text-muted-foreground">{title}</h3>
        <ul className="divide-y" aria-label={title}>
          {groupEntries.map((entry) => {
            const runtime = detection.forPreset(entry.id)
            const experimental = entry.preset.supportTier === "documented-only"
            const reasonId = `${experimentalId}-${entry.id}-reason`
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  className={ROW_CLASS}
                  data-preset-row
                  data-testid={`preset-pick-${entry.id}`}
                  disabled={disabled || experimental}
                  aria-describedby={experimental ? reasonId : undefined}
                  onClick={() => onPick(entry.id)}
                  onKeyDown={moveFocus}
                >
                  <span className="shrink-0 pt-0.5">
                    <BrandIcon id={entry.id} size={24} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="break-words text-sm font-medium">{entry.name}</span>
                      {entry.id === preferredCodexPreset &&
                      ["codex", "codex-app-server"].includes(entry.id) ? (
                        <Badge
                          className="text-[10px]"
                          data-testid={`preset-recommended-${entry.id}`}
                        >
                          {tSettings("recommendedPreset")}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">
                      {entry.description}
                    </span>
                    {experimental ? (
                      <span id={reasonId} className="mt-1 block text-xs text-muted-foreground">
                        {t("experimentalReason")}
                      </span>
                    ) : null}
                    {/* Facts sit under the description and wrap, rather than a
                        right-hand column that stacked three badges per row. An
                        unknown detection draws nothing here: when this device
                        cannot ask at all, the list says so once, above. */}
                    {entry.preset.supportTier || runtime ? (
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {entry.preset.supportTier ? (
                          <Badge
                            variant={experimental ? "destructive" : "outline"}
                            className="text-[10px] font-normal"
                          >
                            {supportTierLabel(tTier, entry.preset.supportTier)}
                          </Badge>
                        ) : null}
                        <RuntimeDetectionBadge detection={runtime} />
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    )
  }

  return (
    <div ref={rootRef} className="min-w-0 space-y-3" data-testid="preset-picker-list">
      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchAria")}
          className="pl-9"
          disabled={disabled}
          autoFocus={autoFocusSearch}
        />
      </div>
      {detection.loading ? (
        <p
          className="text-xs text-muted-foreground"
          role="status"
          data-testid="preset-detection-checking"
        >
          {t("detectionChecking")}
        </p>
      ) : detection.unavailable ? (
        <p className="text-xs text-muted-foreground" data-testid="preset-detection-unavailable">
          {t("detectionUnavailable")}
        </p>
      ) : null}
      {renderGroup(t("detectedSection"), groups.installed, "installed")}
      {renderGroup(t("availableSection"), groups.others, "available")}
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={experimentalId} className="text-xs text-muted-foreground">
          {tSettings("showExperimental")}
        </Label>
        <Switch
          id={experimentalId}
          checked={showExperimental}
          onCheckedChange={setShowExperimental}
          disabled={disabled}
        />
      </div>
      {showExperimental
        ? renderGroup(t("experimentalSection"), groups.experimental, "experimental")
        : null}
      {visibleCount === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("noMatches", { query: query.trim() })}
        </p>
      ) : null}
      <ul className="divide-y border-t">
        <li>
          <button
            type="button"
            className={ROW_CLASS}
            data-preset-row
            data-testid="preset-pick-custom"
            disabled={disabled}
            onClick={() => onPick("custom")}
            onKeyDown={moveFocus}
          >
            <PlusIcon className="size-6 shrink-0" aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t("customTitle")}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {t("customDescription")}
              </span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  )
}
