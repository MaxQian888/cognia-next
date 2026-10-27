"use client"

import { useId, useRef, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ExternalLink, Square, Terminal } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import { TERMINAL_AGENTS, type TerminalAgentId } from "@/lib/agent-ecosystem/terminal-agents"
import { openUrl } from "@/lib/native/opener"
import {
  agentTerminalStatus,
  findAgentTerminalSession,
  launchTerminalAgent,
  openAgentTerminal,
  stopTerminalAgent,
  type AgentTerminalErrorCode,
  type AgentTerminalHost,
  type AgentTerminalStatus,
} from "@/lib/terminal/agent-session"
import { getLiveSession, subscribeLiveSessions } from "@/lib/terminal/session-registry"
import { primaryRootOf } from "@/lib/workspace/roots"
import { useTerminalTransport } from "@/hooks/terminal/use-terminal-transport"
import { useProjectStore } from "@/stores/project/project-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

function liveSnapshot(): string {
  return TERMINAL_AGENTS.map((agent) => {
    const row = findAgentTerminalSession(agent.id, useTerminalStore.getState().sessions)
    return row ? agentTerminalStatus(row, getLiveSession) : "not-started"
  }).join("|")
}

const host: AgentTerminalHost = {
  getStore: () => useTerminalStore.getState(),
  activateProject: (id) => useProjectStore.getState().setActiveProject(id),
}

