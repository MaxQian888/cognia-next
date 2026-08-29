"use client"

/**
 * Mobile External Agents page (ADR-0056, Wave 4). Remote-edits the paired
 * desktop's external-agent config: list every configured agent, toggle each
 * on/off, and change its permission mode.
 *
 * Paired-only (`<PairedOnly>`, decision D2): external agents run on the desktop
 * sidecar (spawned processes / network endpoints). The standalone (BYOK) webview
 * has none, so the panel would be dead UI there.
 *
 * Persistence model: external-agent config lives in the desktop's
 * `cognia-external-agents` Zustand/localStorage store — NOT a synced Dexie
 * table — so there is no sync mirror. The list is fetched on-demand through the
 * read-only `external_agent_list` companion RPC (mirrors `twin_profile_get`),
 * and edits round-trip through an immediately approved `external_agent_update`
 * RPC. Approval leases are deliberately never stored in the outbound queue.
 * The permission mode is clamped per-protocol both here (display) and on the
 * desktop (authority) so the phone can never set a mode the backend can't run.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { PlugIcon } from "lucide-react"

import { MeSection } from "@/components/mobile/me/me-section"
import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
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
import {
  adaptPermissionMode,
  supportedPermissionModes,
} from "@/lib/ai/agent/external/permission-modes"
import type { AcpPermissionMode, ExternalAgentProtocol } from "@/types/agent/external-agent"

interface ExternalAgentSummary {
  id: string
  name: string
  protocol: ExternalAgentProtocol
  transport: string
  enabled: boolean
  defaultPermissionMode: AcpPermissionMode
}

interface ExternalAgentListResponse {
  agents: ExternalAgentSummary[]
}

/** i18n label key (under `mobile.externalAgents`) for each permission mode. */
const PERMISSION_MODE_LABEL_KEY: Record<AcpPermissionMode, string> = {
  default: "permissionDefault",
  acceptEdits: "permissionAcceptEdits",
  bypassPermissions: "permissionBypass",
  plan: "permissionPlan",
  dontAsk: "permissionDontAsk",
}

function ExternalAgentsBody() {
  const t = useTranslations("mobile.externalAgents")
  const [agents, setAgents] = useState<ExternalAgentSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void transport
      .call("external_agent_list", {})
      .then((res: unknown) => {
        if (cancelled) return
        const list = (res as ExternalAgentListResponse | null)?.agents ?? []
        setAgents(list)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Optimistically patch local state, then perform the approved write while
  // this direct user action is still in flight. The short-lived lease must not
  // be persisted in the durable outbound queue.
  const writeUpdate = useCallback(
    async (
      agent: ExternalAgentSummary,
      patch: Partial<Pick<ExternalAgentSummary, "enabled" | "defaultPermissionMode">>
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
        // Roll back the optimistic edit on enqueue failure.
        setAgents(previous)
        toast.error(
          t("toggleFailed", { message: err instanceof Error ? err.message : String(err) })
        )
      }
    },
    [agents, t]
  )

  if (loading) {
    return <p className="px-1 text-sm text-muted-foreground">{t("loading")}</p>
  }
  if (error) {
    return (
      <p className="px-1 text-sm text-destructive" data-testid="external-agents-error">
        {t("loadFailed", { message: error })}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-xs text-muted-foreground" data-testid="external-agents-intro">
        {t("intro")}
      </p>

      <MeSection title={t("sectionTitle")} testid="me-section-external-agents">
        {agents && agents.length > 0 ? (
          agents.map((agent) => {
            const modes = supportedPermissionModes(agent.protocol)
            const currentMode = adaptPermissionMode(
              agent.defaultPermissionMode,
              agent.protocol
            ).mode
            return (
              <Item
                key={agent.id}
                size="sm"
                className="px-0"
                data-testid={`external-agent-row-${agent.id}`}
              >
                <ItemMedia>
                  <PlugIcon className="size-4 text-muted-foreground" aria-hidden />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="text-xs">{agent.name}</ItemTitle>
                  <ItemDescription className="text-[11px]">
                    <span className="font-mono">{agent.protocol}</span> ·{" "}
                    <span className="font-mono">{agent.transport}</span>
                  </ItemDescription>
                </ItemContent>
                {/* Mode picker sits beside the enable switch instead of on its
                    own line below the title — one row per agent on a phone. */}
                <ItemActions className="gap-2">
                  <Select
                    value={currentMode}
                    onValueChange={(v) =>
                      void writeUpdate(agent, { defaultPermissionMode: v as AcpPermissionMode })
                    }
                  >
                    <SelectTrigger
                      className="h-8 w-28 text-xs"
                      aria-label={t("permissionModeAria", { name: agent.name })}
                      data-testid={`external-agent-mode-${agent.id}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {modes.map((mode) => (
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
                    data-testid={`external-agent-switch-${agent.id}`}
                  />
                </ItemActions>
              </Item>
            )
          })
        ) : (
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemDescription className="text-xs" data-testid="external-agents-empty">
                {t("empty")}
              </ItemDescription>
            </ItemContent>
          </Item>
        )}
      </MeSection>

      <div
        className="flex items-start gap-3 rounded-xl border bg-card px-3 py-3 text-xs text-muted-foreground"
        data-testid="external-agents-manage-note"
      >
        <PlugIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{t("manageOnDesktop")}</p>
      </div>
    </div>
  )
}

export default function MobileExternalAgentsPage() {
  const t = useTranslations("mobile.externalAgents")
  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-external-agents-page">
      <PairedOnly>
        <ExternalAgentsBody />
      </PairedOnly>
    </SubPageShell>
  )
}
