"use client"

/**
 * An agent's Harness Evolution page (the agents console's `evolve` mode):
 * its runs with the viewer beside them, its harness versions, and the
 * lessons the library holds for it. Starting a run opens the start dialog.
 *
 * Off unless enabled in Settings; a client whose host owns the
 * conversations cannot run probes, and says so instead of offering to.
 */

import { useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { DnaIcon, PlusIcon } from "lucide-react"
import type { Character } from "@cognia/agent-config-types"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useHarnessEvolutionSettings, useHarnessRuns } from "@/hooks/harness/use-harness-data"
import { useCapability } from "@/hooks/use-host-profile"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { hostOwnsSessionState } from "@/lib/db/mobile-outbound-queue"
import { unsupportedReason } from "@/lib/harness/runtime/capture"
import { settingsHref } from "@/lib/settings/deep-link"
import { HarnessExperienceLibrary } from "./harness-experience-library"
import { HarnessRunList } from "./harness-run-list"
import { HarnessRunViewer } from "./harness-run-viewer"
import { HarnessStartRunDialog } from "./harness-start-run-dialog"
import { HarnessVersionHistory } from "./harness-version-history"

export interface AgentEvolutionViewProps {
  agent: Character
  /** Whether the agent's own row can be written (not built-in or plugin-owned). */
  editable: boolean
  /** Open on this run. */
  initialRunId?: string
}

/** Why runs cannot start here, or null when they can. */
export function useEvolutionBlocker(
  agent: Character
): "disabled" | "host-owned" | "no-runtime" | "external" | null {
  const settings = useHarnessEvolutionSettings()
  const snapshot = useRuntimeSnapshot()
  const canRunAgents = useCapability("sidecar")
  if (!settings.enabled || settings.startMode === "disabled") return "disabled"
  if (hostOwnsSessionState(snapshot)) return "host-owned"
  if (!canRunAgents) return "no-runtime"
  if (unsupportedReason(agent)) return "external"
  return null
}

export function AgentEvolutionView({ agent, editable, initialRunId }: AgentEvolutionViewProps) {
  const t = useTranslations("harnessEvolution.agentView")
  const runs = useHarnessRuns(agent.id)
  const blocker = useEvolutionBlocker(agent)
  const [tab, setTab] = useState("runs")
  const [selectedRun, setSelectedRun] = useState<string | undefined>(initialRunId)
  const [focusExperience, setFocusExperience] = useState<string | undefined>()
  const [starting, setStarting] = useState(false)
  const activeRun = selectedRun ?? runs?.[0]?.id

  const openRun = (id: string) => {
    setSelectedRun(id)
    setTab("runs")
  }
  const openExperience = (id: string) => {
    setFocusExperience(id)
    setTab("experiences")
  }

  return (
    <div className="flex flex-col gap-4" data-testid="agent-evolution-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <DnaIcon className="size-4 text-muted-foreground" aria-hidden />
            {t("title")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          size="sm"
          disabled={blocker !== null}
          onClick={() => setStarting(true)}
          title={blocker ? t(`blocked.${blocker}`) : undefined}
          data-testid="harness-start-run"
        >
          <PlusIcon className="size-3.5" aria-hidden />
          {t("start")}
        </Button>
      </div>
      {blocker ? (
        <p
          className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
          data-testid="harness-blocker"
          data-blocker={blocker}
        >
          {t(`blocked.${blocker}`)}{" "}
          {blocker === "disabled" ? (
            <Link className="underline underline-offset-2" href={settingsHref("harness-evolution")}>
              {t("openSettings")}
            </Link>
          ) : null}
        </p>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="runs">{t("tabs.runs")}</TabsTrigger>
          <TabsTrigger value="versions">{t("tabs.versions")}</TabsTrigger>
          <TabsTrigger value="experiences">{t("tabs.experiences")}</TabsTrigger>
        </TabsList>
        <TabsContent value="runs" className="mt-3">
          {runs === undefined ? null : runs.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <DnaIcon />
                </EmptyMedia>
                <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
                <EmptyDescription>{t("emptyBody")}</EmptyDescription>
              </EmptyHeader>
              {blocker === null ? (
                <EmptyContent>
                  <Button size="sm" onClick={() => setStarting(true)}>
                    {t("start")}
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[18rem_1fr]">
              <HarnessRunList
                runs={runs}
                {...(activeRun ? { selectedId: activeRun } : {})}
                onSelect={setSelectedRun}
              />
              <div className="min-w-0">
                {activeRun ? (
                  <HarnessRunViewer
                    key={activeRun}
                    runId={activeRun}
                    onOpenExperience={openExperience}
                  />
                ) : null}
              </div>
            </div>
          )}
        </TabsContent>
        <TabsContent value="versions" className="mt-3">
          <HarnessVersionHistory
            characterId={agent.id}
            {...(agent.harness?.adoptedSnapshotId
              ? { adoptedSnapshotId: agent.harness.adoptedSnapshotId }
              : {})}
            editable={editable}
            onOpenRun={openRun}
          />
        </TabsContent>
        <TabsContent value="experiences" className="mt-3">
          <HarnessExperienceLibrary
            key={focusExperience ?? "all"}
            characterId={agent.id}
            {...(focusExperience ? { focusId: focusExperience } : {})}
            onOpenRun={openRun}
          />
        </TabsContent>
      </Tabs>

      <HarnessStartRunDialog
        open={starting}
        onOpenChange={setStarting}
        agent={agent}
        onStarted={openRun}
      />
    </div>
  )
}
