"use client"

import type { ChatTemplateRun } from "@/lib/chat/template/run"
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import type { SendContent } from "@cognia/agent-config-types"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { useChatScope } from "@/components/chat/chat-scope-provider"
import { useClaudeChat } from "@/hooks/chat/use-claude-chat"
import { getDb } from "@/lib/db/schema"
import { listMessages } from "@/lib/db/messages"
import { consumeStagedPrompt } from "@/lib/chat/attached-session"
import { useSideChatRequestStore } from "@/stores/chat/side-chat-request-store"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { useChatStore } from "@/stores/chat"
import { useChatFusionMode } from "@/stores/chat/fusion-mode-store"
import { useAgentRuntimeStore, useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useExternalAgentStore } from "@/stores/agent"
import { useSettingsStore } from "@/stores/settings"
import { resolveSessionAsideRuntimeWithAgent } from "@/lib/context-workbench/session-aside-runtime"
import { useContextWorkbench } from "./context-workbench"
import { AsideTargetProvider } from "./aside-target"
import { AsideSwitcher } from "./aside-switcher"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { getContextResourceKey } from "@/types/context-workbench"
import {
  resourceWorkbenchSessionId,
  isPrimaryResourceWorkbenchSessionId,
  surfaceBindingForContextResource,
} from "@/lib/context-workbench/resource-session"
import { useSingleExport } from "@/hooks/data/use-single-export"
import { Button } from "@/components/ui/button"
import { updateSession } from "@/lib/db/sessions"
import { toast } from "sonner"
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
import { DownloadIcon } from "lucide-react"
import type { ComposerTurnMetadata } from "@/components/chat/composer"
import { turnMetadataSendOptions } from "@/lib/chat/turn-metadata"

const ChatPane = lazy(() =>
  import("@/components/chat/chat-view").then((module) => ({
    default: module.ChatPane,
  }))
)

function withSelectionCoordinates(resourceContext: string, selection: unknown): string {
  return selection
    ? `[Current selection coordinates]\n${JSON.stringify(selection)}\n\n${resourceContext}`
    : resourceContext
}

