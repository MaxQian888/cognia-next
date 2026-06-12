"use client"

/**
 * Top-level twin workbench. Renders four tabs:
 *
 *   • Sources  — registered raw artefacts (upload + status badges)
 *   • Jobs     — ingest / distill jobs in flight or recently finished
 *   • Drafts   — synth output queue, sorted with low-quality first
 *   • Settings — twin-level config (vector backend, RAG topK, etc.)
 *
 * The panel selects the active twin from a hook-derived list of distinct
 * `twinId`s seen across the user's characters. Single-twin users see no
 * chooser; multi-twin users get a select at the top.
 *
 * Tab state syncs to the URL `?tab=...` so refreshing or sharing a deep
 * link lands the user on the same view. The empty-state and worker-status
 * strings use next-intl so the page behaves the same in zh-CN as it does
 * in en.
 */

import { Suspense, useCallback, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listCharacters } from "@/lib/db/characters"
import { TwinSourcesTab } from "./twin-sources-tab"
import { TwinJobsTab } from "./twin-jobs-tab"
import { TwinDraftsTab } from "./twin-drafts-tab"
import { TwinPersonaTab } from "./twin-persona-tab"
import { TwinSettingsTab } from "./twin-settings-tab"
import { useTwinWorkerStatus } from "./use-twin-worker"

type TabKey = "sources" | "jobs" | "drafts" | "persona" | "settings"
const VALID_TABS: TabKey[] = ["sources", "jobs", "drafts", "persona", "settings"]

interface KnownTwin {
  twinId: string
  displayName: string
}

