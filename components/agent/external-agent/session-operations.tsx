"use client"

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import type { SessionCreateOptions } from "@/lib/ai/agent/external/protocol-adapter"
import type {
  ExternalAgentSessionInput,
  ExternalAgentSessionEntry,
  ExternalAgentSessionOperationCapabilities,
  ExternalAgentSessionRuntimeState,
  ExternalAgentSessionShellResult,
  ExternalAgentSessionTree,
  ExternalAgentSessionTreeNode,
} from "@cognia/agent-contracts/session-operations"

export type SessionOperationsManager = Pick<
  import("@/lib/ai/agent/external/manager").ExternalAgentManager,
  | "refreshSessionCommands"
  | "getSessionOperationCapabilities"
  | "getSessionRuntimeState"
  | "enqueueSessionInput"
  | "clearSessionInputQueue"
  | "setSessionRuntimeControls"
  | "setSessionQueuePolicy"
  | "abortSessionRetry"
  | "abortSessionShell"
  | "renameSession"
  | "archiveSession"
  | "unarchiveSession"
  | "exportSessionHtml"
  | "getSessionTree"
  | "getSessionEntries"
>
interface Props {
  manager?: SessionOperationsManager
  agentId: string
  sessionId: string
  isExecuting: boolean
  onFork: (options: SessionCreateOptions) => Promise<unknown>
  onClone: () => Promise<unknown>
  onShell: (
    command: string,
    options: { excludeFromContext: boolean }
  ) => Promise<ExternalAgentSessionShellResult>
}

