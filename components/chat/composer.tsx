"use client"

// Composer — Cognia-style chat input.
//
// Layout (horizontal flex inside a rounded box):
//
//   [📎 📷 🎤 ⚙ ⇧⇥]   ┌─Textarea (flex-1)─┐  [▶ Submit]
//                      │            chars  │
//                      └───────────────────┘
//
// State management still flows through `<PromptInputProvider>` so the
// existing slash/@/!/# popover machinery keeps working — the provider's
// `controller.textInput` and `attachments` contexts stay the source of
// truth. We just don't render `<PromptInput>` (which forces a vertical
// `<InputGroup>` layout), and we own the form/textarea ourselves.

import {
  PromptInputProvider,
  usePromptInputAttachments,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input"
import type { ChatStatus as PromptStatus } from "ai"
import { ArrowUpIcon, Loader2Icon, PaperclipIcon, SquareIcon } from "lucide-react"
import {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  forwardRef,
  KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { search, formatSearchResultsForLLM } from "@/lib/search/search-service"
import type { SendContent, SendContentBlock, ChatSession } from "@/lib/claude/types"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { detectTrigger, spliceToken, type ComposerTrigger } from "./composer-trigger"
import { ComposerPopover, type ComposerPopoverHandle, type PopoverItem } from "./composer-popover"
import { ReferenceChips } from "./reference-chips"
import { nextPermissionMode } from "./permission-mode-indicator"
import {
  BUILTIN_SLASH_COMMANDS,
  applyTemplate,
  type SettingsTab,
  type SlashCommand,
  type SlashContext,
} from "@/lib/slash-commands/builtin"
import { loadCustomSlashCommands } from "@/lib/slash-commands/custom"
import { executeShell, formatShellResult } from "@/lib/shell/exec"
import { appendMemory, type MemoryScope } from "@/lib/files/memory"
import { useUpdateSession } from "@/lib/data-hooks/context"
import { loggers } from "@/lib/logger"
import { AttachmentPreview } from "./composer/attachment-preview"
import { BottomToolbar } from "./composer/bottom-toolbar"
import { CharCounter } from "./composer/char-counter"
import { DragOverlay } from "./composer/drag-overlay"
import { HelperHints } from "./composer/helper-hints"
import { ScreenshotButton } from "./composer/screenshot-button"
import { VoiceControls } from "./composer/voice-controls"

interface Props {
  session?: ChatSession | null
  onStartNewSession: () => void | Promise<void>
  onOpenSettings: (tab: SettingsTab) => void
  onSend: (content: SendContent) => void | Promise<void>
  onStop: () => void | Promise<void>
  disabled?: boolean
}

/**
 * Imperative handle exposed by `<Composer>`. The desktop shell uses it to
 * inject `@CharacterName` mentions at the caret when the user clicks a
 * row in the team member list.
 */
export interface ComposerHandle {
  insertMention: (name: string) => void
}

const SUPPORTED_IMAGE_PREFIX = "image/"
const MAX_FILES = 6
const MAX_FILE_SIZE = 10 * 1024 * 1024

// --- Helpers ---------------------------------------------------------------

interface SubmittedFile {
  url?: string
  mediaType?: string
  filename?: string
}

function buildSendContent(
  text: string,
  files: SubmittedFile[]
): { content: SendContent; rejected: number } {
  const trimmed = text.trim()
  const imageBlocks: SendContentBlock[] = []
  let rejected = 0

  for (const f of files) {
    const url = f.url ?? ""
    const media = f.mediaType ?? ""
    if (!media.startsWith(SUPPORTED_IMAGE_PREFIX) || !url.startsWith("data:")) {
      rejected++
      continue
    }
    const commaIdx = url.indexOf(",")
    if (commaIdx < 0) {
      rejected++
      continue
    }
    const data = url.slice(commaIdx + 1)
    imageBlocks.push({
      type: "image",
      source: { type: "base64", media_type: media, data },
    })
  }

  if (imageBlocks.length === 0) {
    return { content: trimmed, rejected }
  }
  const blocks: SendContentBlock[] = [...imageBlocks]
  if (trimmed) blocks.push({ type: "text", text: trimmed })
  return { content: blocks, rejected }
}

const blobUrlToDataUrl = async (url: string): Promise<string | null> => {
  try {
    const res = await fetch(url)
    const blob = await res.blob()
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

// --- Inner box with full state wiring --------------------------------------

interface InnerProps {
  session?: ChatSession | null
  status: PromptStatus
  disabled?: boolean
  onSubmit: (text: string, files: SubmittedFile[]) => void | Promise<void>
  onStop: () => void | Promise<void>
  onCommand: (cmd: SlashCommand, args: string) => Promise<boolean>
  onSubmitMemory: (scope: MemoryScope, text: string) => Promise<boolean>
  handleRef?: Ref<ComposerHandle>
}

function ComposerInner(props: InnerProps) {
  const t = useTranslations("chat.composer")
  const tAttach = useTranslations("chat.composer.attachments")
  const tCommands = useTranslations("chat.composer.commands")
  const tMemory = useTranslations("chat.composer.memory")
  const controller = usePromptInputController()
  const attachments = usePromptInputAttachments()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)
  const popoverRef = useRef<ComposerPopoverHandle | null>(null)

  const [caret, setCaret] = useState(0)
  const [popoverDismissed, setPopoverDismissed] = useState<{
    tokenStart: number
    kind: string
  } | null>(null)
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([])
  const [isComposing, setIsComposing] = useState(false)
  const [dragDepth, setDragDepth] = useState(0)
  const isDragging = dragDepth > 0

  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const permissionMode = useChatStore((s) => s.permissionMode)
  const addReferencedPath = useChatStore((s) => s.addReferencedPath)
  const updateSession = useUpdateSession()
  const cwd = props.session?.workingDir ?? null

  // --- Per-cwd custom slash commands ------------------------------------
  useEffect(() => {
    let cancelled = false
    loadCustomSlashCommands(cwd).then((list) => {
      if (!cancelled) setCustomCommands(list)
    })
    return () => {
      cancelled = true
    }
  }, [cwd])

  // --- Hydrate chat-store from session row on first session change -------
  // `hydratedFor` flips to the session id once the hydration write has
  // *committed*, not just been scheduled. The persist effect below reads
  // this ref to skip the first post-hydration render, where the store value
  // hasn't yet caught up with the session row and would otherwise look
  // divergent and trigger a redundant write.
  const hydratedFor = useRef<string | null>(null)
  const pendingHydrationFor = useRef<string | null>(null)
  useEffect(() => {
    if (!props.session) return
    if (
      hydratedFor.current === props.session.id ||
      pendingHydrationFor.current === props.session.id
    ) {
      return
    }
    pendingHydrationFor.current = props.session.id
    setPermissionMode(props.session.permissionMode ?? null)
  }, [props.session, setPermissionMode])

  // --- Persist active permission mode back to session row ---------------
  useEffect(() => {
    if (!props.session) return
    // Hydration two-phase commit: when permissionMode catches up with the
    // session row's value (the value we hydrated *to*), flip the
    // hydratedFor ref. Until that point the persist branch is a no-op so
    // the very first render after a session swap doesn't write the stale
    // store value back to the row.
    if (
      pendingHydrationFor.current === props.session.id &&
      hydratedFor.current !== props.session.id &&
      permissionMode === (props.session.permissionMode ?? null)
    ) {
      hydratedFor.current = props.session.id
      pendingHydrationFor.current = null
      return
    }
    if (hydratedFor.current !== props.session.id) return
    if (props.session.permissionMode === permissionMode) return
    void updateSession(props.session.id, {
      permissionMode: permissionMode ?? undefined,
    }).catch((err) => {
      loggers.chat.warn("updateSession permissionMode failed", {
        sessionId: props.session?.id,
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }, [permissionMode, props.session, updateSession])

  const slashCommands = useMemo(
    () => [...BUILTIN_SLASH_COMMANDS, ...customCommands].filter((c) => !c.hiddenFromPicker),
    [customCommands]
  )

  const trigger = useMemo<ComposerTrigger | null>(() => {
    const tg = detectTrigger(controller.textInput.value, caret)
    if (!tg) return null
    if (
      popoverDismissed &&
      popoverDismissed.kind === tg.kind &&
      popoverDismissed.tokenStart === tg.tokenStart
    ) {
      return null
    }
    return tg
  }, [controller.textInput.value, caret, popoverDismissed])

  useEffect(() => {
    if (!popoverDismissed) return
    const tg = detectTrigger(controller.textInput.value, caret)
    if (!tg || tg.kind !== popoverDismissed.kind || tg.tokenStart !== popoverDismissed.tokenStart) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPopoverDismissed(null)
    }
  }, [controller.textInput.value, caret, popoverDismissed])

  const dismissPopover = useCallback(() => {
    if (trigger) {
      setPopoverDismissed({
        kind: trigger.kind,
        tokenStart: trigger.tokenStart,
      })
    }
  }, [trigger])

  const insertReplacement = useCallback(
    (replacement: string, opts?: { closeAfter?: boolean }) => {
      if (!trigger) return
      const ta = textareaRef.current
      if (!ta) return
      const cur = controller.textInput.value
      const result = spliceToken(cur, trigger.tokenStart, trigger.tokenEnd, replacement)
      controller.textInput.setInput(result.value)
      requestAnimationFrame(() => {
        const ta2 = textareaRef.current
        if (ta2) {
          ta2.setSelectionRange(result.caret, result.caret)
          ta2.focus()
        }
      })
      if (opts?.closeAfter ?? true) dismissPopover()
    },
    [trigger, controller.textInput, dismissPopover]
  )

  const onPickPopoverItem = useCallback(
    async (item: PopoverItem) => {
      if (!trigger) return
      if (item.kind === "slash") {
        const cmd = item.command
        if (cmd.disabled) {
          toast.info(tCommands("unavailable", { name: cmd.name }))
          return
        }
        const args = trigger.query.replace(new RegExp(`^${cmd.name}\\s*`), "").trim()
        const handled = await props.onCommand(cmd, args)
        if (handled) {
          if (cmd.handler) {
            controller.textInput.clear()
          } else if (cmd.template) {
            const filled = applyTemplate(cmd.template, args)
            controller.textInput.setInput(filled)
            if (cmd.model || cmd.allowedTools || cmd.paths) {
              useChatStore.getState().setPendingCommandOverrides({
                model: cmd.model,
                allowedTools: cmd.allowedTools,
                paths: cmd.paths,
              })
            } else {
              useChatStore.getState().setPendingCommandOverrides(null)
            }
            requestAnimationFrame(() => {
              const ta2 = textareaRef.current
              if (ta2) {
                ta2.setSelectionRange(filled.length, filled.length)
                ta2.focus()
              }
            })
          }
        }
        dismissPopover()
      } else if (item.kind === "file") {
        const e = item.entry
        addReferencedPath({
          absolute: e.absolutePath,
          relative: e.relPath,
          isDir: e.isDir,
        })
        const replacement = `@${e.relPath}${e.isDir ? "/" : ""}`
        insertReplacement(replacement)
      } else if (item.kind === "memory") {
        const text = trigger.query.trim()
        if (!text) {
          toast.error(tMemory("needsLine"))
          return
        }
        const ok = await props.onSubmitMemory(item.scope, text)
        if (ok) controller.textInput.clear()
        dismissPopover()
      }
    },
    [
      trigger,
      controller.textInput,
      addReferencedPath,
      insertReplacement,
      props,
      dismissPopover,
      tCommands,
      tMemory,
    ]
  )

  // --- Submit handler ----------------------------------------------------
  const submit = useCallback(async () => {
    const text = controller.textInput.value
    if (props.disabled) return

    const filesToSend: SubmittedFile[] = await Promise.all(
      attachments.files.map(async ({ id: _id, ...item }) => {
        if (item.url?.startsWith("blob:")) {
          const dataUrl = await blobUrlToDataUrl(item.url)
          return { ...item, url: dataUrl ?? item.url }
        }
        return item
      })
    )

    const empty = text.trim().length === 0 && filesToSend.length === 0
    if (empty) return

    await props.onSubmit(text, filesToSend)
    controller.textInput.clear()
    attachments.clear()
    textareaRef.current?.focus()
  }, [controller.textInput, attachments, props])

  // --- Textarea key handling --------------------------------------------
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // Shift+Tab cycles permission mode regardless of popover state.
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault()
        const next = nextPermissionMode(permissionMode)
        setPermissionMode(next)
        return
      }
      if (trigger) {
        if (e.key === "Escape") {
          e.preventDefault()
          dismissPopover()
          return
        }
        if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey && trigger.kind !== "bash")) {
          e.preventDefault()
          popoverRef.current?.navigate(1)
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          popoverRef.current?.navigate(-1)
          return
        }
        if (e.key === "Enter" && !e.shiftKey) {
          // Bash mode: Enter should fall through to submit (bash run).
          if (trigger.kind === "bash") {
            e.preventDefault()
            void submit()
            return
          }
          if (popoverRef.current?.confirm()) {
            e.preventDefault()
            return
          }
        }
      }
      // Regular Enter (no modifiers, not composing) → submit.
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !isComposing) {
        e.preventDefault()
        void submit()
      }
    },
    [trigger, permissionMode, setPermissionMode, dismissPopover, submit, isComposing]
  )

  const onChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      controller.textInput.setInput(e.target.value)
      setCaret(e.target.selectionStart ?? e.target.value.length)
    },
    [controller.textInput]
  )

  const onSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    setCaret(ta.selectionStart ?? ta.value.length)
  }, [])

  // --- Paste / drag for attachments -------------------------------------
  const acceptFiles = useCallback(
    (files: FileList | File[]) => {
      const incoming = [...files].filter((f) => f.type.startsWith(SUPPORTED_IMAGE_PREFIX))
      const sized = incoming.filter((f) => f.size <= MAX_FILE_SIZE)
      const rejected = incoming.length - sized.length
      if (rejected > 0) {
        toast.warning(
          tAttach("fileSizeExceeded", {
            count: rejected,
            max: MAX_FILE_SIZE / (1024 * 1024),
          })
        )
      }
      const headroom = Math.max(0, MAX_FILES - attachments.files.length)
      const take = sized.slice(0, headroom)
      if (sized.length > headroom) {
        toast.warning(tAttach("countLimit", { max: MAX_FILES }))
      }
      if (take.length > 0) attachments.add(take)
    },
    [attachments, tAttach]
  )

  const onPaste = useCallback(
    (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const it of items) {
        if (it.kind === "file") {
          const f = it.getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length > 0) {
        e.preventDefault()
        acceptFiles(files)
      }
    },
    [acceptFiles]
  )

  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types?.includes("Files")) return
    setDragDepth((d) => d + 1)
  }, [])
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault()
  }, [])
  const onDragLeave = useCallback(() => {
    setDragDepth((d) => Math.max(0, d - 1))
  }, [])
  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      setDragDepth(0)
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      e.preventDefault()
      acceptFiles(files)
    },
    [acceptFiles]
  )

  const onFilePick = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) acceptFiles(e.target.files)
      e.target.value = ""
    },
    [acceptFiles]
  )

  const openFileDialog = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // Imperative handle: insert `@name ` at the caret. Used by the desktop
  // shell's member list to mention a teammate without going through any
  // intermediate draft store.
  useImperativeHandle(
    props.handleRef,
    () => ({
      insertMention: (name: string) => {
        const ta = textareaRef.current
        const cur = controller.textInput.value
        const pos = ta?.selectionStart ?? cur.length
        const needsLeadSpace = pos > 0 && !/\s$/.test(cur.slice(0, pos))
        const insertion = `${needsLeadSpace ? " " : ""}@${name} `
        const next = cur.slice(0, pos) + insertion + cur.slice(pos)
        controller.textInput.setInput(next)
        const caret = pos + insertion.length
        requestAnimationFrame(() => {
          const ta2 = textareaRef.current
          if (ta2) {
            ta2.setSelectionRange(caret, caret)
            ta2.focus()
          }
        })
        setCaret(caret)
      },
    }),
    [controller.textInput]
  )

  const isStreaming = props.status === "streaming"

  return (
    <div ref={setContainerEl}>
      <ReferenceChips />
      <AttachmentPreview />
      <div
        className={cn(
          "relative flex items-end gap-2 rounded-2xl border border-input/60 bg-background px-2 py-2 shadow-sm transition-shadow",
          "focus-within:border-primary/40 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/15"
        )}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <DragOverlay visible={isDragging} />

        <input
          accept="image/*"
          aria-label={t("ariaUploadImage")}
          className="hidden"
          multiple
          onChange={onFilePick}
          ref={fileInputRef}
          type="file"
        />

        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={t("ariaAttachImage")}
                className="size-9 text-muted-foreground hover:text-foreground"
                disabled={props.disabled}
                onClick={openFileDialog}
                size="icon"
                type="button"
                variant="ghost"
              >
                <PaperclipIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("attachImageTooltip")}</TooltipContent>
          </Tooltip>

          {isTauri() && <ScreenshotButton disabled={props.disabled} />}

          <VoiceTranscriptionBridge disabled={props.disabled} />
        </div>

        <div className="relative flex-1 self-center">
          <textarea
            aria-label={t("ariaMessage")}
            className={cn(
              "field-sizing-content block min-h-6 w-full resize-none bg-transparent px-1 py-1.5 pr-10 text-sm leading-6 outline-none placeholder:text-muted-foreground"
            )}
            disabled={props.disabled}
            name="message"
            onChange={onChange}
            onCompositionEnd={() => setIsComposing(false)}
            onCompositionStart={() => setIsComposing(true)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onSelect={onSelect}
            placeholder={props.disabled ? t("placeholderDisabled") : t("placeholder")}
            ref={textareaRef}
            rows={1}
            style={{ maxHeight: "12rem" }}
            value={controller.textInput.value}
          />
          <CharCounter />
        </div>

        <div className="flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={isStreaming ? t("ariaStop") : t("ariaSend")}
                className="size-9 rounded-full"
                disabled={
                  !isStreaming &&
                  (props.disabled ||
                    (controller.textInput.value.trim().length === 0 &&
                      attachments.files.length === 0))
                }
                onClick={() => (isStreaming ? void props.onStop() : void submit())}
                size="icon"
                type="button"
              >
                {isStreaming ? (
                  <SquareIcon className="size-4" />
                ) : props.status === "submitted" ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <ArrowUpIcon className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isStreaming ? t("stopTooltip") : t("sendTooltip")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ComposerPopover
        ref={popoverRef}
        trigger={trigger}
        cwd={cwd}
        slashCommands={slashCommands}
        anchor={containerEl}
        onPick={onPickPopoverItem}
        onDismiss={dismissPopover}
      />
    </div>
  )
}

