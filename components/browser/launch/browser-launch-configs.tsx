"use client"

import { PlayIcon, RefreshCwIcon, RocketIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useEffectiveCwd } from "@/hooks/chat/use-effective-cwd"
import {
  buildLaunchCommand,
  launchPort,
  loadLaunchConfigs,
  startLaunchConfiguration,
  type LaunchConfigFile,
  type LaunchConfiguration,
} from "@/lib/browser/launch-config"
import { detectDevServers } from "@/lib/browser/local-content-client"
import { useSessionStore } from "@/stores/chat/session-store"

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; file: LaunchConfigFile | null; listening: ReadonlySet<number> }
  | { kind: "failed"; message: string }

export interface BrowserLaunchConfigsProps {
  /** The chat session whose working directory holds the launch file. */
  sessionId: string | null
  /** Open a page once its server answers. */
  onOpen: (url: string) => void
}

/**
 * The project's launch configurations (`.cognia/launch.json` or
 * `.claude/launch.json` in the task's working directory) as one-click
 * "start the dev server and open it" rows. Starting types the command into a
 * new integrated-terminal tab and waits for the configured port; a server that
 * already answers is opened without starting a second one.
 */
export function BrowserLaunchConfigs({ sessionId, onOpen }: BrowserLaunchConfigsProps) {
  const t = useTranslations("browserVault.launch")
  const session = useSessionStore((state) =>
    sessionId ? (state.sessions.find((s) => s.id === sessionId) ?? null) : null
  )
  const root = useEffectiveCwd(session)
  const [state, setState] = useState<LoadState>({ kind: "loading" })
  const [starting, setStarting] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const load = useCallback(async (dir: string): Promise<LoadState> => {
    try {
      const file = await loadLaunchConfigs(dir)
      const listening = file
        ? new Set((await detectDevServers().catch(() => [])).map((server) => server.port))
        : new Set<number>()
      return { kind: "ready", file, listening }
    } catch (error) {
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) }
    }
  }, [])

  useEffect(() => {
    if (!root) return
    let current = true
    void load(root).then((next) => {
      if (current) setState(next)
    })
    return () => {
      current = false
    }
  }, [load, root])

  useEffect(() => () => abort.current?.abort(), [])

  if (!root) return null

  const refresh = async () => {
    setState({ kind: "loading" })
    setState(await load(root))
  }

  const start = async (config: LaunchConfiguration) => {
    if (starting || !sessionId) return
    setStarting(config.name)
    abort.current = new AbortController()
    try {
      const outcome = await startLaunchConfiguration({
        config,
        root,
        chatSessionId: sessionId,
        signal: abort.current.signal,
      })
      if (outcome.kind === "ready" || outcome.kind === "reused") onOpen(outcome.url)
      else if (outcome.kind === "started") toast.success(t("started", { name: config.name }))
      else toast.error(t("timeout", { name: config.name, port: outcome.port }))
    } catch (error) {
      toast.error(
        t("startFailed", {
          name: config.name,
          message: error instanceof Error ? error.message : String(error),
        })
      )
    } finally {
      abort.current = null
      setStarting(null)
      void load(root).then(setState)
    }
  }

  return (
    <div className="space-y-1" data-testid="browser-launch-configs">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">{t("title")}</p>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="size-6"
          aria-label={t("refresh")}
          disabled={state.kind === "loading" || starting !== null}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      {state.kind === "loading" ? (
        <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          {t("loading")}
        </div>
      ) : state.kind === "failed" ? (
        <p className="px-2 text-xs text-destructive" data-testid="browser-launch-configs-failed">
          {t("failed", { message: state.message })}
        </p>
      ) : !state.file || state.file.configurations.length === 0 ? (
        <p
          className="px-2 text-xs text-muted-foreground"
          data-testid="browser-launch-configs-empty"
        >
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-0.5">
          {state.file.configurations.map((config) => {
            const port = launchPort(config)
            const running = port !== null && state.listening.has(port)
            const busy = starting === config.name
            return (
              <li key={config.name}>
                <button
                  type="button"
                  className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-60"
                  title={buildLaunchCommand(config)}
                  aria-label={
                    running ? t("open", { name: config.name }) : t("start", { name: config.name })
                  }
                  disabled={starting !== null}
                  onClick={() => void start(config)}
                  data-testid={`browser-launch-config-${config.name}`}
                >
                  {busy ? (
                    <Spinner className="size-4 shrink-0" />
                  ) : running ? (
                    <PlayIcon className="size-4 shrink-0 text-emerald-500" />
                  ) : (
                    <RocketIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{config.name}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {buildLaunchCommand(config)}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {busy
                      ? t("starting")
                      : running
                        ? t("running", { port: port ?? 0 })
                        : port
                          ? `:${port}`
                          : null}
                  </span>
                </button>
              </li>
            )
          })}
          {state.file.invalid > 0 ? (
            <li className="px-2 text-[11px] text-muted-foreground">
              {t("invalid", { count: state.file.invalid })}
            </li>
          ) : null}
        </ul>
      )}
    </div>
  )
}
