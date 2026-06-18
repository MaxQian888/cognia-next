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
import { ArrowUpIcon, FolderIcon, Loader2Icon, PaperclipIcon, SquareIcon } from "lucide-react"
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
import type { SendContent, SendContentBlock, ChatSession, Character } from "@/lib/claude/types"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { usePlatform } from "@/hooks/use-platform"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  detectTrigger,
  spliceToken,
  type ComposerTrigger,
  type MentionMode,
} from "./composer-trigger"
import { ComposerPopover, type ComposerPopoverHandle, type PopoverItem } from "./composer-popover"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import { ReferenceChips } from "./reference-chips"
import { nextPermissionMode } from "./permission-mode-indicator"
import { useResolvedConnectorMode } from "./use-resolved-connector-mode"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { getDb } from "@/lib/db/schema"
import {
  listPendingForConversation as listPendingDrafts,
  approveDraft,
  rejectDraft,
} from "@/lib/db/connector-drafts"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import {
  BUILTIN_SLASH_COMMANDS,
  applyTemplate,
  type SettingsTab,
  type SlashCommand,
  type SlashContext,
} from "@/lib/slash-commands/builtin"
import { loadCustomSlashCommands } from "@/lib/slash-commands/custom"
import { parseSegments } from "@/lib/slash-commands/parse-segments"
import { runSegments } from "@/lib/slash-commands/run-segments"
import { ComposerChipOverlay, TEXTAREA_TYPOGRAPHY } from "./composer-chip-overlay"
import { ComposerGhostText } from "./composer/composer-ghost-text"
import { useComposerGhostText } from "@/hooks/chat/use-composer-ghost-text"
import { useInputHistory } from "./composer/hooks/use-input-history"
import { CommandParamForm } from "./composer/command-param-form"
import { executeShell, formatShellResult } from "@/lib/shell/exec"
import { appendMemory, type MemoryScope } from "@/lib/files/memory"
import { useUpdateSession } from "@/lib/data-hooks/context"
import { loggers } from "@/lib/logging"
import { MentionPopover } from "@/components/mobile/chat/mention-popover"
import {
  clearDraft as clearChatDraft,
  getDraft as getChatDraft,
  setDraftDebounced as setChatDraftDebounced,
  type DraftAttachmentMeta,
} from "@/lib/db/chat-drafts"
import { draftAttachmentsFromFiles } from "@/lib/chat/draft-attachments"
import { DraftRestoredAttachments } from "./composer/draft-restored-attachments"
import { AttachmentPreview } from "./composer/attachment-preview"
import { OcrResultBubble } from "./composer/ocr-result-bubble"
import { applyComposerOcr } from "./composer/ocr-attachment-action"
import { useOcr } from "@/hooks/use-ocr"
import { buildOcrDeps } from "@/lib/ocr/deps"
import type { OcrResult } from "@/types/ocr"
import { BottomToolbar } from "./composer/bottom-toolbar"
import { SkillChipRow } from "./composer/skill-chip-row"
import { GoalStatusPill } from "@/components/goal/goal-status-pill"
import { LoopStatusPill } from "@/components/loop/loop-status-pill"
import { CharCounter } from "./composer/char-counter"
import { DragOverlay } from "./composer/drag-overlay"
import { HelperHints } from "./composer/helper-hints"
import { ScreenshotButton } from "./composer/screenshot-button"
import { VoiceControls } from "./composer/voice-controls"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { InboxComposerActionsHost } from "@/components/inbox/inbox-composer-actions-host"
import { CannedResponsePicker } from "@/components/inbox/canned-response-picker"

interface Props {
  session?: ChatSession | null
  onStartNewSession: () => void | Promise<void>
  onOpenSettings: (tab: SettingsTab) => void
  onSend: (content: SendContent) => void | Promise<void>
  onStop: () => void | Promise<void>
  disabled?: boolean
  /**
   * What `@` should mean in this composer. Defaults to `"files"` (the
   * standard chat). Set to `"agents"` in the agent-team workspace where
   * `@` opens the team-member / virtual-runtime picker instead.
   */
  mentionMode?: MentionMode
  /**
   * Mentionable agents — required when `mentionMode === "agents"`.
   */
  mentionables?: readonly MentionTarget[]
  /**
   * Override the default placeholder. Useful for the team workspace which
   * needs a different hint text.
   */
  placeholder?: string
  /**
   * When provided, typing `@` opens a mobile-styled inline mention popover
   * over the textarea instead of routing to the desktop `@file`/`@agent`
   * picker. Designed for the mobile app shell where the team-member sheet
   * was a two-tap affair. Desktop callers leave this undefined.
   */
  mobileMentionMembers?: readonly Character[]
}

