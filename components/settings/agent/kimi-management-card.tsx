"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Copy, ExternalLink, Terminal } from "lucide-react"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { toast } from "@/components/ui/sonner"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { detectPlatform } from "@/lib/terminal/shell-detect"
import { selectTerminalTransport } from "@/lib/terminal/pick-transport"
import {
  resolveIsolatedTerminalEnv,
  type IsolatedTerminalEnv,
} from "@/lib/ai/agent/external/lifecycle/isolated-terminal-env"
import { runInTerminalDock } from "@/lib/terminal/run-in-dock"
import { shellQuote } from "@/lib/mcp/config-transfer"
import {
  kimiManagementCommand,
  type KimiManagementAction,
} from "@/lib/agent-ecosystem/kimi-management"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import { useExternalAgentStore, type ExternalAgentStore } from "@/stores/agent/external-agent-store"

const ACTIONS: readonly KimiManagementAction[] = [
  "install",
  "restore",
  "upgrade",
  "uninstall",
  "doctor",
  "native",
  "web",
  "migrate",
]
const PACKAGE_ACTIONS = new Set<KimiManagementAction>([
  "install",
  "restore",
  "upgrade",
  "uninstall",
])

/** Native management remains a user-operated terminal with its own policy. */
export function KimiManagementCard({ agent }: { agent: ExternalAgentConfig }) {
  return <KimiManagementSession key={agent.id} agent={agent} />
}

