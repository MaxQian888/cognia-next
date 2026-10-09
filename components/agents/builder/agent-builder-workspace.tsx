"use client"

/**
 * "Build with AI", step two (ADR-0220): the builder conversation and the live
 * draft side by side — chat on the left, the agent form on the right. On a
 * narrow window the two become tabs. The header names the runtime the builder
 * runs on and warns when that runtime cannot call the builder's tools.
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ArrowRightIcon, CircleCheckIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react"
import type { Character } from "@cognia/agent-config-types"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AgentRuntimeSelector } from "@/components/agent/mode/runtime-selector"
import { useAgentCatalogs } from "@/hooks/agents/use-agent-catalogs"
import { useBuilderToolSupport } from "@/hooks/agents/use-builder-tool-support"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { useSettingsStore } from "@/stores/settings"
import { getDb } from "@/lib/db/schema"
import { isAgentBuilderSession } from "@/lib/agents/builder/builder-session"
import { deleteSessionsRouted } from "@/lib/chat/session-archive-writes"
import { AgentBuilderChat } from "./agent-builder-chat"
import { AgentBuilderDraftPanel } from "./agent-builder-draft-panel"

export interface AgentBuilderWorkspaceProps {
  sessionId: string
  onOpenAgent: (id: string) => void
  /** After the draft was discarded, or when the conversation is not a builder. */
  onLeave: () => void
}

export function AgentBuilderWorkspace({
  sessionId,
  onOpenAgent,
  onLeave,
}: AgentBuilderWorkspaceProps) {
  const t = useTranslations("agentsConsole.builder")
  const compact = useCompactLayout()
  const catalogs = useAgentCatalogs()
  const toolSupport = useBuilderToolSupport(sessionId)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const session = useLiveQuery(
    async () => (await getDb().sessions.get(sessionId)) ?? null,
    [sessionId]
  )
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [mobileTab, setMobileTab] = useState<"chat" | "draft">("chat")

  if (session === undefined) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </div>
    )
  }
  if (!session || !isAgentBuilderSession(session) || !session.agentBuilder) {
    return (
      <div className="mx-auto max-w-md p-8" data-testid="agent-builder-missing">
        <Alert>
          <TriangleAlertIcon className="size-4" />
          <AlertTitle>{t("missingTitle")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{t("missingBody")}</p>
            <Button size="sm" variant="outline" onClick={onLeave}>
              {t("backToAgents")}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const state = session.agentBuilder
  const providerId = session.providerOverride ?? defaultProvider ?? "anthropic"
  const openCreated = (agent: Character) => onOpenAgent(agent.id)

  const header = (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
      <h2 className="text-sm font-semibold">{t("title")}</h2>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <AgentRuntimeSelector sessionId={sessionId} providerId={providerId} />
        {toolSupport === "unsupported" ? (
          <span
            className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
            data-testid="agent-builder-tools-unsupported"
          >
            <TriangleAlertIcon className="size-3.5" aria-hidden />
            {t("toolsUnsupported")}
          </span>
        ) : null}
      </div>
    </div>
  )

  const panel =
    state.status === "created" ? (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
        data-testid="agent-builder-created"
      >
        <CircleCheckIcon className="size-8 text-emerald-600" aria-hidden />
        <p className="text-sm font-medium">{t("createdTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("createdBody")}</p>
        {state.createdCharacterId ? (
          <Button size="sm" onClick={() => onOpenAgent(state.createdCharacterId as string)}>
            {t("openAgent")}
            <ArrowRightIcon className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>
    ) : (
      <AgentBuilderDraftPanel
        sessionId={sessionId}
        state={state}
        catalogs={catalogs}
        onCreated={openCreated}
        onDiscard={() => setConfirmDiscard(true)}
      />
    )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-builder-workspace">
      {header}
      {compact ? (
        <Tabs
          value={mobileTab}
          onValueChange={(value) => setMobileTab(value as "chat" | "draft")}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <TabsList className="mx-4 mt-2 w-fit">
            <TabsTrigger value="chat">{t("tabChat")}</TabsTrigger>
            <TabsTrigger value="draft">{t("tabDraft")}</TabsTrigger>
          </TabsList>
          <TabsContent value="chat" className="min-h-0 flex-1">
            <AgentBuilderChat session={session} />
          </TabsContent>
          <TabsContent value="draft" className="min-h-0 flex-1">
            {panel}
          </TabsContent>
        </Tabs>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(22rem,30rem)]">
          <div className="min-h-0 min-w-0">
            <AgentBuilderChat session={session} />
          </div>
          <div className="min-h-0 border-l">{panel}</div>
        </div>
      )}

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("discardBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                deleteSessionsRouted([sessionId]).then(onLeave, (err: unknown) =>
                  toast.error(
                    t("discardFailed", {
                      message: err instanceof Error ? err.message : String(err),
                    })
                  )
                )
              }}
            >
              {t("discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
