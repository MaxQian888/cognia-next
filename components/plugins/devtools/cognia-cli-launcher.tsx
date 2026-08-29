"use client"

/**
 * DevTools launcher for the `cognia` plugin-author CLI. Picks a plugin
 * project directory (persisted) and runs `cognia plugin <cmd>` in a fresh
 * terminal dock tab where the developer can interact with it directly
 * (dialoguer prompts, the `dev` watch loop, progress bars).
 *
 * Acquisition + presence is handled by the sibling `CogniaCliStatusCard`
 * (rendered above this in the CLI tab); here we only gate the run buttons
 * on that same `useCogniaCliStatus` probe and point the user upward when
 * the CLI is missing.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  FolderOpenIcon,
  HammerIcon,
  ListChecksIcon,
  Loader2Icon,
  PackageIcon,
  PlayIcon,
  SparklesIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { InstalledMarker } from "@/components/plugins/_shared/installed-marker"
import { useCogniaCliStatus } from "@/hooks/plugins/use-cognia-cli-status"
import { useDevProjectStore } from "@/stores/plugins/dev-project-store"
import { usePluginDevSessionStore } from "@/stores/plugins/plugin-dev-session-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { launchCognia } from "@/lib/terminal/run-cognia"
import { previewLocalManifest } from "@/lib/plugin/local/install-from-directory"

type CommandKey = "build" | "dev" | "lint" | "new" | "install"

interface CommandDef {
  key: CommandKey
  /** Argv after `cognia` for the project-relative commands. */
  argv?: string
  icon: typeof HammerIcon
  /** Talks to the loopback CLI bridge — warn when it's down. */
  needsBridge?: boolean
}

const COMMANDS: CommandDef[] = [
  { key: "build", argv: "plugin build", icon: HammerIcon },
  { key: "dev", argv: "plugin dev", icon: PlayIcon, needsBridge: true },
  { key: "lint", argv: "plugin lint", icon: ListChecksIcon },
  { key: "new", argv: "plugin new", icon: SparklesIcon },
  { key: "install", icon: PackageIcon, needsBridge: true },
]

export function CogniaCliLauncher({ className }: { className?: string }) {
  const t = useTranslations("plugins.cliLauncher")
  const status = useCogniaCliStatus()
  const projectDir = useDevProjectStore((s) => s.projectDir)
  const projectName = useDevProjectStore((s) => s.projectName)
  const setProject = useDevProjectStore((s) => s.setProject)
  const [picking, setPicking] = useState(false)
  const [busyKey, setBusyKey] = useState<CommandKey | null>(null)

  const bridgeDown = !(status.bridge?.running ?? false)

  async function pickDirectory(): Promise<string | null> {
    const dialog = await import("@tauri-apps/plugin-dialog")
    const picked = await dialog.open({
      directory: true,
      multiple: false,
      title: t("pickProjectTitle"),
    })
    return typeof picked === "string" ? picked : null
  }

  async function handlePickProject() {
    setPicking(true)
    try {
      const picked = await pickDirectory()
      if (!picked) return
      let name: string | null = null
      try {
        const manifest = await previewLocalManifest(picked)
        name = manifest.name ?? null
      } catch {
        // No / invalid plugin.json — still selectable (e.g. for `new`), warn.
        toast.warning(t("invalidProject"))
      }
      setProject(picked, name)
    } finally {
      setPicking(false)
    }
  }

  async function run(
    command: string,
    key: CommandKey,
    needsBridge?: boolean,
    devSessionId?: string
  ) {
    if (needsBridge && bridgeDown) {
      toast.warning(t("bridgeWarning"))
    }
    setBusyKey(key)
    try {
      const outcome = await launchCognia({
        command,
        cwd: projectDir ?? "",
        store: useTerminalStore.getState(),
      })
      if (outcome.kind === "error") {
        toast.error(t("launchFailed", { message: outcome.message }))
      } else if (outcome.kind === "denied") {
        toast.error(t("launchDenied"))
      } else if (devSessionId) {
        usePluginDevSessionStore.getState().attachTerminal(devSessionId, outcome.sessionId)
      }
    } finally {
      setBusyKey(null)
    }
  }

  async function handleRun(cmd: CommandDef) {
    if (cmd.key === "install") {
      const dialog = await import("@tauri-apps/plugin-dialog")
      const picked = await dialog.open({
        multiple: false,
        title: t("pickBundleTitle"),
        filters: [{ name: t("bundleFilter"), extensions: ["zip"] }],
      })
      if (typeof picked !== "string") return
      // Quote the path so directories with spaces survive the shell.
      await run(`plugin install "${picked}"`, "install", cmd.needsBridge)
      return
    }
    if (!projectDir || !cmd.argv) return
    if (cmd.key === "dev") {
      const sessionId = crypto.randomUUID()
      await run(`${cmd.argv} --session-id ${sessionId}`, cmd.key, cmd.needsBridge, sessionId)
      return
    }
    await run(cmd.argv, cmd.key, cmd.needsBridge)
  }

  return (
    <Card className={className} data-testid="cognia-cli-launcher">
      <div className="p-4 space-y-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold">{t("title")}</h3>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>

        {!status.supported ? (
          <InstalledMarker desktopOnly />
        ) : (
          <>
            {/* Project picker */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handlePickProject()}
                disabled={picking}
                data-testid="cognia-cli-pick-project"
              >
                {picking ? (
                  <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <FolderOpenIcon className="mr-1.5 size-3.5" aria-hidden="true" />
                )}
                {t("pickProject")}
              </Button>
              {projectDir ? (
                <span
                  className="text-xs text-muted-foreground font-mono break-all"
                  data-testid="cognia-cli-project-dir"
                >
                  {projectName ? `${projectName} · ` : ""}
                  {projectDir}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">{t("noProject")}</span>
              )}
            </div>

            {!status.installed && (
              <p
                className="text-xs text-muted-foreground"
                role="status"
                data-testid="cognia-cli-launcher-missing"
              >
                {t("needsCli")}
              </p>
            )}

            {/* Command buttons */}
            <div className="flex flex-wrap gap-2">
              {COMMANDS.map((cmd) => {
                const Icon = cmd.icon
                const needsProject = cmd.key !== "install"
                const disabled =
                  !status.installed || busyKey !== null || (needsProject && !projectDir)
                return (
                  <Button
                    key={cmd.key}
                    size="sm"
                    variant={cmd.key === "build" || cmd.key === "dev" ? "default" : "outline"}
                    onClick={() => void handleRun(cmd)}
                    disabled={disabled}
                    data-testid={`cognia-cli-run-${cmd.key}`}
                  >
                    {busyKey === cmd.key ? (
                      <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Icon className="mr-1.5 size-3.5" aria-hidden="true" />
                    )}
                    {t(`cmd.${cmd.key}`)}
                  </Button>
                )
              })}
            </div>

            {bridgeDown && status.installed && (
              <p
                className="text-xs text-amber-600 dark:text-amber-500"
                data-testid="cognia-cli-bridge-hint"
              >
                {t("bridgeHint")}
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
