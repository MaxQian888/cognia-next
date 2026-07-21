"use client"

/**
 * ArtifactTabStrip — the open-artifact tabs that sit at the left of the dock's
 * workbench header.
 *
 * It carries no layout state of its own. Each artifact's workbench scope is
 * already keyed `…::artifact:{id}`, so switching tabs restores that artifact's
 * own active panel and width for free.
 *
 * Lives *inside* the existing header rather than above it: the dock is often
 * only ~34% of the window, and a third horizontal band would cost content room
 * the panels need more.
 */

import { XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { getArtifactTypeIcon } from "./artifact-icons"

/**
 * Ids worth showing as tabs. An id can outlive its artifact (LRU eviction on
 * persist, or a delete in another tab), and a lone tab is just a label for the
 * panel already on screen — so below two, there is nothing to show.
 *
 * Hosts call this to decide whether to hand the strip to the workbench header
 * at all: passing an element that renders `null` would still read as "the host
 * occupied this slot" and needlessly displace the panel's own tabs.
 */
export function useOpenArtifactTabs(): string[] {
  const openArtifactIds = useArtifactStore((state) => state.openArtifactIds)
  const artifacts = useArtifactStore((state) => state.artifacts)
  const tabs = openArtifactIds.filter((id) => artifacts[id])
  return tabs.length < 2 ? EMPTY_TABS : tabs
}

const EMPTY_TABS: string[] = []

export function ArtifactTabStrip({ className }: { className?: string }) {
  const t = useTranslations("artifacts")
  const artifacts = useArtifactStore((state) => state.artifacts)
  const activeArtifactId = useArtifactStore((state) => state.activeArtifactId)
  const setActiveArtifact = useArtifactStore((state) => state.setActiveArtifact)
  const closeArtifact = useArtifactStore((state) => state.closeArtifact)
  const tabs = useOpenArtifactTabs()

  if (tabs.length === 0) return null

  return (
    <div
      role="tablist"
      aria-label={t("dock.openArtifacts")}
      data-testid="artifact-tab-strip"
      className={cn("flex min-w-0 items-center gap-0.5 overflow-x-auto", className)}
    >
      {tabs.map((id) => {
        const artifact = artifacts[id]
        const active = id === activeArtifactId
        return (
          <div
            key={id}
            className={cn(
              "group flex min-w-0 shrink items-center gap-1 rounded-md pr-0.5 pl-1.5",
              active ? "bg-secondary" : "hover:bg-accent/50"
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`artifact-tab-${id}`}
              className="flex min-w-0 items-center gap-1.5 py-1 text-xs"
              onClick={() => setActiveArtifact(id)}
            >
              <span className="shrink-0 text-muted-foreground">
                {getArtifactTypeIcon(artifact.type)}
              </span>
              <span className="max-w-28 truncate">{artifact.title}</span>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("dock.closeTab", { title: artifact.title })}
              data-testid={`artifact-tab-close-${id}`}
              className="size-5 shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              onClick={() => closeArtifact(id)}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}

export default ArtifactTabStrip
