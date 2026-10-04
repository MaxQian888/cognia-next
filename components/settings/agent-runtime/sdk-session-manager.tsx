"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import {
  DatabaseIcon,
  EyeIcon,
  GitBranchIcon,
  LinkIcon,
  MessageSquareIcon,
  PencilIcon,
  RefreshCwIcon,
  TagsIcon,
  Trash2Icon,
} from "lucide-react"
import type { ChatSession, SDKMessage } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"
import type { UIMessage } from "ai"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LoadingRegion } from "@/components/ui/loading-region"
import { Skeleton } from "@/components/ui/skeleton"
import { TranscriptMessageList } from "@/components/chat/transcript-message-list"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import {
  linkedChatsFor,
  type SdkSessionLocator,
} from "@/components/settings/agent-runtime/sdk-bound-conversations"
import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import {
  deleteSdkSession,
  forkSdkSession,
  getSdkSessionInfo,
  getSdkSessionMessages,
  getSdkSubagentMessages,
  importSdkSessionToStore,
  listSdkSessions,
  listSdkSubagents,
  renameSdkSession,
  tagSdkSession,
} from "@/lib/claude/ipc"
import { applySdkEvent } from "@/lib/claude/adapter"
import {
  clearSessionSdkLink,
  listSessions as listChatSessions,
  updateSession,
} from "@/lib/db/sessions"
import { persistMessages } from "@/lib/db/messages"
import { startNewSession } from "@/lib/chat/start-session"
import { buildSessionHref } from "@/lib/chat/message-permalink"
import { isSessionExposed } from "@/lib/chat/session-exposure"
import { sessionDisplayTitle } from "@/lib/chat/placeholder-title"
import { useChatStore } from "@/stores/chat"
import { sdkSessionApiOptions, type SdkSessionStorage } from "@/lib/claude/claude-sdk-rollout"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { resolveEffectiveCwd } from "@/lib/workspace/effective-cwd"
import { resolveSessionWorkspace } from "@/lib/workspace/session-workspace"
import { resolveSessionWorkspaceRoot } from "@/lib/task-workspace/session-execution-context"
import { resolveCharacterById } from "@/lib/db/characters"
import { useAgentExecutionFlag } from "@/hooks/agent/use-agent-execution-flag"
import {
  agentHostAvailable,
  resolveAgentExecutionEnvironment,
} from "@/lib/ai/agent/execution/host-environment"

interface SdkSessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  customTitle?: string
  cwd?: string
  tag?: string
  gitBranch?: string
  storage?: "filesystem" | "host-sqlite"
  storageWorkspace?: string
}

interface SdkTranscriptPage {
  messages: UIMessage[]
  partial: boolean
}

function unwrapSdkItems(
  value: unknown,
  keys: readonly string[]
): { items: unknown[]; partial: boolean } {
  if (Array.isArray(value)) return { items: value, partial: false }
  if (!value || typeof value !== "object") return { items: [], partial: false }
  const record = value as Record<string, unknown>
  for (const key of ["items", ...keys]) {
    if (Array.isArray(record[key])) {
      return {
        items: record[key],
        partial: Boolean(record.nextCursor ?? record.next_cursor ?? record.hasMore),
      }
    }
  }
  return { items: [], partial: false }
}

function historicalUserMessage(event: SDKMessage): UIMessage | null {
  if (event.type !== "user") return null
  const record = event as unknown as Record<string, unknown>
  if (typeof record.uuid !== "string" || !record.message || typeof record.message !== "object") {
    return null
  }
  const content = (record.message as Record<string, unknown>).content
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (block): block is Record<string, unknown> =>
                Boolean(block) && typeof block === "object" && block.type === "text"
            )
            .map((block) => (typeof block.text === "string" ? block.text : ""))
            .join("\n")
            .trim()
        : ""
  if (!text) return null
  return {
    id: record.uuid,
    role: "user",
    parts: [{ type: "text", text }],
  }
}