/** Shared optional operations, independent of the concrete runtime protocol. */
export function ExternalAgentSessionOperations(props: Props) {
  const t = useTranslations("externalAgent.sessionOperations")
  const [open, setOpen] = useState(false)
  const [capabilities, setCapabilities] = useState<ExternalAgentSessionOperationCapabilities>()
  const [state, setState] = useState<ExternalAgentSessionRuntimeState>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [input, setInput] = useState<ExternalAgentSessionInput>({ text: "" })
  const [name, setName] = useState("")
  const [shell, setShell] = useState("")
  const [exclude, setExclude] = useState(false)
  const [shellOutput, setShellOutput] = useState<ExternalAgentSessionShellResult>()
  const [tree, setTree] = useState<ExternalAgentSessionTree>()
  const [entries, setEntries] = useState<ExternalAgentSessionEntry[]>()
  const entryText = useMemo(
    () => (entries === undefined ? undefined : JSON.stringify(entries, null, 2)),
    [entries]
  )
  const alive = useRef(true)
  const busy = useRef(false)
  const manager = props.manager ?? getExternalAgentManager()
  const { agentId, sessionId } = props
  const args = [agentId, sessionId] as const
  const can = (key: keyof ExternalAgentSessionOperationCapabilities) =>
    capabilities?.[key] === "supported"

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void manager
      .getSessionOperationCapabilities(agentId, sessionId)
      .then(async (caps) => {
        if (cancelled) return
        setCapabilities(caps)
        if (caps.runtimeState === "supported") {
          const next = await manager.getSessionRuntimeState(agentId, sessionId)
          if (!cancelled) setState(next)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open, manager, agentId, sessionId])

  async function run(work: () => Promise<unknown>) {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(undefined)
    setNotice(undefined)
    try {
      await work()
      if (alive.current && can("runtimeState")) {
        const next = await manager.getSessionRuntimeState(...args)
        if (alive.current) setState(next)
      }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      busy.current = false
      if (alive.current) setPending(false)
    }
  }

  async function attach(files: FileList | null) {
    if (Array.from(files ?? []).reduce((sum, file) => sum + file.size, 0) > 10 * 1024 * 1024) {
      throw new Error(t("invalidImage"))
    }
    const images = await Promise.all(
      Array.from(files ?? []).map(
        (file) =>
          new Promise<{ data: string; mimeType: string }>((resolve, reject) => {
            if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > 10 * 1024 * 1024) {
              reject(new Error(t("invalidImage")))
              return
            }
            const reader = new FileReader()
            reader.onerror = () => reject(new Error(t("invalidImage")))
            reader.onload = () =>
              resolve({ data: String(reader.result).split(",")[1], mimeType: file.type })
            reader.readAsDataURL(file)
          })
      )
    )
    if (alive.current) setInput((current) => ({ ...current, images }))
  }

  function enqueue(mode: "steer" | "follow_up") {
    void run(async () => {
      const result = await manager.enqueueSessionInput(...args, input, mode)
      if (alive.current) {
        setInput({ text: "" })
        setNotice(t(result.disposition))
      }
    })
  }

  function setQueuePolicy(event: ChangeEvent<HTMLSelectElement>) {
    const { name: key, value } = event.currentTarget
    if (key !== "steering" && key !== "followUp") return
    if (value !== "all" && value !== "one-at-a-time") return
    void run(() => manager.setSessionQueuePolicy(...args, { [key]: value }))
  }

  function setRuntimeControl(event: ChangeEvent<HTMLSelectElement>) {
    const { name: key, value } = event.currentTarget
    if (key !== "autoCompaction" && key !== "autoRetry") return
    void run(() => manager.setSessionRuntimeControls(...args, { [key]: value === "true" }))
  }

  function renderNodes(nodes: ExternalAgentSessionTreeNode[], depth = 0): React.ReactNode {
    return nodes.map(({ entry, children }) => (
      <li key={entry.id} className="space-y-1">
        <div className="flex items-center gap-2" style={{ paddingInlineStart: depth * 12 }}>
          <span className="min-w-0 truncate text-xs">
            {entry.message?.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(" ") || entry.type}
          </span>
          {tree?.leafId === entry.id && (
            <span className="text-xs text-muted-foreground">{t("current")}</span>
          )}
          {can("forkAtEntry") && (entry.forkAt || entry.message?.role === "user") && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || props.isExecuting}
              onClick={() =>
                void run(() =>
                  props.onFork(
                    entry.forkAt ? { forkAt: entry.forkAt } : { forkAtEntryId: entry.id }
                  )
                )
              }
            >
              {t("forkHere")}
            </Button>
          )}
        </div>
        {children.length > 0 && <ul>{renderNodes(children, depth + 1)}</ul>}
      </li>
    ))
  }

  return (
    <details className="w-full text-sm" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer py-1">{t("title")}</summary>
      {open && (
        <div className="flex flex-col gap-3 py-2">
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="break-all">
              {notice}
            </p>
          )}
          {!capabilities && !error && <p>{t("loading")}</p>}
          {capabilities &&
            !Object.entries(capabilities).some(
              ([key, value]) => key !== "backgroundTurns" && value === "supported"
            ) && <p>{t("unsupported")}</p>}
          {can("commands") && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void run(() => manager.refreshSessionCommands(...args))}
            >
              {t("refreshCommands")}
            </Button>
          )}
          {can("inputQueue") && (
            <fieldset className="space-y-2">
              <legend>{t("queuedInput")}</legend>
              <Textarea
                aria-label={t("queuedInput")}
                disabled={pending}
                value={input.text}
                onChange={(event) =>
                  setInput((current) => ({ ...current, text: event.target.value }))
                }
              />
              <Input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                aria-label={t("images")}
                disabled={pending}
                onChange={(event) => void run(() => attach(event.target.files))}
              />
              {Boolean(input.images?.length) && (
                <p>{t("imageCount", { count: input.images!.length })}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {(["steer", "follow_up"] as const).map((mode) => (
                  <Button
                    key={mode}
                    variant="outline"
                    disabled={
                      pending || !props.isExecuting || (!input.text.trim() && !input.images?.length)
                    }
                    onClick={() => enqueue(mode)}
                  >
                    {t(mode)}
                  </Button>
                ))}
                {can("clearQueue") && (
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      void run(async () => {
                        const result = await manager.clearSessionInputQueue(...args)
                        if (alive.current)
                          setInput((current) => ({
                            text: [
                              current.text,
                              ...result.steering.map((item) => item.text),
                              ...result.followUp.map((item) => item.text),
                            ]
                              .filter(Boolean)
                              .join("\n\n"),
                            images: [
                              ...(current.images ?? []),
                              ...result.steering.flatMap((item) => item.images ?? []),
                              ...result.followUp.flatMap((item) => item.images ?? []),
                            ],
                          }))
                      })
                    }
                  >
                    {t("restoreQueue")}
                  </Button>
                )}
              </div>
            </fieldset>
          )}
          {can("queuePolicy") &&
            (["steering", "followUp"] as const).map((key) => (
              <label key={key} className="flex items-center justify-between gap-2">
                {t(key)}
                <select
                  className="rounded border bg-background p-1"
                  aria-label={t(key)}
                  value={state?.queuePolicy[key] ?? ""}
                  disabled={pending}
                  name={key}
                  onChange={setQueuePolicy}
                >
                  <option value="" disabled>
                    {t("unknown")}
                  </option>
                  <option value="all">{t("all")}</option>
                  <option value="one-at-a-time">{t("oneAtATime")}</option>
                </select>
              </label>
            ))}
          {can("runtimeControls") &&
            (["autoCompaction", "autoRetry"] as const).map((key) => (
              <label key={key} className="flex items-center justify-between gap-2">
                {t(key)}
                <select
                  className="rounded border bg-background p-1"
                  aria-label={t(key)}
                  value={state?.controls[key] === undefined ? "" : String(state.controls[key])}
                  disabled={pending}
                  name={key}
                  onChange={setRuntimeControl}
                >
                  <option value="" disabled>
                    {t("unknown")}
                  </option>
                  <option value="true">{t("enabled")}</option>
                  <option value="false">{t("disabled")}</option>
                </select>
              </label>
            ))}
          {can("abortRetry") && (
            <Button
              variant="outline"
              onClick={() => {
                void manager
                  .abortSessionRetry(...args)
                  .catch((err: unknown) => setError(String(err)))
              }}
            >
              {t("stopRetry")}
            </Button>
          )}
          {can("rename") && (
            <div className="flex gap-2">
              <Input
                aria-label={t("sessionName")}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Button
                disabled={pending || !name.trim()}
                onClick={() => void run(() => manager.renameSession(...args, name.trim()))}
              >
                {t("rename")}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {(["archive", "unarchive"] as const).map(
              (operation) =>
                can(operation) && (
                  <Button
                    key={operation}
                    variant="outline"
                    disabled={pending || props.isExecuting}
                    onClick={() =>
                      void run(() =>
                        operation === "archive"
                          ? manager.archiveSession(...args)
                          : manager.unarchiveSession(...args)
                      )
                    }
                  >
                    {t(operation)}
                  </Button>
                )
            )}
            {can("clone") && (
              <Button
                variant="outline"
                disabled={pending || props.isExecuting}
                onClick={() => void run(props.onClone)}
              >
                {t("clone")}
              </Button>
            )}
            {can("tree") && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    const result = await manager.getSessionTree(...args)
                    if (alive.current) setTree(result)
                  })
                }
              >
                {t("loadTree")}
              </Button>
            )}
            {can("entries") && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    const entries = await manager.getSessionEntries(...args)
                    if (alive.current) setEntries(entries)
                  })
                }
              >
                {t("loadEntries")}
              </Button>
            )}
            {can("exportHtml") && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    const result = await manager.exportSessionHtml(...args)
                    if (!alive.current) return
                    if (result.html !== undefined) {
                      const url = URL.createObjectURL(
                        new Blob([result.html], { type: "text/html" })
                      )
                      const link = document.createElement("a")
                      link.href = url
                      link.download = "session.html"
                      link.click()
                      setTimeout(() => URL.revokeObjectURL(url), 1000)
                    }
                    setNotice(result.path ? t("exported", { path: result.path }) : t("downloaded"))
                  })
                }
              >
                {t("exportHtml")}
              </Button>
            )}
          </div>
          {tree && <ul className="max-h-64 overflow-auto">{renderNodes(tree.roots)}</ul>}
          {entries && entries.length > 0 && (
            <ul className="max-h-64 overflow-auto">
              {renderNodes(entries.map((entry) => ({ entry, children: [] })))}
            </ul>
          )}
          {entryText !== undefined && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
              {entryText || t("empty")}
            </pre>
          )}
          {can("shell") && (
            <fieldset className="space-y-2">
              <legend>{t("shell")}</legend>
              <Input
                aria-label={t("shell")}
                value={shell}
                onChange={(event) => setShell(event.target.value)}
              />
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={exclude}
                  onChange={(event) => setExclude(event.target.checked)}
                />
                {t("excludeContext")}
              </label>
              <div className="flex gap-2">
                <Button
                  disabled={pending || props.isExecuting || !shell.trim()}
                  onClick={() =>
                    void run(async () => {
                      const result = await props.onShell(shell, { excludeFromContext: exclude })
                      if (alive.current) setShellOutput(result)
                    })
                  }
                >
                  {t("runShell")}
                </Button>
                {can("abortShell") && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      void manager
                        .abortSessionShell(...args)
                        .catch((err: unknown) => setError(String(err)))
                    }}
                  >
                    {t("stopShell")}
                  </Button>
                )}
              </div>
              {shellOutput && (
                <div>
                  <p>
                    {t("exitCode", { code: shellOutput.exitCode ?? t("unknown") })}
                    {shellOutput.cancelled && ` · ${t("cancelled")}`}
                    {shellOutput.truncated && ` · ${t("truncated")}`}
                  </p>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                    {shellOutput.output}
                  </pre>
                </div>
              )}
            </fieldset>
          )}
        </div>
      )}
    </details>
  )
}
