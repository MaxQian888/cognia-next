"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  AlertTriangleIcon,
  BugIcon,
  ExternalLinkIcon,
  RotateCcwIcon,
  SquareIcon,
} from "lucide-react"
import { toast } from "sonner"

import { PluginPointDiagnosticsPanel } from "../plugin-point-diagnostics-panel"
import { ApiAuditPane } from "./api-audit-pane"
import { LifecyclePane } from "./lifecycle-pane"
import { TriggersPane } from "./triggers-pane"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCogniaCliStatus } from "@/hooks/plugins/use-cognia-cli-status"
import {
  clearPluginRuntimeLogs,
  getPluginRuntimeLogs,
  logSourcesFor,
  subscribePluginRuntimeLogs,
  type PluginRuntimeLogEntry,
} from "@/lib/plugin/devtools/runtime-log-stream"
import { getLiveSession } from "@/lib/terminal/session-registry"
import { launchCognia } from "@/lib/terminal/run-cognia"
import { useDevProjectStore } from "@/stores/plugins/dev-project-store"
import {
  type PluginDevAttemptStage,
  usePluginDevSessionStore,
} from "@/stores/plugins/plugin-dev-session-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { CogniaCliLauncher } from "./cognia-cli-launcher"
import { CogniaCliStatusCard } from "./cognia-cli-status-card"
import { LocalPluginDropzone } from "./local-plugin-dropzone"
import { ManifestValidator } from "./manifest-validator"

/** Newest lines kept in view. The rings themselves are larger. */
const RUNTIME_LOG_LIMIT = 200

const STAGES: PluginDevAttemptStage[] = [
  "detected",
  "building",
  "installing",
  "discovering",
  "quiescing",
  "activating",
  "verifying",
  "active",
]