function useKnownTwins(): KnownTwin[] {
  const characters = useLiveQuery(() => listCharacters(), [], [])
  return useMemo(() => {
    const seen = new Map<string, KnownTwin>()
    for (const character of characters) {
      const twinId = character.twinId
      if (!twinId) continue
      if (!seen.has(twinId)) {
        seen.set(twinId, { twinId, displayName: character.name || twinId })
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [characters])
}

/**
 * The main entry point. Wraps the actual panel in a `<Suspense>` boundary
 * because `useSearchParams` requires it under Next 16 with `output: "export"`.
 */
export function TwinPanel() {
  return (
    <Suspense fallback={null}>
      <TwinPanelInner />
    </Suspense>
  )
}

function TwinPanelInner() {
  const t = useTranslations("twin.panel")
  const twins = useKnownTwins()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Resolve the active twin id: prefer ?twinId=…, else fall back to the
  // first known twin. Lets characters/the binding deep-link straight into
  // their twin's workbench.
  const requestedTwinId = searchParams?.get("twinId") ?? null
  const [activeTwinId, setActiveTwinId] = useState<string | null>(null)
  const effectiveTwinId =
    activeTwinId ??
    (requestedTwinId && twins.some((t) => t.twinId === requestedTwinId) ? requestedTwinId : null) ??
    twins[0]?.twinId ??
    null

  // Local state drives the active tab so clicks render synchronously, even
  // when the router mock in tests no-ops `replace`. Initial value comes from
  // the URL so deep links land on the right tab; subsequent writes mirror
  // back to the URL for shareability.
  const [tab, setTabState] = useState<TabKey>((): TabKey => {
    const fromUrl = (searchParams?.get("tab") ?? "sources") as TabKey
    return VALID_TABS.includes(fromUrl) ? fromUrl : "sources"
  })

  const setTab = useCallback(
    (next: string) => {
      const tabKey = (VALID_TABS.includes(next as TabKey) ? next : "sources") as TabKey
      setTabState(tabKey)
      const params = new URLSearchParams(searchParams?.toString() ?? "")
      params.set("tab", tabKey)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  // External URL changes (back/forward, shared link opened in same tab)
  // drive the local state — render-time setState gated on a prev tracker.
  const urlTab = searchParams?.get("tab") as TabKey | null
  const [prevUrlTab, setPrevUrlTab] = useState(urlTab)
  if (prevUrlTab !== urlTab) {
    setPrevUrlTab(urlTab)
    if (urlTab && VALID_TABS.includes(urlTab) && urlTab !== tab) {
      setTabState(urlTab)
    }
  }

  // Status-only — the actual job worker runs app-wide via
  // `TwinWorkerInitializer` (mounted in the root layout), so the workbench
  // doesn't start its own loop. This just reports whether that worker is live
  // for the active twin.
  const workerStatus = useTwinWorkerStatus(effectiveTwinId)

  if (!effectiveTwinId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="max-w-md p-8 text-center">
          <h2 className="mb-2 text-xl font-semibold">{t("noTwinTitle")}</h2>
          <p className="text-muted-foreground text-sm">{t("noTwinHint")}</p>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4 sm:gap-4 sm:p-6">
      <header className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <h1 className="text-xl font-semibold">{t("title")}</h1>
          {twins.length > 1 ? (
            <Select value={effectiveTwinId} onValueChange={setActiveTwinId}>
              <SelectTrigger size="sm" aria-label={t("activeTwin")} className="max-w-[14rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {twins.map((tw) => (
                  <SelectItem key={tw.twinId} value={tw.twinId}>
                    {tw.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-muted-foreground text-sm">{twins[0].displayName}</span>
          )}
        </div>
        <span
          className={
            workerStatus.active
              ? "text-xs text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground text-xs"
          }
          title={workerStatus.reasonKey ? t(`workerStatus.${workerStatus.reasonKey}`) : undefined}
        >
          {workerStatus.active ? t("workerActive") : t("workerIdle")}
        </span>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="flex flex-1 flex-col">
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="sources">{t("tabs.sources")}</TabsTrigger>
            <TabsTrigger value="jobs">{t("tabs.jobs")}</TabsTrigger>
            <TabsTrigger value="drafts">{t("tabs.drafts")}</TabsTrigger>
            <TabsTrigger value="persona">{t("tabs.persona")}</TabsTrigger>
            <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="sources" className="mt-3 flex-1 overflow-auto">
          <AnimatedTabContent tabKey={tab} active="sources">
            <TwinSourcesTab twinId={effectiveTwinId} />
          </AnimatedTabContent>
        </TabsContent>
        <TabsContent value="jobs" className="mt-3 flex-1 overflow-auto">
          <AnimatedTabContent tabKey={tab} active="jobs">
            <TwinJobsTab twinId={effectiveTwinId} />
          </AnimatedTabContent>
        </TabsContent>
        <TabsContent value="drafts" className="mt-3 flex-1 overflow-auto">
          <AnimatedTabContent tabKey={tab} active="drafts">
            <TwinDraftsTab twinId={effectiveTwinId} />
          </AnimatedTabContent>
        </TabsContent>
        <TabsContent value="persona" className="mt-3 flex-1 overflow-auto">
          <AnimatedTabContent tabKey={tab} active="persona">
            <TwinPersonaTab twinId={effectiveTwinId} />
          </AnimatedTabContent>
        </TabsContent>
        <TabsContent value="settings" className="mt-3 flex-1 overflow-auto">
          <AnimatedTabContent tabKey={tab} active="settings">
            <TwinSettingsTab twinId={effectiveTwinId} />
          </AnimatedTabContent>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/**
 * Fade tab content in when it becomes the active tab. Suppresses motion when
 * the OS reports `prefers-reduced-motion`. The `key` swap forces a fresh
 * animation each time the user lands on this tab.
 */
function AnimatedTabContent({
  tabKey,
  active,
  children,
}: {
  tabKey: string
  active: string
  children: React.ReactNode
}) {
  const prefersReducedMotion = useReducedMotion()
  if (prefersReducedMotion || tabKey !== active) {
    return <>{children}</>
  }
  return (
    <motion.div
      key={active}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  )
}
