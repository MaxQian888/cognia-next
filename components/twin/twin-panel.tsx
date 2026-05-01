"use client"

/**
 * Top-level twin workbench. Renders four tabs:
 *
 *   • Sources  — registered raw artefacts (upload + status badges)
 *   • Jobs     — ingest / distill jobs in flight or recently finished
 *   • Drafts   — synth output queue, sorted with low-quality first
 *   • Settings — twin-level config (vector backend, RAG topK, etc.)
 *
 * The panel selects the active twin from a hook-derived list of
 * distinct `twinId`s seen across the user's characters. Single-twin
 * users see no chooser; multi-twin users get a select at the top.
 */

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card } from "@/components/ui/card"
import { listCharacters } from "@/lib/db/characters"
import { TwinSourcesTab } from "./twin-sources-tab"
import { TwinJobsTab } from "./twin-jobs-tab"
import { TwinDraftsTab } from "./twin-drafts-tab"
import { TwinSettingsTab } from "./twin-settings-tab"
import { useTwinWorker } from "./use-twin-worker"

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

export function TwinPanel() {
  const twins = useKnownTwins()
  const [activeTwinId, setActiveTwinId] = useState<string | null>(null)
  const effectiveTwinId = activeTwinId ?? twins[0]?.twinId ?? null

  // Side-effect: spin up the job worker against the active twin's runtime
  // settings. Called UNCONDITIONALLY (rules-of-hooks); the hook itself
  // short-circuits on a null twinId.
  const workerStatus = useTwinWorker(effectiveTwinId)

  if (!effectiveTwinId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="max-w-md p-8 text-center">
          <h2 className="mb-2 text-xl font-semibold">No digital twins yet</h2>
          <p className="text-muted-foreground text-sm">
            Bind a character to a twin via its settings to start ingesting documents, chats, and
            code. Every twin lives alongside its character — there is no separate identity to create
            up front.
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">Digital twin</h1>
          {twins.length > 1 ? (
            <select
              className="border-border bg-background rounded border px-2 py-1 text-sm"
              value={effectiveTwinId}
              onChange={(e) => setActiveTwinId(e.target.value)}
              aria-label="Active twin"
            >
              {twins.map((t) => (
                <option key={t.twinId} value={t.twinId}>
                  {t.displayName}
                </option>
              ))}
            </select>
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
          title={workerStatus.reason}
        >
          worker {workerStatus.active ? "● active" : "○ idle"}
        </span>
      </header>

      <Tabs defaultValue="sources" className="flex flex-1 flex-col">
        <TabsList className="self-start">
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="drafts">Drafts</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="sources" className="mt-3 flex-1 overflow-auto">
          <TwinSourcesTab twinId={effectiveTwinId} />
        </TabsContent>
        <TabsContent value="jobs" className="mt-3 flex-1 overflow-auto">
          <TwinJobsTab twinId={effectiveTwinId} />
        </TabsContent>
        <TabsContent value="drafts" className="mt-3 flex-1 overflow-auto">
          <TwinDraftsTab twinId={effectiveTwinId} />
        </TabsContent>
        <TabsContent value="settings" className="mt-3 flex-1 overflow-auto">
          <TwinSettingsTab twinId={effectiveTwinId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
