"use client"

import { createContext, useContext, useState } from "react"
import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"
import { useTranslations } from "next-intl"
import { Settings2Icon } from "lucide-react"
import { CompositionChip } from "@/components/agent/composition/composition-chip"
import { AgentRuntimeSelector } from "@/components/agent/mode/runtime-selector"
import { RoomParticipantsChip } from "@/components/chat/room-participants-chip"
import { SessionEnvironmentChip } from "@/components/chat/session-environment-chip"
import { SessionSettingsSheet } from "@/components/chat/session-settings-sheet"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useCharacter } from "@/lib/data-hooks/context"
import { useSessionErrorMessage, useSessionPendingApprovals, useSessionStatus } from "@/stores/chat"
import { useAskUserStore } from "@/stores/agent/ask-user-store"
import { useSessionPendingElicitation } from "@/stores/agent/external-elicitation-store"
import { ContextMetadataPanel } from "./context-metadata-panel"
import { SessionCapabilitiesSection } from "./session-capabilities-section"
import { SessionOpenItems } from "./session-open-items"
import { SessionResultsSection } from "./session-results-section"
import { SessionStatusRail } from "./session-status-rail"

export interface SessionOverviewPanelProps {
  session: ChatSession
  messages: readonly UIMessage[]
  messageCount: number
  onNavigate: (panelId: string) => void
}

// The Workbench treats renderer functions as component types. Keep this host
// stable while its provider updates, preserving open controls during live queries.
export const SessionOverviewContext = createContext<SessionOverviewPanelProps | null>(null)

export function SessionOverviewPanelHost() {
  const props = useContext(SessionOverviewContext)
  return props ? <SessionOverviewPanel key={props.session.id} {...props} /> : null
}

/** Shared session-scoped state for the summary and detailed overview. */
export function useSessionOverviewState(sessionId: string) {
  const status = useSessionStatus(sessionId)
  const approvals = useSessionPendingApprovals(sessionId)
  const question = useSessionPendingElicitation(sessionId)
  const pendingAsk = useAskUserStore(
    (state) =>
      state.active?.sessionId === sessionId ||
      state.queue.some((entry) => entry.sessionId === sessionId)
  )
  const error = useSessionErrorMessage(sessionId)
  const needsResponse =
    approvals.some((approval) => approval.status !== "interrupted") ||
    Boolean(question) ||
    pendingAsk
  const displayStatus = needsResponse ? "awaiting_approval" : status
  const busy = status === "streaming" || displayStatus === "awaiting_approval"
  return { status, displayStatus, busy, error }
}

/** Session composition lives here; the generic resource metadata panel stays resource-agnostic. */
export function SessionOverviewPanel({
  session,
  messages,
  messageCount,
  onNavigate,
}: SessionOverviewPanelProps) {
  const t = useTranslations("contextWorkbench.taskOverview")
  const tm = useTranslations("contextWorkbench.metadata")
  const character = useCharacter(session.characterId)
  const { status, displayStatus, busy, error } = useSessionOverviewState(session.id)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const manage = () => setSettingsOpen(true)

  return (
    <ScrollArea className="h-full">
      <div className="min-w-0 space-y-5 p-4" data-testid="session-overview-panel">
        <section className="space-y-3" aria-label={t("currentState")}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="break-words text-base font-semibold">
                {session.title || t("untitled")}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              aria-label={t("manage")}
              onClick={manage}
            >
              <Settings2Icon className="size-4" aria-hidden />
            </Button>
          </div>
          {/* One rail, shared with the compact summary card, so the two surfaces
              cannot describe the same state in two different vocabularies. */}
          <SessionStatusRail
            displayStatus={displayStatus}
            error={status === "error" ? error : null}
          />
          <div className="flex flex-wrap items-center gap-2">
            {character ? <span className="break-words text-sm">{character.name}</span> : null}
            <RoomParticipantsChip session={session} />
          </div>
          {session.kind !== "workflow-editor" ? (
            <div className="flex flex-wrap items-center gap-2" aria-label={t("execution")}>
              <CompositionChip sessionId={session.id} disabled={busy} />
              <AgentRuntimeSelector
                sessionId={session.id}
                providerId={session.providerOverride}
                disabled={busy}
              />
            </div>
          ) : null}
          <SessionEnvironmentChip executionContext={session.executionContext} onManage={manage} />
          {!session.executionContext && session.workingDir ? (
            <p className="break-all text-xs text-muted-foreground">{session.workingDir}</p>
          ) : null}
        </section>

        <SessionOpenItems
          entries={session.workingSet?.entries ?? []}
          onNavigate={onNavigate}
          className="border-t pt-4"
        />

        <SessionCapabilitiesSection session={session} onManage={manage} />
        <SessionResultsSection session={session} messages={messages} onNavigate={onNavigate} />

        <details className="border-t pt-4">
          <summary className="cursor-pointer text-sm font-medium">{t("technicalDetails")}</summary>
          <ContextMetadataPanel
            title={t("technicalDetails")}
            fields={[
              { label: tm("model"), value: session.model ?? tm("unknown") },
              { label: tm("provider"), value: session.providerOverride ?? tm("unknown") },
              { label: tm("workingDir"), value: session.workingDir ?? tm("unknown") },
              { label: tm("messageCount"), value: messageCount },
              { label: tm("createdAt"), value: new Date(session.createdAt).toLocaleString() },
              { label: tm("sessionId"), value: session.id },
            ]}
          />
        </details>
        {settingsOpen ? (
          <SessionSettingsSheet
            session={session}
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
          />
        ) : null}
      </div>
    </ScrollArea>
  )
}