/** Native terminal interaction is separate from the structured agent roster. */
export function TerminalAgentPanel({ onOpenedInTerminal }: { onOpenedInTerminal?: () => void }) {
  const t = useTranslations("externalAgent.manager.terminalAgents")
  const id = useId()
  const projects = useProjectStore((state) => state.projects)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const sessions = useTerminalStore((state) => state.sessions)
  const { canSpawn } = useTerminalTransport()
  const signature = useSyncExternalStore(subscribeLiveSessions, liveSnapshot, () => "")
  const liveStatuses = signature.split("|") as AgentTerminalStatus[]
  const rows = TERMINAL_AGENTS.map((agent, index) => ({
    agent,
    row: findAgentTerminalSession(agent.id, sessions),
    status: liveStatuses[index] || "not-started",
  }))
  const [projectChoice, setProjectChoice] = useState("current")
  const [directory, setDirectory] = useState<string | null>(null)
  const [busy, setBusy] = useState<Partial<Record<TerminalAgentId, "launch" | "stop">>>({})
  const [errors, setErrors] = useState<
    Partial<Record<TerminalAgentId, AgentTerminalErrorCode | "early-exit" | "docs-failed">>
  >({})
  const operations = useRef<Partial<Record<TerminalAgentId, number>>>({})
  const projectId = projectChoice === "current" ? activeProjectId : projectChoice
  const project = projects.find((candidate) => candidate.id === projectId)
  const cwd = directory ?? (project ? primaryRootOf(project)?.path : undefined) ?? ""

  async function operate(agentId: TerminalAgentId, action: "launch" | "stop") {
    const operation = (operations.current[agentId] ?? 0) + 1
    operations.current[agentId] = operation
    setBusy((current) => ({ ...current, [agentId]: action }))
    setErrors((current) => ({ ...current, [agentId]: undefined }))
    try {
      const result =
        action === "stop"
          ? await stopTerminalAgent(agentId, host)
          : await launchTerminalAgent({ agentId, cwd, projectId: projectId ?? undefined, host })
      if (operations.current[agentId] !== operation) return
      if (result.kind === "error") {
        setErrors((current) => ({ ...current, [agentId]: result.code }))
      } else if (result.kind !== "stopped") {
        if (result.kind === "exited")
          setErrors((current) => ({ ...current, [agentId]: "early-exit" }))
        onOpenedInTerminal?.()
      }
    } catch {
      if (operations.current[agentId] === operation) {
        setErrors((current) => ({
          ...current,
          [agentId]: action === "stop" ? "stop-failed" : "spawn-failed",
        }))
      }
    } finally {
      if (operations.current[agentId] === operation) {
        setBusy((current) => ({ ...current, [agentId]: undefined }))
      }
    }
  }

  return (
    <Collapsible className="shrink-0 rounded-lg border">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="h-auto w-full justify-between px-3 py-2.5">
          <span className="flex items-center gap-2">
            <Terminal className="size-4" />
            {t("title")}
          </span>
          <span className="flex items-center gap-2">
            <Badge variant="outline">{t("terminalOnly")}</Badge>
            <ChevronDown className="size-4" />
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <section aria-label={t("title")} className="grid max-h-80 gap-3 overflow-y-auto px-3 pb-3">
          <p className="text-xs text-muted-foreground">{t("limitations")}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label htmlFor={`${id}-project`}>{t("workspace")}</Label>
              <NativeSelect
                id={`${id}-project`}
                value={projectChoice}
                onChange={(event) => {
                  setProjectChoice(event.target.value)
                  setDirectory(null)
                }}
              >
                <option value="current">{t("currentWorkspace")}</option>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${id}-directory`}>{t("directory")}</Label>
              <Input
                id={`${id}-directory`}
                value={cwd}
                placeholder={t("directoryPlaceholder")}
                onChange={(event) => setDirectory(event.target.value)}
              />
            </div>
          </div>
          {!canSpawn && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("hostUnavailable")}
            </p>
          )}
          <ul className="grid gap-3">
            {rows.map(({ agent, row, status }) => (
              <li
                key={agent.id}
                className="grid gap-2 rounded-md bg-muted/30 p-3"
                aria-label={agent.name}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{agent.name}</span>
                  <Badge variant="secondary">{t(`statuses.${status}`)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{t(`setup.${agent.id}`)}</p>
                {row?.cwd && (
                  <p className="truncate font-mono text-xs text-muted-foreground" title={row.cwd}>
                    {row.cwd}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void openUrl(agent.docsUrl).catch(() =>
                        setErrors((current) => ({ ...current, [agent.id]: "docs-failed" }))
                      )
                    }}
                    aria-label={t("setupDocs", { agent: agent.name })}
                  >
                    <ExternalLink className="size-3.5" />
                    {t("setupDocs", { agent: agent.name })}
                  </Button>
                  {row && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={Boolean(busy[agent.id])}
                      onClick={() => {
                        const result = openAgentTerminal(agent.id, host)
                        if (result.kind === "opened") onOpenedInTerminal?.()
                        else if (result.kind === "error")
                          setErrors((current) => ({ ...current, [agent.id]: result.code }))
                      }}
                      aria-label={t("open", { agent: agent.name })}
                    >
                      {t("open", { agent: agent.name })}
                    </Button>
                  )}
                  {(!row || status === "exited") && (
                    <Button
                      size="sm"
                      disabled={!canSpawn || Boolean(busy[agent.id]) || !cwd.trim()}
                      onClick={() => {
                        void operate(agent.id, "launch")
                      }}
                      aria-label={t(row ? "restart" : "launch", { agent: agent.name })}
                    >
                      {busy[agent.id] === "launch"
                        ? t("launching")
                        : t(row ? "restart" : "launch", { agent: agent.name })}
                    </Button>
                  )}
                  {(row ||
                    busy[agent.id] === "launch" ||
                    errors[agent.id] === "cleanup-failed") && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy[agent.id] === "stop"}
                      onClick={() => {
                        void operate(agent.id, "stop")
                      }}
                      aria-label={t(
                        errors[agent.id] === "cleanup-failed" ? "retryCleanup" : "stop",
                        { agent: agent.name }
                      )}
                    >
                      <Square className="size-3.5" />
                      {busy[agent.id] === "stop"
                        ? t("stopping")
                        : t(errors[agent.id] === "cleanup-failed" ? "retryCleanup" : "stop", {
                            agent: agent.name,
                          })}
                    </Button>
                  )}
                </div>
                {errors[agent.id] && (
                  <p role="alert" className="text-xs text-destructive">
                    {t(`errors.${errors[agent.id]}`)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      </CollapsibleContent>
    </Collapsible>
  )
}
