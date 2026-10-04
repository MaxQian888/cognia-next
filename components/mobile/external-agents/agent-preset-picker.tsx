"use client"

/**
 * Step one of adding an external agent on the phone: choose what to add.
 *
 * A grid of cards rather than the desktop's preset dropdown. On a phone the
 * dropdown was a small control above a wall of protocol, transport and
 * command fields, so the one decision most people need to make looked like
 * the least important thing on the screen. Here it is the whole screen, and
 * every technical field waits on the next step behind "Advanced settings".
 */

import { useMemo, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { PlusIcon, SearchIcon, ServerIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { BrandIcon } from "@/components/icons/brand-icon"
import { RuntimeDetectionBadge } from "@/components/agent/external-agent/runtime-detection-badge"
import {
  presetDescription,
  presetName,
} from "@/components/agent/external-agent/add-agent/preset-copy"
import { useInstalledAgentRuntimes } from "@/hooks/agent/use-installed-agent-runtimes"
import type { InstalledRuntime } from "@/lib/ai/agent/external/config/installed-runtimes"
import { cn } from "@/lib/utils"

import { groupPresetEntries, runnablePresetEntries, type PresetEntry } from "./preset-catalog"
import { configureExternalAgentHref } from "./routes"

const CARD_CLASS =
  "flex flex-col gap-2 rounded-xl border bg-card p-3 text-left transition-colors active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

function PresetCard({
  entry,
  detection,
}: {
  entry: PresetEntry
  detection: InstalledRuntime | undefined
}) {
  return (
    <Link
      href={configureExternalAgentHref(entry.id)}
      className={CARD_CLASS}
      data-testid={`agent-preset-${entry.id}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <BrandIcon id={entry.id} size={28} label={entry.name} />
        {/* Two lines rather than an ellipsis: on a two-column phone grid a
            truncated "Codex (app-s…" is not a name anyone can pick from. */}
        <span className="line-clamp-2 min-w-0 text-sm leading-snug font-medium break-words">
          {entry.name}
        </span>
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
      {detection ? (
        <div className="mt-auto">
          <RuntimeDetectionBadge detection={detection} />
        </div>
      ) : null}
    </Link>
  )
}

function PresetGroup({
  title,
  entries,
  forPreset,
  children,
  testid,
}: {
  title: string
  entries: PresetEntry[]
  forPreset: (id: string) => InstalledRuntime | undefined
  children?: React.ReactNode
  testid: string
}) {
  if (entries.length === 0 && !children) return null
  return (
    <section className="flex flex-col gap-2" data-testid={testid}>
      <h2 className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="grid grid-cols-2 gap-2">
        {entries.map((entry) => (
          <PresetCard key={entry.id} entry={entry} detection={forPreset(entry.id)} />
        ))}
        {children}
      </div>
    </section>
  )
}

export function AgentPresetPicker() {
  const t = useTranslations("mobile.externalAgents")
  const tSettings = useTranslations("externalAgent.settings")
  // Detection asks the Host what it has installed; the answer orders the grid.
  const detection = useInstalledAgentRuntimes(true)
  const [query, setQuery] = useState("")

  const entries = useMemo(
    () =>
      runnablePresetEntries((id, preset) => ({
        name: presetName(tSettings, id, preset),
        description: presetDescription(tSettings, id, preset),
      })),
    [tSettings]
  )
  const { installed, others } = groupPresetEntries(entries, detection.forPreset, query)
  const trimmed = query.trim()
  const nothingMatches = trimmed !== "" && installed.length === 0 && others.length === 0

  return (
    <div className="flex flex-col gap-5" data-testid="agent-preset-picker">
      <div className="flex flex-col gap-3">
        <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
          <ServerIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("pickIntro")}
        </p>
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchAria")}
            className="h-10 pl-9"
            data-testid="agent-preset-search"
          />
        </div>
      </div>

      <PresetGroup
        title={t("detectedSection")}
        entries={installed}
        forPreset={detection.forPreset}
        testid="agent-preset-group-installed"
      />
      <PresetGroup
        title={t("allSection")}
        entries={others}
        forPreset={detection.forPreset}
        testid="agent-preset-group-all"
      >
        {/* Custom stays reachable during a search: "nothing matches" is
            exactly when someone needs to describe the agent themselves. */}
        <Link
          href={configureExternalAgentHref("custom")}
          className={cn(CARD_CLASS, "border-dashed bg-transparent")}
          data-testid="agent-preset-custom"
        >
          <div className="flex items-center gap-2">
            <span className="inline-flex size-7 items-center justify-center rounded-md bg-muted">
              <PlusIcon className="size-4" aria-hidden />
            </span>
            <span className="text-sm font-medium">{t("customTitle")}</span>
          </div>
          <p className="line-clamp-3 text-xs text-muted-foreground">{t("customDescription")}</p>
        </Link>
      </PresetGroup>

      {nothingMatches ? (
        <p className="px-1 text-center text-xs text-muted-foreground" role="status">
          {t("noMatches", { query: trimmed })}
        </p>
      ) : null}
    </div>
  )
}
