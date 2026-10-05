"use client"

/**
 * Agents configured in the desktop app's own store, edited remotely.
 *
 * These are not what the phone runs — the Host's configurations above are —
 * so they sit in their own section that says so, and only appear when there
 * is at least one. Before the Host's configurations had a screen of their own,
 * this list was the whole page, and an agent toggled here looked like one the
 * phone could pick in chat when it could not.
 *
 * Persistence model: the desktop's `cognia-external-agents` store, read
 * through the read-only `external_agent_list` RPC and edited through an
 * immediately approved `external_agent_update`. Approval leases are never
 * stored in the outbound queue. The permission mode is clamped per protocol
 * here (display) and on the desktop (authority).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CloudOffIcon, MonitorIcon, RotateCwIcon } from "lucide-react"

import { MeSection } from "@/components/mobile/me/me-section"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { transport } from "@/lib/tauri"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import type { AcpPermissionMode, ExternalAgentProtocol } from "@/types/agent/external-agent"

import {
  PERMISSION_MODE_LABEL_KEY,
  effectivePermissionMode,
  permissionModesFor,
} from "./permission-modes"

export interface DesktopLocalAgentSummary {
  id: string
  name: string
  protocol: ExternalAgentProtocol
  transport: string
  enabled: boolean
  defaultPermissionMode: AcpPermissionMode
}

interface ExternalAgentListResponse {
  agents: DesktopLocalAgentSummary[]
}

export function DesktopLocalAgents() {
  const t = useTranslations("mobile.externalAgents")
  const [agents, setAgents] = useState<DesktopLocalAgentSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped by Retry; the load below re-runs on it.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    void transport
      .call("external_agent_list", {})
      .then((res: unknown) => {
        if (cancelled) return
        setAgents((res as ExternalAgentListResponse | null)?.agents ?? [])
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  const retry = () => {
    setError(null)
    setAgents(null)
    setAttempt((current) => current + 1)
  }

  // Optimistically patch local state, then perform the approved write while
  // this direct user action is still in flight. The short-lived lease must not
  // be persisted in the durable outbound queue.
  const writeUpdate = useCallback(
    async (
      agent: DesktopLocalAgentSummary,
      patch: Partial<Pick<DesktopLocalAgentSummary, "enabled" | "defaultPermissionMode">>
    ) => {
      const previous = agents
      setAgents((current) =>
        current ? current.map((a) => (a.id === agent.id ? { ...a, ...patch } : a)) : current
      )
      try {
        const lease = await issueHostAdminLease(["external_agent_update"])
        await transport.call("external_agent_update", {
          id: agent.id,
          patch,
          adminLease: lease.token,
        })
        toast.success(t("updateQueued"))
      } catch (err) {
        // Roll back the optimistic edit on failure.
        setAgents(previous)
        toast.error(
          t("toggleFailed", { message: err instanceof Error ? err.message : String(err) })
        )
      }
    },
    [agents, t]
  )

  if (error) {
    return (
      <Empty className="rounded-xl border" data-testid="desktop-local-agents-error">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CloudOffIcon />
          </EmptyMedia>
          <EmptyTitle>{t("desktopLocalLoadFailedTitle")}</EmptyTitle>
          <EmptyDescription className="break-words">
            {t("loadFailed", { message: error })}
          </EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          className="h-11"
          onClick={retry}
          data-testid="desktop-local-agents-retry"
        >
          <RotateCwIcon className="size-4" />
          {t("retry")}
        </Button>
      </Empty>
    )
  }
  if (agents === null) {
    return (
      <div
        role="status"
        className="flex flex-col gap-2"
        aria-busy="true"
        aria-label={t("loading")}
        data-testid="desktop-local-agents-loading"
      >
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-14 w-full rounded-xl" />
      </div>
    )
  }
  // Nothing configured on the desktop itself: the section would only explain
  // an empty list that has nothing to do with the phone.
  if (agents.length === 0) return null

  return (
    <MeSection
      title={t("desktopLocalTitle")}
      description={t("desktopLocalDescription")}
      testid="desktop-local-agents"
    >
      {agents.map((agent) => {
        const currentMode = effectivePermissionMode(agent.defaultPermissionMode, agent.protocol)
        return (
          <Item
            key={agent.id}
            size="sm"
            className="px-0"
            data-testid={`external-agent-row-${agent.id}`}
          >
            <ItemMedia>
              <MonitorIcon className="size-4 text-muted-foreground" aria-hidden />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="text-xs">{agent.name}</ItemTitle>
              <ItemDescription className="text-[11px]">
                <span className="font-mono">{agent.protocol}</span> ·{" "}
                <span className="font-mono">{agent.transport}</span>
              </ItemDescription>
            </ItemContent>
            <ItemActions className="gap-2">
              <Select
                value={currentMode}
                onValueChange={(v) =>
                  void writeUpdate(agent, { defaultPermissionMode: v as AcpPermissionMode })
                }
              >
                <SelectTrigger
                  className="h-11 w-28 text-xs"
                  aria-label={t("permissionModeAria", { name: agent.name })}
                  data-testid={`external-agent-mode-${agent.id}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {permissionModesFor(agent.protocol).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(PERMISSION_MODE_LABEL_KEY[mode])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Switch
                checked={agent.enabled}
                onCheckedChange={(next) => void writeUpdate(agent, { enabled: next })}
                aria-label={t("enabledAria", { name: agent.name })}
                className="touch-hit"
                data-testid={`external-agent-switch-${agent.id}`}
              />
            </ItemActions>
          </Item>
        )
      })}
    </MeSection>
  )
}