export function foldSdkSessionMessages(value: unknown): SdkTranscriptPage {
  const { items, partial } = unwrapSdkItems(value, ["messages"])
  let messages: UIMessage[] = []
  for (const item of items) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { type?: unknown }).type !== "string"
    ) {
      continue
    }
    const event = item as SDKMessage
    const userMessage = historicalUserMessage(event)
    if (userMessage && !messages.some((message) => message.id === userMessage.id)) {
      messages = [...messages, userMessage]
    }
    messages = applySdkEvent(messages, event).messages
  }
  return { messages, partial }
}

function readSdkSubagents(value: unknown): { agentIds: string[]; partial: boolean } {
  const { items, partial } = unwrapSdkItems(value, ["subagents", "agentIds"])
  return {
    agentIds: items.filter((item): item is string => typeof item === "string" && item.length > 0),
    partial,
  }
}

type SdkSessionErrorKey = "errors.loadFailed"

/** Stable identity of a listed row: the same id can live in several stores. */
function sdkRowKey(session: SdkSessionInfo): string {
  return JSON.stringify([
    session.storage,
    session.storageWorkspace ?? session.cwd,
    session.sessionId,
  ])
}

/** Newest first; the SDK's `lastModified` is epoch milliseconds. */
export function sortSdkSessions<T extends Pick<SdkSessionInfo, "lastModified" | "sessionId">>(
  sessions: readonly T[]
): T[] {
  return [...sessions].sort(
    (a, b) =>
      (Number.isFinite(b.lastModified) ? b.lastModified : 0) -
        (Number.isFinite(a.lastModified) ? a.lastModified : 0) ||
      a.sessionId.localeCompare(b.sessionId)
  )
}

function locatorOf(session: SdkSessionInfo): SdkSessionLocator {
  return {
    sessionId: session.sessionId,
    storage: session.storage,
    storageWorkspace: session.storageWorkspace,
  }
}

/** Open a Cognia chat through the session link (switches workspace, then focuses). */
function conversationHref(sessionId: string): string {
  return `/${buildSessionHref(sessionId)}`
}

const EMPTY_CHATS: ChatSession[] = []