function KimiManagementSession({ agent }: { agent: ExternalAgentConfig }) {
  const t = useTranslations("kimiManagement")
  const tTerminal = useTranslations("externalAgent.settings.isolatedTerminal")
  const [terminalState, setTerminalState] = useState<{
    config: ExternalAgentConfig
    result: IsolatedTerminalEnv
  } | null>(null)
  useEffect(() => {
    let cancelled = false
    if (agent.stateIsolation !== "isolated") return
    void resolveIsolatedTerminalEnv(agent).then(
      (result) => {
        if (!cancelled) setTerminalState({ config: agent, result })
      },
      () => {
        if (!cancelled)
          setTerminalState({
            config: agent,
            result: { kind: "unavailable", reason: "no-state-root" },
          })
      }
    )
    return () => {
      cancelled = true
    }
  }, [agent])
  const terminalEnv: IsolatedTerminalEnv | undefined =
    agent.stateIsolation !== "isolated"
      ? { kind: "shared" }
      : terminalState?.config === agent
        ? terminalState.result
        : undefined
  const terminalReason = !terminalEnv
    ? tTerminal("loading")
    : terminalEnv.kind === "unavailable"
      ? tTerminal(terminalEnv.reason)
      : undefined
  // The recipe embeds the home too, so a stale process.env cannot override the resolved root.
  const terminalAgent =
    terminalEnv?.kind === "isolated"
      ? {
          ...agent,
          process: { ...agent.process!, env: { ...agent.process?.env, ...terminalEnv.env } },
        }
      : agent
  const [busy, setBusy] = useState(false)
  const [sessionId, setSessionId] = useState("")
  const [confirmation, setConfirmation] = useState<{
    action: KimiManagementAction
    command: string
  } | null>(null)
  const packageBlocked = (state: ExternalAgentStore) =>
    state.getConnectionStatus(agent.id) !== "disconnected" ||
    Object.values(state.agents).some(
      (configured) =>
        (configured.metadata?.preset === "kimi" ||
          configured.metadata?.ecosystemAdapterId === "kimi" ||
          /(?:^|[\\/])kimi(?:\.exe|\.cmd)?$/i.test(configured.process?.command ?? "")) &&
        ["connected", "connecting", "reconnecting"].includes(
          state.getConnectionStatus(configured.id)
        )
    )
  const isPackageBlocked = useExternalAgentStore(packageBlocked)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const canLaunch = selectTerminalTransport() === "tauri-channel" && detectPlatform() !== "windows"

  const perform = async (
    action: KimiManagementAction,
    launch: boolean,
    reviewedCommand?: string
  ) => {
    setBusy(true)
    try {
      if (!terminalEnv || terminalEnv.kind === "unavailable") return
      const command = kimiManagementCommand(terminalAgent, action, sessionId)
      if (launch) {
        if (selectTerminalTransport() !== "tauri-channel" || detectPlatform() === "windows") {
          throw new Error("local POSIX terminal required")
        }
        if (
          PACKAGE_ACTIONS.has(action) &&
          (command !== reviewedCommand || packageBlocked(useExternalAgentStore.getState()))
        ) {
          throw new Error("package action requires reviewed command and disconnected agent")
        }
        // The wrapper makes command quoting independent of the user's selected
        // terminal shell. Local POSIX hosts only; never send state paths to a
        // remote terminal or weaken the external-agent sandbox policy.
        await runInTerminalDock(
          `/bin/sh -c ${shellQuote(command)}`,
          agent.process?.cwd ?? "",
          "",
          terminalEnv.kind === "isolated" ? { env: terminalEnv.env } : {}
        )
        if (mounted.current) toast.success(t("opened"))
      } else {
        await writeClipboardText(command)
        if (mounted.current) toast.success(t("copied"))
      }
    } catch {
      if (mounted.current) toast.error(t("failed"))
    } finally {
      if (mounted.current) {
        setBusy(false)
        setConfirmation(null)
      }
    }
  }

  return (
    <SettingsBlock title={t("title")} description={t("ownership")} headingLevel={4}>
      <p className="text-xs text-muted-foreground">{t("terminalPolicy")}</p>
      {terminalReason && <p className="text-xs text-muted-foreground">{terminalReason}</p>}
      <div className="divide-y divide-border/60">
        {ACTIONS.map((action) => {
          let command = ""
          try {
            command = kimiManagementCommand(terminalAgent, action)
          } catch {
            /* Invalid config is surfaced by the disabled action. */
          }
          return (
            <div key={action} className="space-y-1 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium">{t(`actions.${action}`)}</span>
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !!terminalReason || !command}
                    onClick={() => void perform(action, false)}
                    aria-label={t("copyAction", { action: t(`actions.${action}`) })}
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" />
                    {t("copy")}
                  </Button>
                  {(PACKAGE_ACTIONS.has(action) ||
                    action === "native" ||
                    action === "web" ||
                    action === "doctor") && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy ||
                        !command ||
                        !canLaunch ||
                        !!terminalReason ||
                        (PACKAGE_ACTIONS.has(action) && isPackageBlocked)
                      }
                      onClick={() => {
                        if (PACKAGE_ACTIONS.has(action)) setConfirmation({ action, command })
                        else void perform(action, true)
                      }}
                      aria-label={t("openAction", { action: t(`actions.${action}`) })}
                    >
                      <Terminal className="mr-1 h-3.5 w-3.5" />
                      {t("openTerminal")}
                    </Button>
                  )}
                </div>
              </div>
              <code className="block break-all text-xs">
                {command || t("invalidConfiguration")}
              </code>
              <p className="text-xs text-muted-foreground">{t(`notes.${action}`)}</p>
            </div>
          )
        })}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`kimi-export-${agent.id}`}>{t("exportSession")}</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={`kimi-export-${agent.id}`}
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            placeholder={t("sessionPlaceholder")}
          />
          <Button
            variant="outline"
            disabled={busy || !!terminalReason || !sessionId.trim() || sessionId.startsWith("-")}
            onClick={() => void perform("export", false)}
          >
            {t("copyExport")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("exportNote")}</p>
      </div>
      <p className="text-xs text-muted-foreground">{t("quota")}</p>
      <p className="text-xs text-muted-foreground">{t("extensions")}</p>
      {isPackageBlocked && (
        <p className="text-xs text-muted-foreground">{t("disconnectForPackage")}</p>
      )}
      {!canLaunch && <p className="text-xs text-muted-foreground">{t("localTerminalRequired")}</p>}
      <div className="flex flex-wrap gap-3 text-xs">
        {(["kimi-command", "server-api"] as const).map((page) => (
          <a
            key={page}
            href={`https://www.kimi.com/code/docs/en/kimi-code-cli/reference/${page}.html`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t(page === "server-api" ? "serverDocs" : "cliDocs")}
          </a>
        ))}
      </div>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("confirmTitle", {
                action: confirmation ? t(`actions.${confirmation.action}`) : "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("confirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <code className="break-all text-xs">{confirmation?.command}</code>
          <p className="text-xs text-muted-foreground">{t("ownership")}</p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || isPackageBlocked || !canLaunch || !!terminalReason}
              onClick={(event) => {
                event.preventDefault()
                if (confirmation) void perform(confirmation.action, true, confirmation.command)
              }}
            >
              {t("confirmRun")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsBlock>
  )
}
