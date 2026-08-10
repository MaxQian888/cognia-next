"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import {
  DatabaseIcon,
  EyeIcon,
  GitBranchIcon,
  Loader2Icon,
  MessageSquareIcon,
  PencilIcon,
  RefreshCwIcon,
  TagsIcon,
  Trash2Icon,
} from "lucide-react"
import type { SDKMessage } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { SettingsBlock } from "@/components/settings/common/settings-block"
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
import { listSessions as listChatSessions } from "@/lib/db/sessions"
import { persistMessages } from "@/lib/db/messages"
import { startNewSession } from "@/lib/chat/start-session"
import { useChatStore } from "@/stores/chat"
import {
  getAgentExecutionFlags,
  isAgentExecutionFlagEnabled,
  subscribeToAgentExecutionFlags,
} from "@/lib/ai/agent/execution/feature-flags"
import {
  resolveAgentExecutionSpec,
  sendSpecFromResolved,
} from "@/lib/ai/agent/execution/resolve-agent-execution-spec"
import { isTauri } from "@/lib/tauri"

interface SdkSessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  customTitle?: string
  cwd?: string
  tag?: string
  gitBranch?: string
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

export function SdkSessionManager() {
  const t = useTranslations("settings.agentRuntimeSection.sessions.sdk")
  const router = useRouter()
  const enabled = useSyncExternalStore(
    subscribeToAgentExecutionFlags,
    () => isAgentExecutionFlagEnabled("claudeSdkParityV1"),
    () => false
  )
  const sessionStoreEnabled = useSyncExternalStore(
    subscribeToAgentExecutionFlags,
    () => isAgentExecutionFlagEnabled("claudeSdkSessionStore"),
    () => false
  )
  const desktop = isTauri()
  const [sessions, setSessions] = useState<SdkSessionInfo[]>([])
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

  const load = useCallback(async () => {
    if (!desktop || !enabled) return
    setLoading(true)
    setError(null)
    try {
      setSessions(await listSdkSessions<SdkSessionInfo[]>())
    } catch {
      setError("errors.loadFailed")
    } finally {
      setLoading(false)
    }
  }, [desktop, enabled])

  useEffect(() => {
    if (!desktop || !enabled) return
    const timer = globalThis.setTimeout(() => void load(), 0)
    return () => globalThis.clearTimeout(timer)
  }, [desktop, enabled, load])

  if (!desktop) return null

  const onRename = async () => {
    if (!renameTarget || !renameDraft.trim()) return
    setBusyId(renameTarget.sessionId)
    try {
      await renameSdkSession(renameTarget.sessionId, renameDraft.trim())
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
      await forkSdkSession(session.sessionId)
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
    setBusyId(deleteTarget.sessionId)
    try {
      await deleteSdkSession(deleteTarget.sessionId)
      toast.success(t("deleted"))
      setDeleteTarget(null)
      await load()
    } catch {
      toast.error(t("errors.deleteFailed"))
    } finally {
      setBusyId(null)
    }
  }

  const onTag = async () => {
    if (!tagTarget) return
    setBusyId(tagTarget.sessionId)
    try {
      await tagSdkSession(tagTarget.sessionId, tagDraft.trim() || null)
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
      getSdkSessionInfo<SdkSessionInfo | undefined>(session.sessionId),
      getSdkSessionMessages(session.sessionId),
      listSdkSubagents(session.sessionId),
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
        await getSdkSubagentMessages(detailsTarget.sessionId, agentId)
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
      const existing = (await listChatSessions()).find(
        (candidate) => candidate.sdkSessionId === session.sessionId
      )
      let chatSessionId = existing?.id

      if (!chatSessionId) {
        const transcript = foldSdkSessionMessages(await getSdkSessionMessages(session.sessionId))
        const created = await startNewSession({
          title: session.customTitle || session.summary,
          workingDir: session.cwd,
          sdkSessionId: session.sessionId,
        })
        chatSessionId = created.id
        await persistMessages(chatSessionId, transcript.messages)
        useChatStore.getState().replaceSessionMessages(chatSessionId, transcript.messages)
      }

      useChatStore.getState().setActiveSession(chatSessionId)
      router.push("/")
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
      const { spec } = resolveAgentExecutionSpec({
        surface: "chat",
        environment: { isTauri: desktop, isHeadlessHost: false },
        flags: getAgentExecutionFlags(),
        policy: { executionKind: "agent", runtimePolicy: "claude-agent-sdk" },
        legacy: { providerId: "anthropic" },
        identity: { sessionId: session.sessionId },
      })
      await importSdkSessionToStore(session.sessionId, {
        cwd: session.cwd,
        execution: sendSpecFromResolved(spec),
        claudeAgentSdk: {
          version: 1,
          persistSession: true,
          sessionStore: { backend: "host-sqlite" },
        },
      })
      toast.success(t("imported"))
    } catch {
      toast.error(t("errors.importFailed"))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <SettingsBlock
        title={t("title")}
        description={t("description")}
        testid="sdk-session-manager"
        contentClassName="space-y-3"
      >
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary">{t("count", { count: sessions.length })}</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={!enabled || loading}
            aria-label={t("refresh")}
          >
            {loading ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
          </Button>
        </div>
        {!enabled ? (
          <p className="text-xs text-muted-foreground">{t("disabled")}</p>
        ) : error ? (
          <p className="text-sm text-destructive">{t(error)}</p>
        ) : sessions.length === 0 && !loading ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {sessions.map((session) => (
              <li key={session.sessionId} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-medium">
                      {session.customTitle || session.summary}
                    </p>
                    {session.tag && <Badge variant="outline">{session.tag}</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {session.cwd || session.sessionId}
                  </p>
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
                  {sessionStoreEnabled && session.cwd && (
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
            ))}
          </ul>
        )}
      </SettingsBlock>

      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
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
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              {t("cancel")}
            </Button>
            <Button disabled={!renameDraft.trim()} onClick={() => void onRename()}>
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tagTarget !== null} onOpenChange={(open) => !open && setTagTarget(null)}>
        <DialogContent>
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
            <Button variant="outline" onClick={() => setTagTarget(null)}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void onTag()}>{t("save")}</Button>
          </DialogFooter>
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
        <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col">
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
                  {agentId}
                </Button>
              ))}
            </div>
          )}

          <div className="flex min-h-72 flex-1 overflow-hidden rounded-md border">
            {detailsLoading ? (
              <div className="flex flex-1 items-center justify-center" role="status">
                <Loader2Icon className="size-5 animate-spin" aria-label={t("loadingDetails")} />
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
            <AlertDialogDescription>{t("deleteDescription")}</AlertDialogDescription>
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