/**
 * Imperative handle exposed by `<Composer>`. The desktop shell uses it to
 * inject `@CharacterName` mentions at the caret when the user clicks a
 * row in the team member list.
 */
export interface ComposerHandle {
  insertMention: (name: string) => void
  /** Move keyboard focus to the textarea. The chat pane calls this after the
   *  empty→chat layout swap remounts the composer so focus isn't dropped. */
  focus: () => void
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
  /** Non-zero when the session has pending connector drafts to review. */
  pendingDraftCount?: number
  mentionMode?: MentionMode
  mentionables?: readonly MentionTarget[]
  placeholder?: string
  mobileMentionMembers?: readonly Character[]
}

function ComposerInner(props: InnerProps) {
  const t = useTranslations("chat.composer")
  const tAttach = useTranslations("chat.composer.attachments")
  const tCommands = useTranslations("chat.composer.commands")
  const tMemory = useTranslations("chat.composer.memory")
  const platform = usePlatform()
  const isDesktop = platform === "tauri"
  // Capacitor native shell. Mobile gets a Claude-style vertical layout
  // (textarea on top, a single bottom action row) regardless of container
  // width; web/desktop keep the container-query responsive layout below.
  const isMobile = platform === "mobile"
  const hasPendingDrafts = (props.pendingDraftCount ?? 0) > 0
  const controller = usePromptInputController()
  const attachments = usePromptInputAttachments()
  const ocr = useOcr(() => buildOcrDeps())
  const [ocrBubbleOpen, setOcrBubbleOpen] = useState(false)
  const [ocrBubbleResult, setOcrBubbleResult] = useState<OcrResult | null>(null)
  const [ocrBubbleImageSrc, setOcrBubbleImageSrc] = useState<string | null>(null)

  // Composer attachment OCR: an image/PDF attachment's hover menu offers
  // "extract text to input" (appends plain text to the draft) or "view result"
  // (opens the per-page sheet). The attachment already holds a blob URL, so we
  // resolve it to a Blob and hand a `blob` source straight to `extract()` — no
  // attachment-id resolver needed.
  const handleOcrSelect = useCallback(
    async (action: "extract-to-input" | "view-result", attachmentId: string) => {
      const file = attachments.files.find((f) => f.id === attachmentId)
      if (!file?.url) return
      let blob: Blob
      try {
        blob = await (await fetch(file.url)).blob()
      } catch {
        return
      }
      await applyComposerOcr({
        action,
        blob,
        mimeType: file.mediaType || blob.type,
        run: ocr.run,
        getInput: () => controller.textInput.value,
        setInput: (value) => controller.textInput.setInput(value),
        showResult: (result) => {
          setOcrBubbleResult(result)
          setOcrBubbleImageSrc(
            (file.mediaType ?? "").startsWith("image/") ? (file.url ?? null) : null
          )
          setOcrBubbleOpen(true)
        },
      })
    },
    [attachments, ocr, controller.textInput]
  )
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const chipOverlayRef = useRef<HTMLDivElement>(null)
  const ghostOverlayRef = useRef<HTMLDivElement>(null)
  const ghost = useComposerGhostText(props.session)
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)
  const popoverRef = useRef<ComposerPopoverHandle | null>(null)

  const [caret, setCaret] = useState(0)
  const [popoverDismissed, setPopoverDismissed] = useState<{
    tokenStart: number
    kind: string
  } | null>(null)
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([])
  // When a picked command declares `params`, we open a guided form instead of
  // inserting raw text. The captured token range tells us where to splice the
  // built `/command <args>` chip back in.
  const [paramForm, setParamForm] = useState<{
    command: SlashCommand
    tokenStart: number
    tokenEnd: number
  } | null>(null)
  const [isComposing, setIsComposing] = useState(false)
  // Attachment metadata restored from a draft (declared here so `handleSend`'s
  // clear path can reset it). The binary isn't persisted — these surface as
  // "re-attach" reminder chips above the input.
  const [restoredAttachments, setRestoredAttachments] = useState<DraftAttachmentMeta[]>([])
  const [dragDepth, setDragDepth] = useState(0)
  const isDragging = dragDepth > 0

  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const permissionMode = useChatStore((s) => s.permissionMode)
  const addReferencedPath = useChatStore((s) => s.addReferencedPath)
  const updateSession = useUpdateSession()
  const cwd = props.session?.workingDir ?? null
  const sessionId = props.session?.id ?? null

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

  // Name → command map for submit-time multi-command dispatch. Built from the
  // UNFILTERED list (includes `hiddenFromPicker` commands) so a typed command
  // still resolves even when it's not shown in the picker.
  const commandMap = useMemo(
    () => new Map([...BUILTIN_SLASH_COMMANDS, ...customCommands].map((c) => [c.name, c])),
    [customCommands]
  )

  // Segment the live input so the chip overlay can paint a pill under every
  // recognised `/command`. Same parse + command map used at submit time.
  const segments = useMemo(
    () => parseSegments(controller.textInput.value, (name) => commandMap.has(name)),
    [controller.textInput.value, commandMap]
  )

  // Shell-style ↑/↓ recall of previously sent messages for this session.
  const history = useInputHistory(sessionId)

  const trigger = useMemo<ComposerTrigger | null>(() => {
    const tg = detectTrigger(controller.textInput.value, caret, {
      mentionMode: props.mentionMode,
    })
    if (!tg) return null
    if (
      popoverDismissed &&
      popoverDismissed.kind === tg.kind &&
      popoverDismissed.tokenStart === tg.tokenStart
    ) {
      return null
    }
    return tg
  }, [controller.textInput.value, caret, popoverDismissed, props.mentionMode])

  useEffect(() => {
    if (!popoverDismissed) return
    const tg = detectTrigger(controller.textInput.value, caret, {
      mentionMode: props.mentionMode,
    })
    if (!tg || tg.kind !== popoverDismissed.kind || tg.tokenStart !== popoverDismissed.tokenStart) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPopoverDismissed(null)
    }
  }, [controller.textInput.value, caret, popoverDismissed, props.mentionMode])

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
        // Commands with structured params open a guided form; defer insertion
        // until the user confirms. Capture the token range to splice into.
        if (cmd.params && cmd.params.length > 0) {
          setParamForm({ command: cmd, tokenStart: trigger.tokenStart, tokenEnd: trigger.tokenEnd })
          dismissPopover()
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
      } else if (item.kind === "agent") {
        const replacement = `@${item.target.name}`
        insertReplacement(replacement)
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

  // Param-form confirm: splice `/command <args>` into the captured token range
  // as a chip the user can review/send. Cancel just closes (leaving the typed
  // partial command intact).
  const handleParamFormSubmit = useCallback(
    (args: string) => {
      setParamForm((current) => {
        if (!current) return null
        const cur = controller.textInput.value
        const replacement = `/${current.command.name}${args ? ` ${args}` : ""}`
        const { value, caret } = spliceToken(cur, current.tokenStart, current.tokenEnd, replacement)
        controller.textInput.setInput(value)
        requestAnimationFrame(() => {
          const ta = textareaRef.current
          if (ta) {
            ta.setSelectionRange(caret, caret)
            ta.focus()
          }
        })
        return null
      })
    },
    [controller.textInput]
  )

  const handleParamFormCancel = useCallback(() => {
    setParamForm(null)
    textareaRef.current?.focus()
  }, [])

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

    // Record the exact typed text for ↑/↓ recall (before any command stripping).
    history.record(text)

    const clearAfterSend = () => {
      controller.textInput.clear()
      attachments.clear()
      setRestoredAttachments([])
      if (sessionId) {
        void clearChatDraft(sessionId)
      }
      textareaRef.current?.focus()
    }

    // Multi-command: the live `segments` memo already split this input into
    // ordered command / text segments. A `!shell` / `#memory` whole-message
    // prefix is left to the outer handleSubmit (the parser ignores those). When
    // the message contains one or more line-start `/commands`, run them in
    // order: action handlers execute via `props.onCommand` (context-rich,
    // self-toasting), template commands expand inline, and the leftover prose is
    // what gets sent.
    const hasCommand = segments.some((s) => s.kind === "command")
    if (hasCommand) {
      const { outgoingText, overrides, ranAction } = await runSegments(segments, {
        commandMap,
        runAction: async (command, args) => {
          await props.onCommand(command, args)
        },
        applyTemplate,
      })
      useChatStore.getState().setPendingCommandOverrides(overrides)
      // Only send a turn when there is prose or attachments. An action-only
      // batch (e.g. `/clear`) mutates client state and sends nothing — mirroring
      // today's "action command clears the input, no turn" behavior.
      if (outgoingText.length > 0 || filesToSend.length > 0) {
        await props.onSubmit(outgoingText, filesToSend)
      } else if (!ranAction) {
        // Defensive: no prose, no files, no action — nothing to do.
        return
      }
      clearAfterSend()
      return
    }

    await props.onSubmit(text, filesToSend)
    clearAfterSend()
  }, [controller.textInput, attachments, props, sessionId, commandMap, segments, history])

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
      // Inline ghost-text acceptance (only when no `/@!#` popover is open).
      // Tab accepts the dim continuation; Esc dismisses it. Both fall through
      // to existing behavior when there is no ghost to act on.
      if (!trigger && ghost.ghost) {
        if (e.key === "Tab" && !e.shiftKey) {
          const next = ghost.accept()
          if (next !== null) {
            e.preventDefault()
            controller.textInput.setInput(next)
            requestAnimationFrame(() => {
              const ta = textareaRef.current
              if (ta) {
                ta.setSelectionRange(next.length, next.length)
                ta.focus()
              }
            })
            return
          }
        }
        if (e.key === "Escape") {
          e.preventDefault()
          ghost.dismiss()
          return
        }
      }
      // ↑/↓ recall of previously sent messages (only when no popover is open
      // and not composing). ↑ engages from the very start of the input; while
      // navigating, both arrows walk the history and ↓ past the newest restores
      // the stashed draft.
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !isComposing) {
        const ta = e.currentTarget
        const caretAtStart = ta.selectionStart === 0 && ta.selectionEnd === 0
        const next = history.recall(e.key === "ArrowUp" ? "up" : "down", {
          value: controller.textInput.value,
          caretAtStart,
        })
        if (next !== null) {
          e.preventDefault()
          controller.textInput.setInput(next)
          requestAnimationFrame(() => {
            const t = textareaRef.current
            if (t) {
              t.setSelectionRange(next.length, next.length)
              t.focus()
            }
          })
          return
        }
      }
      // Regular Enter (no modifiers, not composing) → submit.
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !isComposing) {
        e.preventDefault()
        void submit()
      }
    },
    [
      trigger,
      permissionMode,
      setPermissionMode,
      dismissPopover,
      submit,
      isComposing,
      history,
      controller.textInput,
      ghost,
    ]
  )

  const onChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      controller.textInput.setInput(e.target.value)
      setCaret(e.target.selectionStart ?? e.target.value.length)
      // Typing exits history-recall mode so the next ↑ starts from the newest.
      history.noteEdit()
    },
    [controller.textInput, history]
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

  // ── Mobile inline mention popover ──────────────────────────────────────
  // When `mobileMentionMembers` is supplied, the chat shell wants the inline
  // bottom-sheet popover instead of the desktop `<ComposerPopover>`'s
  // @file/@agent picker. We branch by whether the active trigger is `@`-kind
  // (`file` or `agent`); other kinds (slash/bash/memory) keep the desktop
  // popover so all existing flows still work on mobile.
  const mobileMentionEnabled = !!props.mobileMentionMembers
  const isAtTrigger = trigger?.kind === "file" || trigger?.kind === "agent"
  const mobileMentionOpen = !!(mobileMentionEnabled && isAtTrigger)
  const mobileMentionQuery = mobileMentionOpen ? (trigger?.query ?? "") : ""

  const desktopTrigger = mobileMentionOpen ? null : trigger

  const onPickMobileMember = useCallback(
    (member: Character) => {
      insertReplacement(`@${member.name}`)
    },
    [insertReplacement]
  )

  // ── Per-session draft persistence (Phase 3.2) ─────────────────────────
  const [draftHydratedFor, setDraftHydratedFor] = useState<string | null>(null)
  // Attachment metadata restored from a draft. The binary isn't persisted, so
  // these surface as "re-attach" reminder chips above the input.
  const tDraft = useTranslations("chat.composer.draftRestore")
  // The next-intl translator isn't a stable reference, so we read it through a
  // ref instead of listing it as an effect dependency — depending on it would
  // re-run the hydration effect every render and loop on its setState calls.
  const tDraftRef = useRef(tDraft)
  useEffect(() => {
    tDraftRef.current = tDraft
  }, [tDraft])

  useEffect(() => {
    if (!sessionId) return
    if (draftHydratedFor === sessionId) return
    let cancelled = false
    getChatDraft(sessionId)
      .then((row) => {
        if (cancelled) return
        if (row?.text) {
          controller.textInput.setInput(row.text)
        }
        // Reset (or populate) the reminder chips for the session we just
        // switched to — a session with no staged attachments clears them.
        const restored = row?.attachments ?? []
        setRestoredAttachments(restored)
        if (restored.length > 0) {
          toast.info(tDraftRef.current("toast", { count: restored.length }))
        }
        setDraftHydratedFor(sessionId)
      })
      .catch(() => {
        if (cancelled) return

        setDraftHydratedFor(sessionId)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, draftHydratedFor, controller.textInput])

  useEffect(() => {
    if (!sessionId) return
    if (draftHydratedFor !== sessionId) return
    try {
      setChatDraftDebounced(
        sessionId,
        controller.textInput.value,
        draftAttachmentsFromFiles(attachments.files)
      )
    } catch {
      // Dexie unavailable (e.g., SSR / tests without fake-indexeddb) — drafts are best-effort.
    }
  }, [controller.textInput.value, attachments.files, sessionId, draftHydratedFor])

  // Auto-resize textarea (JS fallback for browsers without field-sizing:content
  // support, e.g. older iOS/Android WebViews). field-sizing-content in the
  // className is the progressive-enhancement path; this effect only runs when
  // the CSS property is absent.
  //
  // Crucially, it must NOT touch the textarea mid-composition: mutating
  // `style.height` forces a synchronous reflow that aborts the active IME
  // composition buffer on Android/iOS WebViews, so on-device typing (esp. CJK
  // / predictive keyboards) appears to "swallow" characters. We defer the
  // resize until composition ends, where this effect re-runs (isComposing flips
  // back to false) and adjusts the height once for the committed text.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) return
    if (isComposing) return
    ta.style.height = "auto"
    ta.style.height = `${Math.min(ta.scrollHeight, 12 * 16)}px`
  }, [controller.textInput.value, isComposing])

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
      focus: () => {
        textareaRef.current?.focus()
      },
    }),
    [controller.textInput]
  )

  const isStreaming = props.status === "streaming"

  // Drive the inline ghost-text engine off the current draft. Suppress while a
  // `/@!#` trigger popover is open, the caret isn't at the end of the text, or
  // a turn is streaming / the composer is disabled — the controller debounces
  // and only the most recent feed is queried, so this always reflects state.
  const ghostFeed = ghost.feed
  useEffect(() => {
    const value = controller.textInput.value
    const suppress = !!trigger || isStreaming || !!props.disabled || caret !== value.length
    ghostFeed(value, { suppress })
  }, [controller.textInput.value, caret, trigger, isStreaming, props.disabled, ghostFeed])

  const ephemeralSkillIds = useChatStore((s) => s.ephemeralSkillIds)
  const toggleEphemeralSkill = useChatStore((s) => s.toggleEphemeralSkill)

  return (
    <div ref={setContainerEl}>
      <ReferenceChips />
      <DraftRestoredAttachments
        items={restoredAttachments}
        onDismiss={() => setRestoredAttachments([])}
      />
      <AttachmentPreview onOcrSelect={handleOcrSelect} ocrBusy={ocr.status === "running"} />
      <OcrResultBubble
        open={ocrBubbleOpen}
        onOpenChange={setOcrBubbleOpen}
        result={ocrBubbleResult}
        imageSrc={ocrBubbleImageSrc ?? undefined}
        onCopy={(text) => void navigator.clipboard?.writeText(text)}
        onCopyPage={(_page, text) => void navigator.clipboard?.writeText(text)}
      />
      <PluginExtensionSlot point="chat.input.above" className="px-1 empty:hidden" />
      <SkillChipRow ids={ephemeralSkillIds} onRemove={toggleEphemeralSkill} />
      {/* ADR-0019 — active/paused goal status + controls; self-hides when none. */}
      <GoalStatusPill sessionId={sessionId} />
      {/* /loop status + controls; self-hides when no open loop. */}
      <LoopStatusPill sessionId={sessionId} />
      <div
        className={cn(
          // Claude-style stack on every platform when the container is narrow:
          // the textarea fills the first row (w-full forces the wrap), the
          // attach + send clusters share ONE bottom row. On web/desktop the
          // children's @sm/composer:* classes reset order/width so the box
          // re-forms the single-row [attach | textarea | send] layout; the
          // flex-1 textarea (basis-0) then prevents any further wrapping.
          // Mobile (Capacitor) keeps the stack at every width.
          "relative flex flex-wrap items-end gap-2 rounded-2xl border border-input/60 bg-background/70 px-2 py-2 shadow-sm transition-shadow",
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

        <div
          className={cn(
            "order-2 flex shrink-0 items-center gap-0.5",
            !isMobile && "@sm/composer:order-none"
          )}
        >
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

          {isDesktop && <ScreenshotButton disabled={props.disabled} />}

          <VoiceTranscriptionBridge disabled={props.disabled} />
        </div>

        <div
          className={cn(
            "relative order-1 w-full min-w-0",
            !isMobile &&
              "@sm/composer:order-none @sm/composer:w-auto @sm/composer:flex-1 @sm/composer:self-center"
          )}
        >
          <ComposerChipOverlay
            ref={chipOverlayRef}
            value={controller.textInput.value}
            segments={segments}
          />
          <ComposerGhostText
            ref={ghostOverlayRef}
            value={controller.textInput.value}
            ghost={ghost.ghost}
            acceptHint={t("ghostAcceptHint")}
          />
          <Textarea
            aria-label={t("ariaMessage")}
            className={cn(
              "field-sizing-content relative z-[1] block min-h-6 w-full resize-none border-0 bg-transparent shadow-none outline-none ring-0 placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0",
              TEXTAREA_TYPOGRAPHY
            )}
            disabled={props.disabled}
            name="message"
            onChange={onChange}
            onCompositionEnd={() => setIsComposing(false)}
            onCompositionStart={() => setIsComposing(true)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onScroll={(e) => {
              // Mirror vertical scroll onto the chip + ghost overlays
              // imperatively (no React state → no re-render churn while
              // scrolling).
              const offset = `translateY(${-e.currentTarget.scrollTop}px)`
              const el = chipOverlayRef.current
              if (el) el.style.transform = offset
              const ghostEl = ghostOverlayRef.current
              if (ghostEl) ghostEl.style.transform = offset
            }}
            onSelect={onSelect}
            placeholder={
              props.disabled ? t("placeholderDisabled") : (props.placeholder ?? t("placeholder"))
            }
            ref={textareaRef}
            rows={1}
            style={{ maxHeight: "12rem" }}
            value={controller.textInput.value}
          />
          <CharCounter />
        </div>

        <div
          className={cn(
            "order-3 ml-auto flex shrink-0 items-center",
            !isMobile && "@sm/composer:order-none @sm/composer:ml-0"
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              {hasPendingDrafts ? (
                <Button
                  aria-label={t("editDraftAria")}
                  className="h-9 rounded-full px-3 text-xs"
                  disabled={props.disabled}
                  onClick={() => void submit()}
                  type="button"
                  variant="secondary"
                >
                  {t("editDraftTooltip")}
                </Button>
              ) : (
                <Button
                  aria-label={isStreaming ? t("ariaStop") : t("ariaSend")}
                  className="size-9 rounded-full"
                  disabled={
                    // In web mode, platform-bound sessions cannot send outbound messages.
                    (!isDesktop && !!props.session?.platformBinding) ||
                    (!isStreaming &&
                      (props.disabled ||
                        (controller.textInput.value.trim().length === 0 &&
                          attachments.files.length === 0)))
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
              )}
            </TooltipTrigger>
            <TooltipContent>
              {hasPendingDrafts
                ? t("editDraftTooltip")
                : isStreaming
                  ? t("stopTooltip")
                  : t("sendTooltip")}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <PluginExtensionSlot point="chat.input.below" className="px-1 pt-1 empty:hidden" />

      {/* Inbox-only composer actions (IM-completion §C). Mounted only when
       * the active session is bound to an external platform conversation;
       * keeps the inbox extension surface separate from the generic
       * chat.input.actions one so a regular chat session never sees them.
       */}
      {props.session?.platformBinding && (
        <div className="flex items-center gap-1 px-1 pt-1">
          <CannedResponsePicker
            conversationKey={props.session.platformBinding.conversationKey}
            context={{
              conversation: {
                title: props.session.title,
                platform: props.session.platformBinding.platform,
              },
              contact: { platform: props.session.platformBinding.platform },
            }}
          />
          <InboxComposerActionsHost
            conversationKey={props.session.platformBinding.conversationKey}
            adapterId={props.session.platformBinding.adapterId}
            platform={props.session.platformBinding.platform}
            sessionId={props.session.id}
            className="flex items-center gap-1 empty:hidden"
          />
        </div>
      )}

      {cwd && (
        <div className="flex items-center gap-1 px-2 pb-1 text-[11px] text-muted-foreground">
          <FolderIcon className="size-3 shrink-0" />
          <span className="truncate font-mono" title={cwd}>
            {cwd}
          </span>
        </div>
      )}

      <ComposerPopover
        ref={popoverRef}
        trigger={desktopTrigger}
        cwd={cwd}
        slashCommands={slashCommands}
        anchor={containerEl}
        mentionables={props.mentionables}
        onPick={onPickPopoverItem}
        onDismiss={dismissPopover}
      />

      {mobileMentionEnabled ? (
        <MentionPopover
          open={mobileMentionOpen}
          query={mobileMentionQuery}
          members={props.mobileMentionMembers ?? []}
          onPick={onPickMobileMember}
          onDismiss={dismissPopover}
        />
      ) : null}

      <CommandParamForm
        command={paramForm?.command ?? null}
        onSubmit={handleParamFormSubmit}
        onCancel={handleParamFormCancel}
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
  {
    session,
    onStartNewSession,
    onOpenSettings,
    onSend,
    onStop,
    disabled,
    mentionMode,
    mentionables,
    placeholder,
    mobileMentionMembers,
  },
  ref
) {
  const tCommands = useTranslations("chat.composer.commands")
  const tShell = useTranslations("chat.composer.shell")
  const tMemory = useTranslations("chat.composer.memory")
  const tAttach = useTranslations("chat.composer.attachments")
  const tWebSearch = useTranslations("webSearchToggle")
  const tDraftReview = useTranslations("chat.composer.draftReview")
  const status = useChatStore((s) => s.status)
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const clearReferencedPaths = useChatStore((s) => s.clearReferencedPaths)

  const cwd = session?.workingDir ?? null

  // ── Platform connector mode ─────────────────────────────────────────────
  const resolvedMode = useResolvedConnectorMode(session)
  const [pendingDrafts, setPendingDrafts] = useState<ConnectorDraftRow[]>([])
  const [draftDialogOpen, setDraftDialogOpen] = useState(false)

  // Poll pending drafts when in draft mode
  useEffect(() => {
    const conversationKey = session?.platformBinding?.conversationKey
    if (!conversationKey || resolvedMode !== "draft") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingDrafts([])
      return
    }
    let cancelled = false
    void listPendingDrafts(conversationKey).then((drafts) => {
      if (!cancelled) setPendingDrafts(drafts)
    })
    return () => {
      cancelled = true
    }
  }, [session?.platformBinding?.conversationKey, resolvedMode])

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
        // Project memory is written at <cwd>/CLAUDE.md — confine the write to
        // the working dir so a stray cwd can't escape it. User scope ignores it.
        const path = await appendMemory(scope, text, cwd, cwd ? [cwd] : null)
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

      // ── Platform connector short-circuit ─────────────────────────────────
      // When a session is platform-bound, branch on the resolved mode before
      // the standard sendPrompt path.
      if (session?.platformBinding && resolvedMode && resolvedMode !== "auto") {
        const { adapterId, conversationKey, conversationRef } = session.platformBinding
        if (resolvedMode === "manual") {
          if (!trimmed && files.length === 0) return
          // Build outbound job for manual delivery
          const job = await enqueueOutbound({
            adapterId,
            conversationKey,
            request: {
              conversationRef,
              segments: [{ type: "text", text: trimmed }],
              metadata: { idempotencyKey: crypto.randomUUID() },
            },
            source: "manual",
          })
          // Insert StoredMessage with outboundJobId
          const now = Date.now()
          await getDb().messages.add({
            id: crypto.randomUUID(),
            sessionId: session.id,
            role: "user",
            parts: [{ type: "text", text: trimmed }],
            metadata: { outboundJobId: job.id },
            createdAt: now,
          })
          return // skip standard sendPrompt — caller's input cleared by ComposerInner
        }
        if (resolvedMode === "draft") {
          // In draft mode, the submit button opens the draft reviewer dialog
          const drafts = await listPendingDrafts(conversationKey)
          setPendingDrafts(drafts)
          setDraftDialogOpen(true)
          return
        }
      }
      // ── END platform connector short-circuit ──────────────────────────────

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
      session,
      resolvedMode,
      setPendingDrafts,
      setDraftDialogOpen,
    ]
  )

  const promptStatus: PromptStatus =
    status === "streaming" || status === "awaiting_approval"
      ? "streaming"
      : status === "error"
        ? "error"
        : "ready"

  // ── Draft review dialog helpers ─────────────────────────────────────────
  const handleApproveDraft = useCallback(
    async (draft: ConnectorDraftRow) => {
      const binding = session?.platformBinding
      if (!binding) return
      await enqueueOutbound({
        adapterId: binding.adapterId,
        conversationKey: binding.conversationKey,
        request: {
          conversationRef: binding.conversationRef,
          segments: draft.segments,
          metadata: { idempotencyKey: crypto.randomUUID() },
        },
        source: "draft-approved",
      })
      await approveDraft(draft.id)
      setPendingDrafts((prev) => prev.filter((d) => d.id !== draft.id))
    },
    [session?.platformBinding]
  )

  const handleRejectDraft = useCallback(async (draft: ConnectorDraftRow) => {
    await rejectDraft(draft.id)
    setPendingDrafts((prev) => prev.filter((d) => d.id !== draft.id))
  }, [])

  return (
    <div className="@container/composer border-t bg-background/70 p-2 sm:p-3">
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
          pendingDraftCount={pendingDrafts.length}
          mentionMode={mentionMode}
          mentionables={mentionables}
          placeholder={placeholder}
          mobileMentionMembers={mobileMentionMembers}
        />
        <BottomToolbar session={session ?? null} />
        <HelperHints />
      </PromptInputProvider>

      {/* Draft review dialog — shown when the session has pending connector drafts */}
      <Dialog open={draftDialogOpen} onOpenChange={setDraftDialogOpen}>
        <DialogContent className="max-w-lg sm:max-w-lg max-w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>{tDraftReview("title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {pendingDrafts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tDraftReview("noPendingDrafts")}</p>
            ) : (
              pendingDrafts.map((draft) => (
                <div key={draft.id} className="rounded-md border p-3 text-sm">
                  <p className="mb-2 whitespace-pre-wrap">
                    {draft.segments
                      .map((s) => (s.type === "text" ? s.text : s.type === "markdown" ? s.md : ""))
                      .join(" ")}
                  </p>
                  <DialogFooter className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleRejectDraft(draft)}
                    >
                      {tDraftReview("reject")}
                    </Button>
                    <Button size="sm" onClick={() => void handleApproveDraft(draft)}>
                      {tDraftReview("approve")}
                    </Button>
                  </DialogFooter>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
})