export function SdkSessionManager() {
  const t = useTranslations("settings.agentRuntimeSection.sessions.sdk")
  const tRow = useTranslations("desktop.sessionRow")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const router = useRouter()
  const enabled = useAgentExecutionFlag("claudeSdkParityV1")
  const sessionStoreEnabled = useAgentExecutionFlag("claudeSdkSessionStore")
  // The host profile, not the webview kind: `agent_session_api` is answered by
  // the host's sidecar, which a paired phone or browser reaches over the
  // companion transport and the headless brain owns outright.
  const environment = resolveAgentExecutionEnvironment()
  const hostReachable = agentHostAvailable(environment)
  // `null` until the first list lands, so the first paint is a loading state
  // rather than an empty list.
  const [sessions, setSessions] = useState<SdkSessionInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<SdkSessionErrorKey | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<SdkSessionInfo | null>(null)
  const [renameDraft, setRenameDraft] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<SdkSessionInfo | null>(null)
  const [tagTarget, setTagTarget] = useState<SdkSessionInfo | null>(null)
  const [tagDraft, setTagDraft] = useState("")
  const [detailsTarget, setDetailsTarget] = useState<SdkSessionInfo | null>(null)
  const [detailsInfo, setDetailsInfo] = useState<SdkSessionInfo | null>(null)
  const [detailMessages, setDetailMessages] = useState<UIMessage[]>([])
  const [detailSubagents, setDetailSubagents] = useState<string[]>([])
  const [detailTranscriptId, setDetailTranscriptId] = useState<string | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsPartial, setDetailsPartial] = useState(false)
  const [detailsError, setDetailsError] = useState(false)
  const detailsRequestRef = useRef(0)

  // Cognia chats, live, to mark the native sessions a chat resumes.
  // Skipped where the block renders nothing (no host, or parity off).
  const chats = useClientLiveQuery(
    () => (hostReachable && enabled ? listChatSessions() : EMPTY_CHATS),
    [hostReachable, enabled],
    EMPTY_CHATS
  )
  const sortedSessions = useMemo(() => (sessions ? sortSdkSessions(sessions) : null), [sessions])
  const untitled = tRow("untitled")
  const placeholder = tRow("placeholderTitle")
  const chatTitle = (chat: Pick<ChatSession, "title">) =>
    sessionDisplayTitle(chat.title, { untitled, placeholder })
  /** Chats bound to `session` that a conversation list shows — the ones to open. */
  const openableLinks = (session: SdkSessionInfo): ChatSession[] =>
    linkedChatsFor(chats ?? EMPTY_CHATS, locatorOf(session)).filter((chat) =>
      isSessionExposed(chat, "main-list")
    )
  const deleteLinkCount = deleteTarget
    ? linkedChatsFor(chats ?? EMPTY_CHATS, locatorOf(deleteTarget)).length
    : 0

  const load = useCallback(async () => {
    if (!hostReachable || !enabled) return
    setLoading(true)
    setError(null)
    try {
      const filesystem = await listSdkSessions<SdkSessionInfo[]>()
      const merged = new Map(
        filesystem.map((row) => [
          JSON.stringify([row.cwd ?? null, row.sessionId]),
          { ...row, storage: "filesystem" as const } as SdkSessionInfo,
        ])
      )
      const chats = await listChatSessions()
      const recordedStoreScopes = chats
        .filter((chat) => chat.sdkSessionId && chat.sdkSessionStorage?.backend === "host-sqlite")
        .map((chat) => chat.sdkSessionStorage?.workspace ?? undefined)
      if (sessionStoreEnabled || recordedStoreScopes.length > 0) {
        const projects = useProjectStore.getState()
        const defaultWorkingDir = useSettingsStore.getState().settings?.defaultWorkingDir
        const scopes = new Set<string | undefined>(recordedStoreScopes)
        if (sessionStoreEnabled) {
          scopes.add(undefined)
          scopes.add(defaultWorkingDir || undefined)
        }
        for (const row of sessionStoreEnabled ? filesystem : []) if (row.cwd) scopes.add(row.cwd)
        for (const project of sessionStoreEnabled ? projects.projects : [])
          scopes.add(resolveEffectiveCwd({ activeProject: project }))
        for (const chat of chats) {
          if (!chat.sdkSessionId) continue
          if (!sessionStoreEnabled || chat.sdkSessionStorage?.backend === "host-sqlite") continue
          const character = chat.characterId ? await resolveCharacterById(chat.characterId) : null
          scopes.add(
            resolveEffectiveCwd({
              sessionWorkingDir: chat.workingDir,
              executionWorkspaceRoot: chat.executionContext
                ? resolveSessionWorkspaceRoot(chat.executionContext)
                : undefined,
              activeProject: resolveSessionWorkspace(
                chat,
                projects.projects,
                projects.activeProjectId
              ),
              characterWorkingDir: character?.workingDir,
              defaultWorkingDir,
            })
          )
        }
        for (const cwd of scopes) {
          const rows = await listSdkSessions<SdkSessionInfo[]>(
            undefined,
            await sdkSessionApiOptions({ cwd, storage: "host-sqlite" })
          )
          for (const row of rows)
            merged.set(JSON.stringify([cwd ?? null, row.sessionId]), {
              ...row,
              storageWorkspace: cwd,
              storage: "host-sqlite",
            })
        }
      }
      setSessions([...merged.values()])
    } catch {
      setError("errors.loadFailed")
    } finally {
      setLoading(false)
    }
  }, [hostReachable, enabled, sessionStoreEnabled])

  useEffect(() => {
    if (!hostReachable || !enabled) return
    const timer = globalThis.setTimeout(() => void load(), 0)
    return () => globalThis.clearTimeout(timer)
  }, [hostReachable, enabled, load])

  if (!hostReachable) return null

  const optionsFor = (session: SdkSessionInfo) =>
    sdkSessionApiOptions({
      cwd: session.storage === "host-sqlite" ? session.storageWorkspace : session.cwd,
      sessionId: session.sessionId,
      storage: session.storage ?? "filesystem",
    })

  const onRename = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!renameTarget || !renameDraft.trim() || busyId === renameTarget.sessionId) return
    setBusyId(renameTarget.sessionId)
    try {
      await renameSdkSession(
        renameTarget.sessionId,
        renameDraft.trim(),
        await optionsFor(renameTarget)
      )
      toast.success(t("renamed"))
      setRenameTarget(null)
      await load()
    } catch {
      toast.error(t("errors.renameFailed"))
    } finally {
      setBusyId(null)
    }
  }

  const onFork = async (session: SdkSessionInfo) => {
    setBusyId(session.sessionId)
    try {
      await forkSdkSession(session.sessionId, await optionsFor(session))
      toast.success(t("forked"))
      await load()
    } catch {
      toast.error(t("errors.forkFailed"))
    } finally {
      setBusyId(null)
    }
  }

  const onDelete = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setBusyId(target.sessionId)
    try {
      await deleteSdkSession(target.sessionId, await optionsFor(target))
    } catch {
      toast.error(t("errors.deleteFailed"))
      setBusyId(null)
      return
    }
    // A chat still pointing at the deleted transcript would try to resume it
    // on its next turn. Clearing the link keeps the chat's messages and lets
    // that turn start a fresh SDK conversation. Read fresh rows, not the live
    // snapshot, so a chat bound since the last render is not missed.
    let unlinkFailed = false
    try {
      const linked = linkedChatsFor(await listChatSessions(), locatorOf(target))
      const results = await Promise.allSettled(linked.map((chat) => clearSessionSdkLink(chat.id)))
      results.forEach((result, index) => {
        if (result.status === "fulfilled") return
        unlinkFailed = true
        loggers.chat.warn("sdk-session-delete-unlink-failed", {
          sdkSessionId: target.sessionId,
          sessionId: linked[index]?.id,
          err: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      })
    } catch (err) {
      unlinkFailed = true
      loggers.chat.warn("sdk-session-delete-unlink-failed", {
        sdkSessionId: target.sessionId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
    if (unlinkFailed) toast.error(t("errors.unlinkAfterDeleteFailed"))
    else toast.success(t("deleted"))
    setDeleteTarget(null)
    try {
      await load()
    } finally {
      setBusyId(null)
    }
  }

  const onTag = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!tagTarget || busyId === tagTarget.sessionId) return
    setBusyId(tagTarget.sessionId)
    try {
      await tagSdkSession(tagTarget.sessionId, tagDraft.trim() || null, await optionsFor(tagTarget))
      toast.success(t("tagged"))
      setTagTarget(null)
      await load()
    } catch {
      toast.error(t("errors.tagFailed"))
    } finally {
      setBusyId(null)
    }
  }

  const onOpenDetails = async (session: SdkSessionInfo) => {
    const request = ++detailsRequestRef.current
    setDetailsTarget(session)
    setDetailsInfo(session)
    setDetailMessages([])
    setDetailSubagents([])
    setDetailTranscriptId(null)
    setDetailsLoading(true)
    setDetailsPartial(false)
    setDetailsError(false)

    const [infoResult, messagesResult, subagentsResult] = await Promise.allSettled([
      getSdkSessionInfo<SdkSessionInfo | undefined>(session.sessionId, await optionsFor(session)),
      getSdkSessionMessages(session.sessionId, await optionsFor(session)),
      listSdkSubagents(session.sessionId, await optionsFor(session)),
    ])
    if (request !== detailsRequestRef.current) return

    if (infoResult.status === "fulfilled" && infoResult.value) setDetailsInfo(infoResult.value)
    if (messagesResult.status === "fulfilled") {
      const transcript = foldSdkSessionMessages(messagesResult.value)
      setDetailMessages(transcript.messages)
      setDetailsPartial((current) => current || transcript.partial)
    }
    if (subagentsResult.status === "fulfilled") {
      const subagents = readSdkSubagents(subagentsResult.value)
      setDetailSubagents(subagents.agentIds)
      setDetailsPartial((current) => current || subagents.partial)
    }
    setDetailsError(
      infoResult.status === "rejected" ||
        messagesResult.status === "rejected" ||
        subagentsResult.status === "rejected"
    )
    setDetailsLoading(false)
  }

  const onOpenSubagent = async (agentId: string) => {
    if (!detailsTarget) return
    const request = ++detailsRequestRef.current
    setDetailTranscriptId(agentId)
    setDetailsLoading(true)
    setDetailsError(false)
    try {
      const transcript = foldSdkSessionMessages(
        await getSdkSubagentMessages(
          detailsTarget.sessionId,
          agentId,
          await optionsFor(detailsTarget)
        )
      )
      if (request !== detailsRequestRef.current) return
      setDetailMessages(transcript.messages)
      setDetailsPartial(transcript.partial)
    } catch {
      if (request !== detailsRequestRef.current) return
      setDetailMessages([])
      setDetailsError(true)
    } finally {
      if (request === detailsRequestRef.current) setDetailsLoading(false)
    }
  }

  const onContinueInChat = async (session: SdkSessionInfo) => {
    setBusyId(session.sessionId)
    try {
      if (sessionStoreEnabled && session.storage === "filesystem") {
        await importSdkSessionToStore(
          session.sessionId,
          await sdkSessionApiOptions({
            cwd: session.cwd,
            sessionId: session.sessionId,
            storage: "host-sqlite",
          })
        )
      }
      const storage: SdkSessionStorage =
        sessionStoreEnabled || session.storage === "host-sqlite"
          ? {
              backend: "host-sqlite",
              workspace:
                (session.storage === "host-sqlite" ? session.storageWorkspace : session.cwd) ??
                null,
            }
          : { backend: "filesystem" }
      const existing = (await listChatSessions()).find(
        (candidate) =>
          candidate.sdkSessionId === session.sessionId &&
          (!candidate.sdkSessionStorage ||
            (candidate.sdkSessionStorage.backend === storage.backend &&
              (candidate.sdkSessionStorage.workspace ?? null) === (storage.workspace ?? null)))
      )
      let chatSessionId = existing?.id

      if (!chatSessionId) {
        const transcript = foldSdkSessionMessages(
          await getSdkSessionMessages(session.sessionId, await optionsFor(session))
        )
        const created = await startNewSession({
          title: session.customTitle || session.summary,
          workingDir: session.cwd,
          sdkSessionId: session.sessionId,
          sdkSessionStorage: storage,
        })
        chatSessionId = created.id
        await persistMessages(chatSessionId, transcript.messages)
        useChatStore.getState().replaceSessionMessages(chatSessionId, transcript.messages)
      }

      await updateSession(chatSessionId, { sdkSessionStorage: storage })
      // Through the session link, not the store: the link consumer on `/`
      // switches to the chat's workspace before focusing it, and a store-only
      // switch left the user on Settings with the chat never shown.
      router.push(conversationHref(chatSessionId))
      toast.success(t("continued"))
    } catch {
      toast.error(t("errors.continueFailed"))
    } finally {
      setBusyId(null)
    }
  }

  const onImportStore = async (session: SdkSessionInfo) => {
    if (!session.cwd) return
    setBusyId(session.sessionId)
    try {
      await importSdkSessionToStore(
        session.sessionId,
        await sdkSessionApiOptions({
          cwd: session.cwd,
          sessionId: session.sessionId,
          storage: "host-sqlite",
        })
      )
      await load()
      toast.success(t("imported"))
    } catch {
      toast.error(t("errors.importFailed"))
    } finally {
      setBusyId(null)
    }
  }

  const showLoading = enabled && sessions === null && error === null

  return (
    <>
      <SettingsBlock
        title={t("title")}
        description={t("description")}
        testid="sdk-session-manager"
        contentClassName="space-y-3"
        badge={
          enabled && sortedSessions ? (
            <Badge variant="secondary">{t("count", { count: sortedSessions.length })}</Badge>
          ) : undefined
        }
        action={
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => void load()}
            disabled={!enabled || loading}
            aria-label={t("refresh")}
          >
            {loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
          </Button>
        }
      >
        {!enabled ? (
          <p className="text-xs text-muted-foreground">{t("disabled")}</p>
        ) : error ? (
          <p className="text-sm text-destructive">{t(error)}</p>
        ) : (
          <LoadingRegion
            loading={showLoading}
            label={t("loading")}
            showDetail={false}
            fallback={
              <div className="divide-y rounded-md border">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="flex items-center gap-3 p-3">
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-2/5" />
                      <Skeleton className="h-3 w-3/5" />
                    </div>
                    <Skeleton className="h-7 w-40" />
                  </div>
                ))}
              </div>
            }
          >
            {sortedSessions === null ? null : sortedSessions.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("empty")}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {sortedSessions.map((session) => {
                  const links = openableLinks(session)
                  const firstLink = links[0]
                  return (
                    <li
                      key={sdkRowKey(session)}
                      className="flex flex-wrap items-center justify-between gap-3 p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium">
                            {session.customTitle || session.summary}
                          </p>
                          {session.tag && <Badge variant="outline">{session.tag}</Badge>}
                          {firstLink ? (
                            <Badge asChild variant="secondary" className="gap-1">
                              <button
                                type="button"
                                aria-label={t("linkedOpen", { title: chatTitle(firstLink) })}
                                onClick={() => router.push(conversationHref(firstLink.id))}
                                className="cursor-pointer hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <LinkIcon className="size-3" aria-hidden />
                                {t("linked", { count: links.length })}
                              </button>
                            </Badge>
                          ) : null}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {session.cwd || session.sessionId}
                        </p>
                        {Number.isFinite(session.lastModified) && session.lastModified > 0 ? (
                          <p className="text-xs text-muted-foreground">
                            {t("lastModified", {
                              time: format.relativeTime(new Date(session.lastModified), now),
                            })}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={busyId === session.sessionId}
                          aria-label={t("details")}
                          onClick={() => void onOpenDetails(session)}
                        >
                          <EyeIcon className="size-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={busyId === session.sessionId}
                          aria-label={t("continueInChat")}
                          onClick={() => void onContinueInChat(session)}
                        >
                          <MessageSquareIcon className="size-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={busyId === session.sessionId}
                          aria-label={t("rename")}
                          onClick={() => {
                            setRenameTarget(session)
                            setRenameDraft(session.customTitle || session.summary)
                          }}
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={busyId === session.sessionId}
                          aria-label={t("editTag")}
                          onClick={() => {
                            setTagTarget(session)
                            setTagDraft(session.tag ?? "")
                          }}
                        >
                          <TagsIcon className="size-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={busyId === session.sessionId}
                          aria-label={t("fork")}
                          onClick={() => void onFork(session)}
                        >
                          <GitBranchIcon className="size-3.5" />
                        </Button>
                        {sessionStoreEnabled &&
                          session.storage !== "host-sqlite" &&
                          session.cwd && (
                            <Button
                              size="icon"
                              variant="ghost"
                              disabled={busyId === session.sessionId}
                              aria-label={t("importStore")}
                              onClick={() => void onImportStore(session)}
                            >
                              <DatabaseIcon className="size-3.5" />
                            </Button>
                          )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-destructive"
                          disabled={busyId === session.sessionId}
                          aria-label={t("delete")}
                          onClick={() => setDeleteTarget(session)}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </LoadingRegion>
        )}
      </SettingsBlock>

      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <form className="contents" onSubmit={(event) => void onRename(event)}>
            <DialogHeader>
              <DialogTitle>{t("renameTitle")}</DialogTitle>
              <DialogDescription>{t("renameDescription")}</DialogDescription>
            </DialogHeader>
            <Input
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              aria-label={t("titleLabel")}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                disabled={!renameDraft.trim() || busyId === renameTarget?.sessionId}
              >
                {t("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={tagTarget !== null} onOpenChange={(open) => !open && setTagTarget(null)}>
        <DialogContent>
          <form className="contents" onSubmit={(event) => void onTag(event)}>
            <DialogHeader>
              <DialogTitle>{t("tagTitle")}</DialogTitle>
              <DialogDescription>{t("tagDescription")}</DialogDescription>
            </DialogHeader>
            <Input
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              aria-label={t("tagLabel")}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setTagTarget(null)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={busyId === tagTarget?.sessionId}>
                {t("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={detailsTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            detailsRequestRef.current += 1
            setDetailsTarget(null)
          }
        }}
      >
        {/* `sm:` — the base DialogContent caps width at `sm:max-w-lg`, which
            outranks an unprefixed `max-w-4xl` from 640px up. */}
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{detailsInfo?.customTitle || detailsInfo?.summary}</DialogTitle>
            <DialogDescription>{t("detailsDescription")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap gap-2 text-xs">
            {detailsInfo?.tag && <Badge variant="outline">{detailsInfo.tag}</Badge>}
            {detailsInfo?.gitBranch && <Badge variant="secondary">{detailsInfo.gitBranch}</Badge>}
            {detailsInfo?.cwd && (
              <span className="truncate text-muted-foreground">{detailsInfo.cwd}</span>
            )}
          </div>

          {(detailsError || detailsPartial) && (
            <p className="text-xs text-muted-foreground" role="status">
              {detailsError ? t("detailsPartialError") : t("detailsPartial")}
            </p>
          )}

          {detailSubagents.length > 0 && (
            <div className="flex flex-wrap gap-1" aria-label={t("subagentTranscripts")}>
              <Button
                size="sm"
                variant={detailTranscriptId === null ? "secondary" : "ghost"}
                onClick={() => detailsTarget && void onOpenDetails(detailsTarget)}
              >
                {t("mainTranscript")}
              </Button>
              {detailSubagents.map((agentId) => (
                <Button
                  key={agentId}
                  size="sm"
                  variant={detailTranscriptId === agentId ? "secondary" : "ghost"}
                  onClick={() => void onOpenSubagent(agentId)}
                >
                  {t("subagentTranscript", { agentId })}
                </Button>
              ))}
            </div>
          )}

          <div className="flex min-h-72 flex-1 overflow-hidden rounded-md border">
            {detailsLoading ? (
              <div className="flex flex-1 items-center justify-center" role="status">
                <Spinner className="size-5" label={t("loadingDetails")} />
              </div>
            ) : detailMessages.length > 0 && detailsTarget ? (
              <TranscriptMessageList
                messages={detailMessages}
                status="idle"
                sessionId={
                  detailTranscriptId
                    ? `${detailsTarget.sessionId}:${detailTranscriptId}`
                    : detailsTarget.sessionId
                }
              />
            ) : (
              <p className="m-auto text-sm text-muted-foreground">{t("emptyTranscript")}</p>
            )}
          </div>

          <DialogFooter>
            {detailsTarget && (
              <Button onClick={() => void onContinueInChat(detailsTarget)}>
                {t("continueInChat")}
              </Button>
            )}
            <Button variant="outline" onClick={() => setDetailsTarget(null)}>
              {t("close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription")}
              {deleteLinkCount > 0 ? ` ${t("deleteLinkedNote", { count: deleteLinkCount })}` : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => void onDelete()}
            >
              {t("deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
