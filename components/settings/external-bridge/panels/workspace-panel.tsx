"use client"

/**
 * Settings → External Bridge → Workspace access (ADR-0203).
 *
 * The `workspace:*`, `git:read` and `shell:run` scopes say WHAT an external
 * client may do; this panel says WHERE — which workspace roots each client may
 * address. Grants are per caller (the stdio transport, and each HTTP client
 * credential) and name roots by their stable id, so renaming or moving a
 * workspace never silently widens a grant. With no grant a client reaches
 * nothing, whatever scopes it holds; the panel says so instead of leaving a
 * granted scope looking live when it is inert.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderGit2Icon } from "lucide-react"

import { SettingsCard } from "@/components/settings/common/settings-section"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { bridgeCallerForClientId, STDIO_BRIDGE_CALLER } from "@/lib/external-bridge/bridge-caller"
import {
  isHostManagedBridgeAvailable,
  listExternalBridgeClients,
} from "@/lib/external-bridge/tauri-control"
import { listAllRoots } from "@/lib/external-bridge/workspace/grants"
import { WORKSPACE_TOOL_SCOPES } from "@/lib/external-bridge/workspace/tool-names"
import { useProjectStore } from "@/stores/project/project-store"
import type { ExternalBridgeSettings } from "@/types/wiki"

/** The scopes a root grant is useful for. */
export const WORKSPACE_SCOPES = [...new Set(Object.values(WORKSPACE_TOOL_SCOPES))]

export interface BridgeCaller {
  id: string
  name: string
}

export interface BridgeWorkspacePanelProps {
  settings: ExternalBridgeSettings
  onChange: (next: ExternalBridgeSettings) => void
}

/** Toggle one root in one caller's grant, dropping empty entries. */
export function toggleWorkspaceGrant(
  settings: ExternalBridgeSettings,
  caller: string,
  rootId: string,
  granted: boolean
): ExternalBridgeSettings {
  const grants = { ...settings.workspaceGrants }
  const current = new Set(grants[caller] ?? [])
  if (granted) current.add(rootId)
  else current.delete(rootId)
  if (current.size > 0) grants[caller] = [...current]
  else delete grants[caller]
  return { ...settings, workspaceGrants: grants }
}

export function BridgeWorkspacePanel({ settings, onChange }: BridgeWorkspacePanelProps) {
  const t = useTranslations("settings.externalBridge")
  const projects = useProjectStore((state) => state.projects)
  const roots = useMemo(() => listAllRoots(projects), [projects])
  const [clients, setClients] = useState<BridgeCaller[]>([])

  useEffect(() => {
    if (!isHostManagedBridgeAvailable()) return
    let cancelled = false
    listExternalBridgeClients()
      .then((list) => {
        if (cancelled) return
        setClients(
          list
            .filter((client) => !client.revokedAt)
            .map((client) => ({ id: bridgeCallerForClientId(client.id), name: client.name }))
        )
      })
      .catch(() => {
        // No host-managed client store (older host / web): stdio still works.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const callers: BridgeCaller[] = useMemo(
    () => [{ id: STDIO_BRIDGE_CALLER, name: t("workspace.stdioClient") }, ...clients],
    [clients, t]
  )
  const scopesEnabled = WORKSPACE_SCOPES.some((scope) => settings.enabledScopes.includes(scope))

  return (
    <div className="space-y-4">
      <SettingsCard title={t("workspace.title")} description={t("workspace.description")}>
        {!scopesEnabled && (
          <p
            className="rounded border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
            data-testid="bridge-workspace-scopes-off"
          >
            {t("workspace.scopesOff")}
          </p>
        )}
        {roots.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="bridge-workspace-no-roots">
            {t("workspace.noRoots")}
          </p>
        ) : (
          <div className="space-y-4">
            {callers.map((caller) => {
              const granted = new Set(settings.workspaceGrants?.[caller.id] ?? [])
              const count = roots.filter((root) => granted.has(root.id)).length
              return (
                <div
                  key={caller.id}
                  className="space-y-2"
                  data-testid={`bridge-workspace-caller-${caller.id}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold">{caller.name}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{caller.id}</span>
                    <Badge variant={count > 0 ? "secondary" : "outline"} className="text-[10px]">
                      {count > 0
                        ? t("workspace.grantedCount", { count })
                        : t("workspace.noneGranted")}
                    </Badge>
                  </div>
                  <div className="space-y-1.5">
                    {roots.map((root) => (
                      <div
                        key={root.id}
                        className="flex items-center justify-between gap-3 rounded border bg-card px-3 py-2"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <FolderGit2Icon
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <div className="min-w-0">
                            <Label className="block truncate text-xs">{root.label}</Label>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {root.workspace} · {root.path}
                            </p>
                          </div>
                        </div>
                        <Switch
                          checked={granted.has(root.id)}
                          onCheckedChange={(value) =>
                            onChange(toggleWorkspaceGrant(settings, caller.id, root.id, value))
                          }
                          aria-label={t("workspace.toggleAria", {
                            client: caller.name,
                            root: root.label,
                          })}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SettingsCard>
    </div>
  )
}