export function PluginDevSessionWorkbench() {
  const t = useTranslations("plugins.devSession")
  const status = useCogniaCliStatus()
  const projectDir = useDevProjectStore((state) => state.projectDir)
  const sessions = usePluginDevSessionStore((state) => state.sessions)
  const [actionPending, setActionPending] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const session = sessions[0]
  const attempt = session?.attempts[0]
  const isAppSession = Boolean(session?.terminalSessionId)

  const stageSet = useMemo(() => new Set(attempt?.stages ?? []), [attempt?.stages])

  async function restartApp(): Promise<void> {
    setRestarting(true)
    try {
      const { relaunchApp } = await import("@/lib/tauri/updater")
      await relaunchApp()
    } catch (error) {
      setRestarting(false)
      toast.error(
        t("actions.restartFailed", {
          message: error instanceof Error ? error.message : String(error),
        })
      )
    }
  }

  async function stopSession(): Promise<void> {
    if (!session?.terminalSessionId || session.state === "stopping") return
    const terminal = getLiveSession(session.terminalSessionId)
    if (!terminal || terminal.isExited) {
      toast.error(t("actions.terminalUnavailable"))
      return
    }
    usePluginDevSessionStore.getState().ingest({
      schemaVersion: 1,
      sessionId: session.id,
      attempt: attempt?.attempt ?? 0,
      event: "session_stopping",
      occurredAt: new Date().toISOString(),
    })
    await terminal.write("\u0003")
  }

  async function restartSession(): Promise<void> {
    if (!projectDir || !session?.terminalSessionId) return
    setActionPending(true)
    try {
      await stopSession()
      const sessionId = crypto.randomUUID()
      const outcome = await launchCognia({
        command: `plugin dev --session-id ${sessionId}`,
        cwd: projectDir,
        store: useTerminalStore.getState(),
      })
      if (outcome.kind === "launched") {
        usePluginDevSessionStore.getState().attachTerminal(sessionId, outcome.sessionId)
      } else {
        toast.error(
          outcome.kind === "error"
            ? t("actions.launchFailed", { message: outcome.message })
            : t("actions.launchDenied")
        )
      }
    } finally {
      setActionPending(false)
    }
  }

  function openTerminal(): void {
    if (!session?.terminalSessionId) return
    const terminalStore = useTerminalStore.getState()
    terminalStore.setPanelOpen(true)
    const projectId = terminalStore.sessions[session.terminalSessionId]?.projectId ?? null
    terminalStore.setActiveSession(projectId, session.terminalSessionId)
  }

  return (
    <div className="space-y-4" data-testid="plugin-dev-session-workbench">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <CogniaCliStatusCard className="xl:col-span-5" />
        <CogniaCliLauncher className="xl:col-span-7" />
      </div>

      {!status.supported && (
        <Card
          className="border-amber-500/40 bg-amber-500/5 p-4"
          data-testid="dev-session-desktop-required"
        >
          <div className="flex gap-3">
            <AlertTriangleIcon
              className="mt-0.5 size-4 shrink-0 text-amber-600"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">{t("desktopRequired.title")}</h3>
              <p className="text-xs text-muted-foreground">{t("desktopRequired.description")}</p>
            </div>
          </div>
        </Card>
      )}

      <Card className="gap-4 p-4" data-testid="dev-session-current">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">{t("current.title")}</h2>
              <Badge variant={attempt?.state === "active" ? "secondary" : "outline"}>
                {session ? t(`sessionState.${session.state}`) : t("sessionState.idle")}
              </Badge>
              {attempt && (
                <Badge variant={attempt.state.endsWith("failed") ? "destructive" : "outline"}>
                  {t("current.attempt", { attempt: attempt.attempt })} ·{" "}
                  {t(`attemptState.${attempt.state}`)}
                </Badge>
              )}
              {/*
                `resolvePluginDevCapability` has always returned an `action`
                string for a dirty runtime, and the workbench rendered it as
                prose telling the user to restart. The one thing only the app
                can do was the one thing it did not offer.
              */}
              {attempt?.state === "restart_required" && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={restarting}
                  title={t("actions.restartRequired")}
                  onClick={() => void restartApp()}
                  data-testid="dev-session-restart-app"
                >
                  <RotateCcwIcon aria-hidden="true" />
                  {t("actions.restartApp")}
                </Button>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {[
                session?.projectName,
                session?.pluginId
                  ? `${session.pluginId}${session.pluginType ? ` · ${session.pluginType}` : ""}`
                  : undefined,
              ]
                .filter(Boolean)
                .join(" · ") || t("current.waiting")}
            </p>
          </div>
          {isAppSession && (
            <div className="flex flex-wrap gap-2" data-testid="dev-session-terminal-actions">
              <Button size="sm" variant="outline" onClick={openTerminal}>
                <ExternalLinkIcon aria-hidden="true" />
                {t("actions.openTerminal")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={session?.state === "stopping" || actionPending}
                onClick={() => void stopSession()}
              >
                <SquareIcon aria-hidden="true" />
                {t("actions.stop")}
              </Button>
              <Button
                size="sm"
                disabled={!projectDir || actionPending}
                onClick={() => void restartSession()}
              >
                <RotateCcwIcon aria-hidden="true" />
                {t("actions.restart")}
              </Button>
            </div>
          )}
        </div>

        <ol
          className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8"
          aria-label={t("timeline.ariaLabel")}
        >
          {STAGES.map((stage) => (
            <li
              key={stage}
              className={
                stageSet.has(stage)
                  ? "rounded-md border border-primary/40 bg-primary/5 px-2 py-2 text-xs font-medium"
                  : "rounded-md border border-dashed px-2 py-2 text-xs text-muted-foreground"
              }
              data-active={stageSet.has(stage) || undefined}
            >
              {t(`stage.${stage}`)}
            </li>
          ))}
        </ol>

        {attempt?.activationProof && (
          <div
            className="grid gap-2 rounded-md border bg-muted/20 p-3 text-xs sm:grid-cols-3"
            data-testid="dev-session-activation-proof"
          >
            <span>{t("proof.generation", { generation: attempt.activationProof.generation })}</span>
            <span>{t("proof.version", { version: attempt.activationProof.packageVersion })}</span>
            <code className="truncate" title={attempt.activationProof.artifactRevision}>
              {attempt.activationProof.artifactRevision}
            </code>
          </div>
        )}
      </Card>

      <Tabs defaultValue="activity">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="activity">
            <ActivityIcon aria-hidden="true" />
            {t("tabs.activity")}
          </TabsTrigger>
          <TabsTrigger value="diagnostics">
            <AlertTriangleIcon aria-hidden="true" />
            {t("tabs.diagnostics")}
          </TabsTrigger>
          <TabsTrigger value="advanced">
            <BugIcon aria-hidden="true" />
            {t("tabs.advanced")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="activity" className="space-y-3">
          <ActivityList />
        </TabsContent>
        <TabsContent value="diagnostics" className="space-y-4">
          <AttemptDiagnostics />
          <RuntimeLogs />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 [&>:only-child]:lg:col-span-12">
            <ManifestValidator className="lg:col-span-7" />
            <LocalPluginDropzone className="lg:col-span-5" />
          </div>
        </TabsContent>
        <TabsContent value="advanced" className="space-y-4">
          <ApiAuditPane />
          <LifecyclePane />
          <TriggersPane />
          <PluginPointDiagnosticsPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ActivityList() {
  const t = useTranslations("plugins.devSession")
  const sessions = usePluginDevSessionStore((state) => state.sessions)
  const attempts = sessions.flatMap((session) =>
    session.attempts.map((attempt) => ({ sessionId: session.id, attempt }))
  )
  return (
    <Card className="p-4">
      {attempts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("activity.empty")}</p>
      ) : (
        <ul className="divide-y">
          {attempts.map(({ sessionId, attempt }) => (
            <li
              key={`${sessionId}:${attempt.attempt}`}
              className="flex items-center gap-3 py-2 text-xs"
            >
              <Badge variant={attempt.state.endsWith("failed") ? "destructive" : "outline"}>
                #{attempt.attempt}
              </Badge>
              <span className="font-medium">{t(`attemptState.${attempt.state}`)}</span>
              <span className="ml-auto text-muted-foreground">
                {attempt.durationMs != null
                  ? t("activity.duration", { duration: attempt.durationMs })
                  : "—"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function AttemptDiagnostics() {
  const t = useTranslations("plugins.devSession")
  const attempt = usePluginDevSessionStore((state) => state.sessions[0]?.attempts[0])
  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold">{t("diagnostics.title")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("diagnostics.structuredOnly")}</p>
      {attempt?.diagnostics.length ? (
        <ul className="mt-3 space-y-2">
          {attempt.diagnostics.map((diagnostic, index) => (
            <li key={`${index}:${diagnostic}`} className="rounded-md border p-2 font-mono text-xs">
              {diagnostic}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">{t("diagnostics.empty")}</p>
      )}
    </Card>
  )
}

function RuntimeLogs() {
  const t = useTranslations("plugins.devSession")
  const session = usePluginDevSessionStore((state) => state.sessions[0])
  const pluginId = session?.pluginId
  const pluginType = session?.pluginType
  const proof = session?.attempts[0]?.activationProof
  const generation = proof?.generation ?? null
  const [entries, setEntries] = useState<PluginRuntimeLogEntry[]>([])

  const missingReason = pluginType ? logSourcesFor(pluginType).missingReason : undefined

  useEffect(() => {
    if (!pluginId || missingReason) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEntries([])
      return
    }
    const read = () =>
      setEntries(getPluginRuntimeLogs(pluginId, { generation, limit: RUNTIME_LOG_LIMIT }))
    read()
    return subscribePluginRuntimeLogs(pluginId, read)
  }, [pluginId, generation, missingReason])

  return (
    <Card className="p-4" data-testid="dev-session-runtime-logs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("runtimeLogs.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="runtime-logs-scope">
            {!pluginId
              ? t("runtimeLogs.waiting")
              : missingReason
                ? t(`runtimeLogs.missing.${missingReason}` as never)
                : proof
                  ? t("runtimeLogs.filter", { pluginId, generation: proof.generation })
                  : // Before this, no verified activation meant no logs at all, so a
                    // Python plugin author watched an empty card while their output
                    // sat on the plugin detail page. Show everything and say so.
                    t("runtimeLogs.unverified", { pluginId })}
          </p>
        </div>
        {pluginId && !missingReason && (
          <Button
            size="sm"
            variant="ghost"
            disabled={entries.length === 0}
            onClick={() => {
              clearPluginRuntimeLogs(pluginId)
              setEntries([])
            }}
          >
            {t("runtimeLogs.clear")}
          </Button>
        )}
      </div>

      {pluginId && !missingReason && entries.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="runtime-logs-empty">
          {t("runtimeLogs.empty")}
        </p>
      )}

      {entries.length > 0 && (
        <ul className="mt-3 max-h-72 divide-y overflow-y-auto rounded-md border">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex gap-2 px-3 py-2 font-mono text-xs"
              data-runtime={entry.runtime}
            >
              <Badge variant={entry.level === "error" ? "destructive" : "outline"}>
                {entry.level}
              </Badge>
              {/*
                Which runtime produced the line. A hybrid plugin emits from two
                hosts at once, and without this its Python and frontend output
                are indistinguishable.
              */}
              <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                {entry.runtime}
              </span>
              <span className="min-w-0 flex-1 break-words">
                {entry.kind ?? ""} {entry.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
