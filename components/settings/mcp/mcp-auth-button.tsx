"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { KeyRoundIcon, Loader2Icon, LogOutIcon, ShieldCheckIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { mcpOAuthAuthenticate, mcpOAuthClear } from "@/lib/mcp/oauth-tauri"
import { useMcpOAuthStatus } from "@/hooks/mcp/use-mcp-oauth-status"
import type { McpServer } from "@cognia/agent-config-types"

export interface McpAuthButtonProps {
  server: McpServer
}

/**
 * Per-server OAuth affordance for the MCP panel. stdio servers render nothing
 * (OAuth applies to remote transports only). Remote servers show an auth-status
 * pill plus Authenticate / Re-authenticate / Sign-out actions. The interactive
 * flow runs in a Node helper spawned by the Tauri `mcp_oauth_authenticate`
 * command; tokens land in the OS keyring and are injected as a bearer header at
 * send time (the Agent SDK exposes no live `authProvider`, hence the note).
 */
export function McpAuthButton({ server }: McpAuthButtonProps) {
  const t = useTranslations("mcp.auth")
  const { status, refetch } = useMcpOAuthStatus(server.id, server.transport, server.name)
  const [busy, setBusy] = useState(false)

  if (server.transport === "stdio") return null

  const authenticate = async () => {
    if (busy) return
    if (!isTauri()) {
      toast.error(t("desktopOnly"))
      return
    }
    setBusy(true)
    try {
      const res = await mcpOAuthAuthenticate(server.id, {
        transport: server.transport,
        config: server.config,
      })
      if (res.ok) toast.success(t("success", { name: server.name }))
      else if (res.status === "denied") toast.error(t("denied", { name: server.name }))
      else toast.error(t("error", { name: server.name, message: res.message }))
      await refetch()
    } catch (err) {
      toast.error(
        t("error", { name: server.name, message: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    if (busy) return
    setBusy(true)
    try {
      await mcpOAuthClear(server.id, server.name)
      await refetch()
    } finally {
      setBusy(false)
    }
  }

  const pill = (() => {
    if (status === "loading") return null
    if (status === "authorized")
      return {
        label: t("statusAuthorized"),
        cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      }
    if (status === "expired")
      return {
        label: t("statusExpired"),
        cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
      }
    return { label: t("statusNone"), cls: "bg-muted text-muted-foreground" }
  })()

  const hasToken = status === "authorized" || status === "expired"

  return (
    <div
      className="flex items-center gap-1.5"
      data-testid="mcp-auth-button"
      title={t("anthropicHeaderNote")}
    >
      {pill ? (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
            pill.cls
          )}
        >
          <ShieldCheckIcon className="size-3" />
          {pill.label}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        onClick={() => void authenticate()}
        disabled={busy}
      >
        {busy ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : (
          <KeyRoundIcon className="size-3" />
        )}
        {hasToken ? t("reauthenticate") : t("authenticate")}
      </Button>
      {hasToken ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
          onClick={() => void signOut()}
          disabled={busy}
          aria-label={t("signOut")}
        >
          <LogOutIcon className="size-3" />
        </Button>
      ) : null}
    </div>
  )
}