export function ResourceWorkbenchChatPanel({
  getResourceContext,
  pendingPrompt,
  onPendingPromptConsumed,
  selectionHeader,
  asideTargetSessionId,
  multiAside = false,
}: {
  getResourceContext?: () => string | Promise<string>
  pendingPrompt?: string | null
  onPendingPromptConsumed?: () => void
  /**
   * Set only by the session-bound sidechat: the MAIN conversation this panel is
   * an aside to. Enables the per-message "hand back to the main thread" action.
   */
  asideTargetSessionId?: string
  /**
   * Host content above the conversation — the artifact surface puts its
   * "comment on the current selection" composer here. It used to be a separate
   * panel in the same activity group, which the rail could never reach.
   */
  selectionHeader?: ReactNode
  /**
   * Render the aside picker + lifecycle menu.
   *
   * Only the session-bound sidechat opts in. An artifact / canvas / project-file
   * chat is a property OF that resource — several parallel ones would have no
   * meaning, and no surface to choose between them.
   *
   * **Desktop only, deliberately.** `components/mobile/` mounts no workbench at
   * all (the sole mobile context-workbench is the workflow editor's sheet), so
   * there is no mobile surface for this panel — let alone for a picker above it.
   * This is a scoping decision, not an oversight: the mobile shell would need
   * its own sheet-based host first. Pinned by
   * `resource-workbench-chat-panel.test.tsx` ("no mobile surface hosts the
   * aside switcher").
   */
  multiAside?: boolean
}) {
  const t = useTranslations("contextWorkbench")
  const { sessionId } = useChatScope()
  const { resource } = useContextWorkbench()
  const claude = useClaudeChat()
  const exportSession = useSingleExport()
  const session = useLiveQuery(() => getDb().sessions.get(sessionId), [sessionId]) ?? null
  const parentSessionId = resource.kind === "session" ? resource.sessionId : undefined
  const parentSession = useLiveQuery(
    () => (parentSessionId ? getDb().sessions.get(parentSessionId) : undefined),
    [parentSessionId]
  )
  const parentRuntimeRef = useRuntimeRefForSession(parentSessionId)
  const parentFusionMode = useChatFusionMode(parentSessionId)
  const parentComposition = useAgentRuntimeStore((state) =>
    parentSessionId
      ? (state.sessionCompositions[parentSessionId] ?? state.defaultComposition)
      : state.defaultComposition
  )
  const asideComposition = useAgentRuntimeStore(
    (state) => state.sessionCompositions[sessionId] ?? state.defaultComposition
  )
  const parentAgentId = parentRuntimeRef.kind === "external" ? parentRuntimeRef.agentId : undefined
  const parentAgent = useExternalAgentStore((state) =>
    parentAgentId ? state.agents[parentAgentId] : undefined
  )
  // Negotiated capabilities can change when an agent reconnects. Observe that
  // metadata only; the main conversation's streaming messages stay unsubscribed.
  const parentConnection = useExternalAgentStore((state) =>
    parentAgentId ? state.connectionStatus[parentAgentId] : undefined
  )
  const appSettings = useSettingsStore((state) => state.settings)
  const [runtimeNote, setRuntimeNote] = useState<{
    sessionId: string
    parentSessionId: string
    readOnly: boolean
  } | null>(null)

  useEffect(() => {
    if (!session || !parentSession || !parentSessionId || parentRuntimeRef.kind === "builtin")
      return
    let cancelled = false
    void (async () => {
      const { resolveSessionAsideParentPermission, resolveSessionAsideReadOnly } =
        await import("@/lib/claude/build-options")
      const parentPermission = await resolveSessionAsideParentPermission(parentSession, appSettings)
      const readOnly = await resolveSessionAsideReadOnly(session, parentPermission, appSettings, {
        compositionSelection: asideComposition,
      })
      const route = await resolveSessionAsideRuntimeWithAgent({
        session: readOnly ? { ...session, asideWriteAccess: false } : session,
        parentRuntimeRef,
        parentPermission,
        forceBuiltin: Boolean(
          parentSession.teamId ||
          parentSession.squadId ||
          (parentComposition.orchestration && parentComposition.orchestration !== "direct") ||
          ["cascade", "panel"].includes(parentFusionMode)
        ),
      })
      if (!cancelled) {
        setRuntimeNote(
          route.usesBuiltinFallback && route.runtimeRef.kind === "builtin"
            ? {
                sessionId,
                parentSessionId,
                readOnly: route.permissionCeiling.permissionMode === "plan",
              }
            : null
        )
      }
    })().catch((error) => {
      if (!cancelled) {
        setRuntimeNote(null)
        console.error("Failed to resolve side-chat runtime", error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    session,
    sessionId,
    parentSession,
    parentSessionId,
    parentRuntimeRef,
    parentComposition,
    asideComposition,
    parentFusionMode,
    parentAgent,
    parentConnection,
    appSettings,
  ])

  const showRuntimeNote =
    runtimeNote?.sessionId === sessionId &&
    runtimeNote.parentSessionId === parentSessionId &&
    parentRuntimeRef.kind !== "builtin"
  const parentAgentName =
    parentRuntimeRef.kind === "host"
      ? (parentRuntimeRef.name ?? t("asides.externalAgent"))
      : (parentAgent?.name ?? t("asides.externalAgent"))
  const [confirmEditing, setConfirmEditing] = useState<string | null>(null)
  const [savingAccess, setSavingAccess] = useState(false)
  const running = useChatStore((state) => {
    const status = state.sessions[sessionId]?.status
    return status === "streaming" || status === "awaiting_approval"
  })
  const saveWriteAccess = async (enabled: boolean) => {
    setSavingAccess(true)
    try {
      await updateSession(sessionId, { asideWriteAccess: enabled })
      setConfirmEditing(null)
    } catch {
      toast.error(t("asides.actionError"))
    } finally {
      setSavingAccess(false)
    }
  }
  const reloadNonce = useChatStore((state) => state.sessions[sessionId]?.messagesReloadNonce ?? 0)
  const [loadedHistoryKey, setLoadedHistoryKey] = useState<string | null>(null)
  const historyKey = `${sessionId}:${reloadNonce}`

  useEffect(() => {
    let cancelled = false
    listMessages(sessionId)
      .then((messages) => {
        if (!cancelled) {
          useChatStore.getState().setSessionMessages(sessionId, messages)
          setLoadedHistoryKey(historyKey)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          useChatStore
            .getState()
            .setSessionMessagesLoadError(
              sessionId,
              error instanceof Error ? error.message : String(error)
            )
        }
      })
    return () => {
      cancelled = true
    }
  }, [historyKey, reloadNonce, sessionId])

  const resolveResourceContext = useCallback(async () => {
    if (session?.spawnedTask?.pendingPrompt && session.lastMessageAt === undefined) return ""
    return withSelectionCoordinates(
      (await getResourceContext?.()) ?? "",
      "selection" in resource ? resource.selection : undefined
    )
  }, [getResourceContext, resource, session])

  const withArtifactTarget = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T> => {
      let artifactTargetPending = false
      if (resource.kind === "artifact") {
        useChatStore.getState().setPendingArtifactEditTarget(sessionId, {
          artifactId: resource.artifactId,
          requestId: crypto.randomUUID(),
        })
        artifactTargetPending = true
      }
      try {
        return await operation()
      } catch (error) {
        if (artifactTargetPending) {
          useChatStore.getState().setPendingArtifactEditTarget(sessionId, null)
        }
        throw error
      }
    },
    [resource, sessionId]
  )

  const send = useCallback(
    async (
      content: SendContent,
      manifest?: readonly AttachmentManifestEntry[],
      templateRun?: ChatTemplateRun | null,
      turnMetadata?: ComposerTurnMetadata
    ) =>
      withArtifactTarget(async () => {
        const resourceContext = await resolveResourceContext()
        return claude.send(content, undefined, {
          sessionId,
          resourceContext,
          attachmentManifest: manifest,
          ...(templateRun ? { templateRun } : {}),
          ...turnMetadataSendOptions(turnMetadata),
        })
      }),
    [claude, resolveResourceContext, sessionId, withArtifactTarget]
  )

  const sideChatRequests = useSideChatRequestStore((state) => state.pending[sessionId])
  useEffect(() => {
    if (
      !asideTargetSessionId ||
      !session ||
      !sideChatRequests?.length ||
      loadedHistoryKey !== historyKey
    )
      return
    for (const pending of sideChatRequests) {
      const request = useSideChatRequestStore.getState().claim(sessionId, pending.id)
      if (!request) continue
      // This is the same callback as ChatPane.onSend: parent context, permissions,
      // and live steering remain owned by the existing controller.
      void send(request.question).catch(() => {
        useComposerIntentStore.getState().stage(sessionId, {
          candidateId: request.id,
          prompt: request.question,
          mode: "append",
        })
        toast.error(t("asides.sendFailedDraft"))
      })
    }
  }, [
    asideTargetSessionId,
    session,
    sessionId,
    sideChatRequests,
    send,
    t,
    loadedHistoryKey,
    historyKey,
  ])

  const regenerate = useCallback(
    async () =>
      withArtifactTarget(async () => {
        // A regenerated side question reuses its original provider-only context.
        const resourceContext =
          resource.kind === "session" ? undefined : await resolveResourceContext()
        return claude.regenerate(sessionId, resourceContext)
      }),
    [claude, resolveResourceContext, resource.kind, sessionId, withArtifactTarget]
  )

  const editAndResend = useCallback(
    async (messageId: string, content: SendContent) =>
      withArtifactTarget(async () => {
        const resourceContext = await resolveResourceContext()
        return claude.editAndResend(messageId, content, sessionId, resourceContext)
      }),
    [claude, resolveResourceContext, sessionId, withArtifactTarget]
  )
  const submittedPromptRef = useRef<{ sessionId: string; prompt: string } | null>(null)
  const spawnedTaskMode = session?.spawnedTask?.mode
  const stagedTaskPrompt =
    multiAside && session?.lastMessageAt === undefined
      ? (session?.spawnedTask?.pendingPrompt ?? null)
      : null
  const effectivePendingPrompt = pendingPrompt ?? stagedTaskPrompt

  useEffect(() => {
    if (
      !multiAside ||
      !spawnedTaskMode ||
      !session?.spawnedTask?.pendingPrompt ||
      session.lastMessageAt === undefined
    ) {
      return
    }
    void consumeStagedPrompt(sessionId, spawnedTaskMode).catch((error) => {
      console.error("Failed to clear a stale spawned-task prompt", error)
    })
  }, [
    multiAside,
    session?.lastMessageAt,
    session?.spawnedTask?.pendingPrompt,
    sessionId,
    spawnedTaskMode,
  ])

  useEffect(() => {
    if (
      !effectivePendingPrompt ||
      (submittedPromptRef.current?.sessionId === sessionId &&
        submittedPromptRef.current.prompt === effectivePendingPrompt)
    ) {
      return
    }
    submittedPromptRef.current = { sessionId, prompt: effectivePendingPrompt }
    void send(effectivePendingPrompt)
      .then(async () => {
        if (pendingPrompt) onPendingPromptConsumed?.()
        else if (spawnedTaskMode) {
          await consumeStagedPrompt(sessionId, spawnedTaskMode)
        }
      })
      .catch(() => {
        submittedPromptRef.current = null
      })
  }, [
    effectivePendingPrompt,
    onPendingPromptConsumed,
    pendingPrompt,
    send,
    sessionId,
    spawnedTaskMode,
  ])

  // Selecting a different aside routes through the workbench store's existing
  // `sessionOverrides` map — the same seam the project editor's re-linker uses,
  // and the one `useResourceWorkbenchSession` already reads. No parallel
  // selection state to keep in sync.
  const resourceKey = getContextResourceKey(resource)
  const setSessionOverride = useContextWorkbenchStore((state) => state.setSessionOverride)
  const binding = surfaceBindingForContextResource(resource)
  const primaryId = binding ? resourceWorkbenchSessionId(binding) : null

  const body = (
    <div className="flex h-full min-h-0 flex-col" data-sidechat-parent={asideTargetSessionId}>
      {multiAside && binding && primaryId ? (
        <AsideSwitcher
          binding={binding}
          activeId={sessionId}
          primaryId={primaryId}
          onSelect={(next) =>
            // The primary aside is the default, so clearing the override (rather
            // than pinning its id) keeps the resource on the plain derived path.
            setSessionOverride(
              resourceKey,
              isPrimaryResourceWorkbenchSessionId(binding, next) ? null : next
            )
          }
        />
      ) : null}
      <div className="flex h-9 shrink-0 items-center justify-end border-b px-2">
        {resource.kind === "session" && session ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mr-auto"
              aria-pressed={session.asideWriteAccess === true}
              disabled={savingAccess || running}
              onClick={() =>
                session.asideWriteAccess === true
                  ? void saveWriteAccess(false)
                  : setConfirmEditing(sessionId)
              }
            >
              {t(session.asideWriteAccess === true ? "asides.canEdit" : "asides.readOnly")}
            </Button>
            <AlertDialog
              open={confirmEditing === sessionId}
              onOpenChange={(open) => setConfirmEditing(open ? sessionId : null)}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("asides.enableEditingTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("asides.enableEditingBody")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={savingAccess}>
                    {t("asides.cancel")}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    disabled={savingAccess || running}
                    onClick={(event) => {
                      event.preventDefault()
                      void saveWriteAccess(true)
                    }}
                  >
                    {t("asides.enableEditing")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={!session || exportSession.busy}
          aria-label={t("exportResourceSession")}
          onClick={() => session && void exportSession.run({ format: "markdown", session })}
        >
          <DownloadIcon className="size-4" />
        </Button>
      </div>
      {showRuntimeNote ? (
        <p role="status" className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
          {t(runtimeNote.readOnly ? "asides.differentAgentReadOnly" : "asides.differentAgent", {
            agent: parentAgentName,
          })}
        </p>
      ) : null}
      {selectionHeader ? (
        <div className="shrink-0 border-b" data-testid="resource-chat-selection-header">
          {selectionHeader}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
              {t("aiLoading")}
            </div>
          }
        >
          <ChatPane
            activeSession={session}
            sessionId={sessionId}
            onSend={send}
            onStop={() => claude.stop(sessionId)}
            onRegenerate={regenerate}
            onEditResend={editAndResend}
            onCreate={() => undefined}
            onUseSample={(text) => void send(text)}
            onOpenSettings={() => undefined}
            showHeader={false}
          />
        </Suspense>
      </div>
    </div>
  )

  // Only a session-bound aside has a "main thread" to hand things back to; for
  // an artifact / canvas / project-file chat the target is absent and the
  // message action stays hidden.
  return asideTargetSessionId ? (
    <AsideTargetProvider sessionId={asideTargetSessionId}>{body}</AsideTargetProvider>
  ) : (
    body
  )
}