function VoiceTranscriptionBridge({ disabled }: { disabled?: boolean }) {
  const controller = usePromptInputController()
  const onTranscription = useCallback(
    (text: string) => {
      if (!text.trim()) return
      const cur = controller.textInput.value
      const sep = cur && !cur.endsWith(" ") ? " " : ""
      controller.textInput.setInput(`${cur}${sep}${text}`)
    },
    [controller.textInput]
  )
  return <VoiceControls disabled={disabled} onTranscription={onTranscription} />
}

// --- Outer component ------------------------------------------------------

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { session, onStartNewSession, onOpenSettings, onSend, onStop, disabled },
  ref
) {
  const tCommands = useTranslations("chat.composer.commands")
  const tShell = useTranslations("chat.composer.shell")
  const tMemory = useTranslations("chat.composer.memory")
  const tAttach = useTranslations("chat.composer.attachments")
  const tWebSearch = useTranslations("webSearchToggle")
  const status = useChatStore((s) => s.status)
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const clearReferencedPaths = useChatStore((s) => s.clearReferencedPaths)

  const cwd = session?.workingDir ?? null

  const pushSystemMessage = useCallback(
    (markdown: string) => {
      appendMessage({
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "system",
        parts: [{ type: "text", text: markdown }],
      })
    },
    [appendMessage]
  )

  const handleSlashCommand = useCallback(
    async (cmd: SlashCommand, args: string): Promise<boolean> => {
      if (cmd.handler) {
        const ctx: SlashContext = {
          args,
          activeSessionId: session?.id ?? null,
          chatStatus: status,
          currentPermissionMode: useChatStore.getState().permissionMode,
          startNewSession: onStartNewSession,
          openSettings: onOpenSettings,
          setPermissionMode,
          pushSystemMessage,
        }
        try {
          await cmd.handler(ctx)
        } catch (err) {
          loggers.chat.error("slash command failed", err, {
            command: cmd.name,
            sessionId: session?.id,
          })
          toast.error(err instanceof Error ? err.message : tCommands("failed"))
        }
        return true
      }
      if (cmd.template) return true
      return false
    },
    [
      session,
      status,
      onStartNewSession,
      onOpenSettings,
      setPermissionMode,
      pushSystemMessage,
      tCommands,
    ]
  )

  const handleBashSubmit = useCallback(
    async (rawCmd: string): Promise<boolean> => {
      const cmd = rawCmd.trim()
      if (!cmd) return false
      if (!cwd) {
        toast.error(tShell("needsCwd"))
        return false
      }
      pushSystemMessage(tShell("runningHint", { cmd, cwd }))
      try {
        const result = await executeShell(cmd, cwd)
        pushSystemMessage(formatShellResult(cmd, result))
      } catch (err) {
        loggers.chat.error("shell command failed", err, { cmd, cwd })
        pushSystemMessage(
          tShell("failed", {
            cmd,
            error: err instanceof Error ? err.message : String(err),
          })
        )
      }
      return true
    },
    [cwd, pushSystemMessage, tShell]
  )

  const handleMemorySubmit = useCallback(
    async (scope: MemoryScope, text: string): Promise<boolean> => {
      try {
        const path = await appendMemory(scope, text, cwd)
        toast.success(tMemory("appended", { path }))
        return true
      } catch (err) {
        loggers.chat.error("memory append failed", err, { scope, cwd })
        toast.error(err instanceof Error ? err.message : tMemory("failed"))
        return false
      }
    },
    [cwd, tMemory]
  )

  const handleSubmit = useCallback(
    async (text: string, files: SubmittedFile[]) => {
      const trimmed = text.trim()
      if (trimmed.startsWith("!")) {
        await handleBashSubmit(trimmed.slice(1))
        return
      }
      if (trimmed.startsWith("#")) {
        toast.info(tMemory("pickScope"))
        return
      }

      // ── Web search prefetch ─────────────────────────────────────────
      // If the user toggled web search for this turn, run the query through
      // the configured provider before forwarding to the SDK and prepend the
      // formatted results as a system block. We don't fail the send on
      // search errors — fall back to the original message instead.
      let augmented = text
      const webOn = useChatStore.getState().webSearchOnForNextSend
      if (webOn && trimmed) {
        const settings = useSettingsStore.getState().settings
        try {
          const resp = await search(trimmed, {
            providerSettings: settings?.searchProviders,
            provider: settings?.defaultSearchProvider,
            fallbackEnabled: settings?.searchFallbackEnabled ?? true,
            maxResults: settings?.searchMaxResults ?? 5,
            searchType: settings?.defaultSearchType,
            searchDepth: settings?.defaultSearchDepth,
            recency: settings?.defaultSearchRecency,
            country: settings?.defaultSearchCountry,
            language: settings?.defaultSearchLanguage,
            includeDomains: settings?.defaultIncludeDomains,
            excludeDomains: settings?.defaultExcludeDomains,
            includeAnswer: settings?.defaultIncludeAnswer,
            includeRawContent: settings?.defaultIncludeRawContent,
          })
          const ctx = formatSearchResultsForLLM(resp)
          augmented = `${ctx}\n\n---\n\nUser question: ${text}`
          pushSystemMessage(
            `🔎 ${tWebSearch("searchedVia", {
              provider: resp.provider,
              count: resp.results.length,
            })}`
          )
        } catch (err) {
          loggers.chat.error("web search failed", err, { query: trimmed })
          toast.error(
            tWebSearch("searchFailed", {
              message: err instanceof Error ? err.message : String(err),
            })
          )
        }
        useChatStore.getState().setWebSearchOnForNextSend(false)
      }

      const { content, rejected } = buildSendContent(augmented, files)
      const isEmpty =
        (typeof content === "string" && !content.trim()) ||
        (Array.isArray(content) && content.length === 0)
      if (isEmpty) return
      if (rejected > 0) {
        toast.warning(tAttach("skipped", { count: rejected }))
      }
      await onSend(content)
      clearReferencedPaths()
    },
    [
      onSend,
      handleBashSubmit,
      clearReferencedPaths,
      pushSystemMessage,
      tAttach,
      tMemory,
      tWebSearch,
    ]
  )

  const promptStatus: PromptStatus =
    status === "streaming" || status === "awaiting_approval"
      ? "streaming"
      : status === "error"
        ? "error"
        : "ready"

  return (
    <div className="border-t bg-background p-3">
      <PromptInputProvider>
        <ComposerInner
          session={session}
          status={promptStatus}
          disabled={disabled}
          onSubmit={handleSubmit}
          onStop={onStop}
          onCommand={handleSlashCommand}
          onSubmitMemory={handleMemorySubmit}
          handleRef={ref}
        />
        <BottomToolbar session={session ?? null} />
        <HelperHints />
      </PromptInputProvider>
    </div>
  )
})
