"use client"

import { FileIcon, FolderIcon, GlobeIcon, RefreshCwIcon, SquareIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { open as openDialog } from "@tauri-apps/plugin-dialog"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { detectDevServers, serveLocalFile, stopLocalFile } from "@/lib/browser/local-content-client"

type DevServer = Awaited<ReturnType<typeof detectDevServers>>[number]
type Served = { root: string; url: string; path: string }

type ServersState =
  { kind: "loading" } | { kind: "ready"; servers: DevServer[] } | { kind: "failed" }

/**
 * Open local content in the browser pane (ADR-0201): a file or folder served
 * by Rust's loopback static server under a random prefix (so relative assets
 * resolve and the `localhost` trust tier applies), or a dev server detected
 * among this machine's loopback listeners. Folders shared from here are listed
 * with a stop control; they are otherwise served until the app exits.
 */
export function BrowserLocalContentPicker({ onOpen }: { onOpen: (url: string) => void }) {
  const t = useTranslations("browserVault.localContent")
  const tCommon = useTranslations("browserVault.common")
  const [servers, setServers] = useState<ServersState>({ kind: "loading" })
  const [refreshing, setRefreshing] = useState(false)
  const [serving, setServing] = useState<"file" | "folder" | null>(null)
  const [served, setServed] = useState<Served[]>([])

  const load = useCallback(
    (): Promise<ServersState> =>
      detectDevServers().then(
        (next): ServersState => ({
          kind: "ready",
          servers: [...next].sort((a, b) => a.port - b.port),
        }),
        (): ServersState => ({ kind: "failed" })
      ),
    []
  )

  useEffect(() => {
    let current = true
    void load().then((next) => {
      if (current) setServers(next)
    })
    return () => {
      current = false
    }
  }, [load])

  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    setServers(await load())
    setRefreshing(false)
  }

  const pick = async (directory: boolean) => {
    if (serving) return
    setServing(directory ? "folder" : "file")
    try {
      const picked = await openDialog({ multiple: false, directory })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (!path) return
      const result = await serveLocalFile(path)
      setServed((current) => [
        ...current.filter((item) => item.root !== result.root),
        { root: result.root, url: result.url, path },
      ])
      onOpen(result.url)
    } catch {
      toast.error(t("serveFailed"))
    } finally {
      setServing(null)
    }
  }

  const stop = async (item: Served) => {
    try {
      await stopLocalFile(item.root)
      setServed((current) => current.filter((entry) => entry.root !== item.root))
    } catch {
      toast.error(t("stopFailed"))
    }
  }

  return (
    <section aria-labelledby="browser-local-content-title" className="grid gap-4">
      <h2 id="browser-local-content-title" className="text-sm font-semibold">
        {t("title")}
      </h2>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={serving !== null}
          onClick={() => void pick(false)}
        >
          {serving === "file" ? <Spinner /> : <FileIcon />}
          {serving === "file" ? t("serving") : t("openFile")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={serving !== null}
          onClick={() => void pick(true)}
        >
          {serving === "folder" ? <Spinner /> : <FolderIcon />}
          {serving === "folder" ? t("serving") : t("openFolder")}
        </Button>
      </div>

      {served.length > 0 && (
        <div className="grid gap-2">
          <div className="space-y-0.5">
            <h3 className="text-xs font-medium text-muted-foreground">{t("served")}</h3>
            <p className="text-xs text-muted-foreground">{t("servedDescription")}</p>
          </div>
          <ul className="divide-y rounded-md border" aria-label={t("served")}>
            {served.map((item) => (
              <li key={item.root} className="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  className="min-w-0 truncate text-left text-sm hover:underline"
                  onClick={() => onOpen(item.url)}
                >
                  {item.path}
                </button>
                <Button size="sm" variant="ghost" onClick={() => void stop(item)}>
                  <SquareIcon />
                  {t("stop")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">{t("devServers")}</h3>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={tCommon("refresh")}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? <Spinner /> : <RefreshCwIcon />}
          </Button>
        </div>
        {servers.kind === "loading" ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            {tCommon("loading")}
          </p>
        ) : servers.kind === "failed" ? (
          <p role="alert" className="text-sm text-destructive">
            {t("devServersFailed")}
          </p>
        ) : servers.servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("devServersEmpty")}</p>
        ) : (
          <ul className="grid gap-1">
            {servers.servers.map((server) => (
              <li key={server.url}>
                <button
                  type="button"
                  aria-label={t("openServer", { url: server.url })}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => onOpen(server.url)}
                >
                  <GlobeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{server.title || server.url}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {server.process
                      ? t("portWithProcess", { port: server.port, process: server.process })
                      : t("port", { port: server.port })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
