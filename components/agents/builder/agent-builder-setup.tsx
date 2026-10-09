"use client"

/**
 * "Build with AI", step one (ADR-0220): pick the runtime and model the
 * builder conversation runs on. The pickers are the composer's own, bound to
 * a pristine builder session, so every lane (built-in, local external agent,
 * host configuration) and every model surface (provider models, an external
 * agent's own models) works exactly as it does in chat. The runtime chosen
 * here also becomes the new agent's default runtime.
 */

import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Loader2Icon, SparklesIcon, TriangleAlertIcon } from "lucide-react"
import type { ChatSession } from "@cognia/agent-config-types"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AgentRuntimeSelector } from "@/components/agent/mode/runtime-selector"
import { ModelPicker } from "@/components/chat/composer/model-picker"
import { useSettingsStore } from "@/stores/settings"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useAgentRuntimeCatalog } from "@/hooks/agent/use-agent-runtime-catalog"
import { useBuilderToolSupport } from "@/hooks/agents/use-builder-tool-support"
import { getDb } from "@/lib/db/schema"
import { startNewSession } from "@/lib/chat/start-session"
import { ensureSetupBuilderSession, writeBuilderDraft } from "@/lib/agents/builder/builder-session"
import { runtimeBindingFromRef } from "@/lib/agents/runtime-binding"
import { AgentBuilderDrafts } from "./agent-builder-drafts"

export function AgentBuilderSetup({ onStart }: { onStart: (sessionId: string) => void }) {
  const t = useTranslations("agentsConsole.builderSetup")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    let cancelled = false
    ensureSetupBuilderSession(t("sessionTitle"), {
      startSession: (input) => startNewSession(input),
      now: Date.now,
    })
      .then((session) => {
        if (!cancelled) setSessionId(session.id)
      })
      .catch((err: unknown) => {
        if (!cancelled) setFailed(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [t])

  const session = useLiveQuery(
    async () => (sessionId ? ((await getDb().sessions.get(sessionId)) ?? null) : null),
    [sessionId]
  )
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const providerId = session?.providerOverride ?? defaultProvider ?? "anthropic"
  const runtimeRef = useRuntimeRefForSession(sessionId ?? undefined)
  const { selected } = useAgentRuntimeCatalog(providerId, sessionId ?? undefined)
  const toolSupport = useBuilderToolSupport(sessionId ?? undefined)

  const start = async () => {
    if (!sessionId) return
    setStarting(true)
    try {
      const runtime = runtimeBindingFromRef(runtimeRef, selected?.name)
      await writeBuilderDraft(sessionId, (draft) => ({ ...draft, runtime }), "user")
      onStart(sessionId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-6 px-6 py-8" data-testid="agent-builder-setup">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      {failed ? (
        <Alert variant="destructive">
          <TriangleAlertIcon className="size-4" />
          <AlertDescription>{t("failed", { reason: failed })}</AlertDescription>
        </Alert>
      ) : !sessionId || !session ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" aria-hidden />
          {t("preparing")}
        </div>
      ) : (
        <SetupFields
          session={session}
          sessionId={sessionId}
          providerId={providerId}
          toolSupport={toolSupport}
        />
      )}
      <div className="flex justify-end">
        <Button
          onClick={() => void start()}
          disabled={!sessionId || !session || starting}
          data-testid="agent-builder-start"
        >
          {starting ? (
            <Loader2Icon className="size-4 animate-spin" aria-hidden />
          ) : (
            <SparklesIcon className="size-4" aria-hidden />
          )}
          {t("start")}
        </Button>
      </div>
      <AgentBuilderDrafts onResume={onStart} />
    </div>
  )
}

function SetupFields({
  session,
  sessionId,
  providerId,
  toolSupport,
}: {
  session: ChatSession
  sessionId: string
  providerId: string
  toolSupport: ReturnType<typeof useBuilderToolSupport>
}) {
  const t = useTranslations("agentsConsole.builderSetup")
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>{t("runtime")}</Label>
        <AgentRuntimeSelector variant="field" sessionId={sessionId} providerId={providerId} />
        <p className="text-xs text-muted-foreground">{t("runtimeHint")}</p>
      </div>
      <div className="space-y-1.5">
        <Label>{t("model")}</Label>
        <ModelPicker
          session={session}
          className="h-9 w-full rounded-md border-input bg-background px-3 text-sm text-foreground shadow-xs hover:border-input hover:bg-accent/40 [&>span[title]]:flex-1 [&>span[title]]:text-left"
        />
      </div>
      {toolSupport === "unsupported" ? (
        <Alert data-testid="agent-builder-no-tools">
          <TriangleAlertIcon className="size-4" />
          <AlertDescription>{t("noToolsWarning")}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
