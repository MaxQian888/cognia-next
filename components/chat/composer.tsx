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
import type { ChatStatus as PromptStatus, UIMessage } from "ai"
import {
  ArrowUpIcon,
  FileTextIcon,
  Loader2Icon,
  SparklesIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"
import {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  forwardRef,
  KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { useChatStore, type ChatStatus as StoreChatStatus } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { search, formatSearchResultsForLLM } from "@/lib/search/search-service"
import { formatContextSelectionsForLLM } from "@/lib/artifacts/format-selection-context"
import { formatReviewReceiptsForLLM } from "@/lib/artifacts/format-review-receipt"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { SendContent, ChatSession, Character } from "@cognia/agent-config-types"
import {
  buildSendContent,
  INLINE_TOKEN_CEILING,
  type AttachmentManifestEntry,
  type ExtractedAttachment,
  type SubmittedFile,
} from "@/lib/chat/attachments/dispatch"
import { prepareComposerAttachments } from "@/lib/chat/attachments/prepare"
import { captureSmartSnapshotFiles, SMART_SNAPSHOT_COMMAND_ID } from "@/lib/chat/smart-snapshot"
import { applyOrder } from "@/lib/chat/attachments/reorder"
import { StagedAttachmentsProvider, useStagedAttachments } from "./composer/staged-attachment-store"
import { buildLinkContextBlocks, mergeContextBlocks, removeHttpUrl } from "@/lib/chat/link-context"
import { collectDroppedFiles, MAX_DROPPED_DIR_FILES } from "@/lib/chat/drop-entries"
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
import { getDocumentAcceptExtensions } from "@cognia/document/support-matrix"
import { toast } from "sonner"
import { registerCommand } from "@/lib/plugin/commands/registry"
import { cn } from "@/lib/utils"
import { collapsePaste, expandPastes, findPastePlaceholders } from "@/lib/paste-collapse"
import { usePlatform } from "@/hooks/use-platform"
import { useElementHeight } from "@/hooks/use-element-height"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  detectTrigger,
  spliceToken,
  type ComposerTrigger,
  type MentionableWorkflowElement,
  type MentionMode,
} from "./composer-trigger"
import { ComposerPopover, type ComposerPopoverHandle, type PopoverItem } from "./composer-popover"
import { getMentionPickHandler } from "@/lib/chat/mentions/pick-registry"
import { useMentionableSubagents } from "@/hooks/chat/use-mentionable-subagents"
import { useMarkdownChatAgents } from "@/hooks/chat/use-markdown-chat-agents"
import { useMentionableSkills } from "@/hooks/chat/use-mentionable-skills"
import { useMentionablePresets } from "@/hooks/chat/use-mentionable-presets"
import { usePluginSlashCommands } from "@/hooks/chat/use-plugin-slash-commands"
import { useApplyPreset } from "@/hooks/chat/use-apply-preset"
import { useEffectiveCwd } from "@/hooks/chat/use-effective-cwd"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import { ContextChipBar } from "./composer/context-chip-bar"
import { CommandQueueBar } from "./composer/command-queue-bar"
import { CommandHintBar } from "./composer/command-hint-bar"
import { ComposerCheatsheet } from "./composer/composer-cheatsheet"
import { ComposerAttachMenu } from "./composer/attach-menu"
import { nextPermissionMode } from "./permission-mode-indicator"
import { useResolvedConnectorMode } from "./use-resolved-connector-mode"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { showMainWindow } from "@/lib/tauri/pet-window"
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
import {
  DIAGNOSTICS_PART_TYPE,
  type SystemMessageBlock,
  type SlashCommandResultBlock,
} from "@/lib/slash-commands/system-blocks"
import { parseSegments, splitMentionSegments } from "@/lib/slash-commands/parse-segments"
import { pillDeleteRange } from "./composer-pill-delete"
import { runSegments, type CommandError } from "@/lib/slash-commands/run-segments"
import {
  isMemoryTargetAvailable,
  memoryTargetKey,
  parseMemoryTargetKey,
  type ComposerMemoryTarget,
} from "@/lib/chat/memory-target"
import { useComposerCommandStore } from "@/stores/chat/composer-command-store"
import { ComposerChipOverlay, TEXTAREA_TYPOGRAPHY } from "./composer-chip-overlay"
import { ComposerGhostText } from "./composer/composer-ghost-text"
import { MobileGhostAccept } from "./composer/mobile-ghost-accept"
import { useComposerGhostText } from "@/hooks/chat/use-composer-ghost-text"
import { useInputHistory } from "./composer/hooks/use-input-history"
import { CommandParamForm } from "./composer/command-param-form"
import { executeShell, formatShellResult } from "@/lib/shell/exec"
import { runInTerminalDock } from "@/lib/terminal/run-in-dock"
import { detectInteractiveCommand } from "@/lib/claude/permissions/interactive-command"
import { isTauri } from "@/lib/tauri"
import { appendMemory } from "@/lib/files/memory"
// `rememberFact` is imported lazily at its call site, not here: it pulls in the
// Dexie session schema and the redaction package, which every composer test
// otherwise has to mock just to render the box.
import { useUpdateSession } from "@/lib/data-hooks/context"
import { loggers } from "@cognia/logging"
import { impact, notify } from "@/lib/capacitor/haptics"
import { hideKeyboard } from "@/lib/capacitor/keyboard"
import { MentionPopover } from "@/components/mobile/chat/mention-popover"
import {
  ComposerPlusMenu,
  attachmentToFiles,
  type ComposerAttachment,
} from "@/components/mobile/chat/composer-plus-menu"
import {
  clearDraft as clearChatDraft,
  getDraft as getChatDraft,
  setDraftDebounced as setChatDraftDebounced,
  type DraftAttachmentMeta,
} from "@/lib/db/chat-drafts"
import { draftAttachmentsFromFiles } from "@/lib/chat/draft-attachments"
import { mergeComposerIntentPrompt } from "@/lib/chat/merge-composer-intent"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { DraftRestoredAttachments } from "./composer/draft-restored-attachments"
import { OcrResultBubble } from "./composer/ocr-result-bubble"
import { applyComposerOcr } from "./composer/ocr-attachment-action"
import { useOcr } from "@/hooks/use-ocr"
import { buildOcrDeps } from "@/lib/ocr/deps"
import type { OcrResult } from "@/types/ocr"
import { AnimatePresence, motion } from "motion/react"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { BottomToolbar } from "./composer/bottom-toolbar"
import { Collapse } from "./composer/collapse"
import { SkillChipRow } from "./composer/skill-chip-row"
import { GoalStatusPill } from "@/components/goal/goal-status-pill"
import { PlanModeBanner } from "@/components/chat/plan-mode-banner"
import { LoopStatusPill } from "@/components/loop/loop-status-pill"
import { CharCounter } from "./composer/char-counter"
import { DragOverlay } from "./composer/drag-overlay"
import { HelperHints } from "./composer/helper-hints"
import { VoiceControls } from "./composer/voice-controls"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { InboxComposerActionsHost } from "@/components/inbox/inbox-composer-actions-host"
import { CannedResponsePicker } from "@/components/inbox/canned-response-picker"
import { EnhanceButton } from "./composer/enhance-button"
import { WebSearchToggle } from "./composer/web-search-toggle"
import { SkillPicker } from "./skill-picker"

interface Props {
  session?: ChatSession | null
  /**
   * Status of the pane that owns this composer. Multi-pane chat passes this
   * explicitly so a background stream does not inherit the focused pane's
   * Send/Stop state.
   */
  status?: StoreChatStatus
  onStartNewSession: () => void | Promise<void>
  onOpenSettings: (tab: SettingsTab) => void
  /**
   * Dispatch the turn. `manifest` describes the leading attachment blocks so the
   * transcript can render file cards instead of raw extracted text.
   */
  onSend: (
    content: SendContent,
    manifest?: readonly AttachmentManifestEntry[]
  ) => void | Promise<void>
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
  /**
   * Workflow-editor copilot integration. When set, `@` (and `@node:` /
   * `@edge:`) open a picker over the workflow's graph elements; picking one
   * stages a reference chip. Its presence also flips `@` mode to `"workflow"`.
   * Undefined for every non-workflow composer.
   */
  workflowMention?: ComposerWorkflowMention
}

/** Copilot ⇄ workflow-editor wiring passed down from the workflow chat tab. */
export interface ComposerWorkflowMention {
  /** The workflow's `@`-mentionable nodes + edges (from the editor store). */
  elements: readonly MentionableWorkflowElement[]
  /**
   * Transiently highlight these node ids on the canvas — driven by the picker's
   * active row. Called with `[]` when the highlight clears.
   */
  onHighlight?: (ids: string[]) => void
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

const MAX_FILES = 6
const MAX_FILE_SIZE = 10 * 1024 * 1024
// Max composer textarea height before it scrolls. Single source of truth so the
// CSS cap (`maxHeight`) and the JS auto-resize fallback can't drift apart. The
// px form assumes the app's default 16px root (the JS path only runs on old
// WebViews lacking `field-sizing`).
const COMPOSER_MAX_HEIGHT_REM = 12
const COMPOSER_MAX_HEIGHT_PX = COMPOSER_MAX_HEIGHT_REM * 16

// --- Helpers ---------------------------------------------------------------

// Accept images plus every text/binary document type lib/document can extract
// (pdf, docx, xlsx, pptx, csv, md, code, …). A folder picked from the attach
// menu takes the @-mention reference path instead (absolute path, read on
// demand); only a *dropped* folder is flattened into this attachment input,
// since a drop carries no absolute path.
const ATTACHMENT_ACCEPT = ["image/*", ...getDocumentAcceptExtensions("chat")].join(",")

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
  /**
   * Submit a turn. Resolves `true` when the turn was handled (the input should
   * be cleared) and `false` when the user cancelled (e.g. declined the oversize
   * confirmation) so the composer keeps the draft + attachments intact.
   *
   * `precomputed` carries the staging-time extraction results (see
   * `staged-attachment-store`). It is threaded through the callback rather than
   * read from a hook because `handleSubmit` lives OUTSIDE `PromptInputProvider`
   * and so cannot reach the store.
   */
  onSubmit: (
    text: string,
    files: SubmittedFile[],
    precomputed?: ReadonlyMap<string, ExtractedAttachment>
  ) => boolean | Promise<boolean>
  onStop: () => void | Promise<void>
  onCommand: (cmd: SlashCommand, args: string) => Promise<boolean>
  onSubmitMemory: (target: ComposerMemoryTarget, text: string) => Promise<boolean>
  /**
   * Run a `!shell` line. Lives here (rather than being inferred from the
   * outgoing text in the outer `handleSubmit`) so the `!` mode is decided from
   * the ORIGINAL input: `/clear\n!ls` must not run a shell command just because
   * stripping the command left `!ls` as the outgoing prose.
   */
  onSubmitShell: (command: string) => Promise<boolean>
  /** Open the shortcut cheatsheet (bound to `?` on an empty input). */
  onOpenCheatsheet: () => void
  handleRef?: Ref<ComposerHandle>
  /** Non-zero when the session has pending connector drafts to review. */
  pendingDraftCount?: number
  mentionMode?: MentionMode
  mentionables?: readonly MentionTarget[]
  placeholder?: string
  mobileMentionMembers?: readonly Character[]
  workflowMention?: ComposerWorkflowMention
  /** Compact mode embeds the model and agent controls into the input surface. */
  compactLayout?: boolean
  toolbar?: ReactNode
}

function ComposerInner(props: InnerProps) {
  const t = useTranslations("chat.composer")
  const tAttach = useTranslations("chat.composer.attachments")
  const tCommands = useTranslations("chat.composer.commands")
  const tMemory = useTranslations("chat.composer.memory")
  const tSkill = useTranslations("chat.composer.skills")
  const platform = usePlatform()
  const isDesktop = platform === "tauri"
  // Capacitor native shell. Mobile gets a Claude-style vertical layout
  // (textarea on top, a single bottom action row) regardless of container
  // width; web/desktop keep the container-query responsive layout below.
  const isMobile = platform === "mobile"
  const hasPendingDrafts = (props.pendingDraftCount ?? 0) > 0
  // Non-LLM composer behavior toggles (AppSettings.composerBehavior). Each
  // defaults ON via `!== false` so an absent block preserves prior behavior.
  const composerBehavior = useSettingsStore((s) => s.settings?.composerBehavior)
  const compactLayout = props.compactLayout === true
  const sendOnEnter = composerBehavior?.sendOnEnter !== false
  const clearAfterSendEnabled = composerBehavior?.clearAfterSend !== false
  const inputHistoryRecall = composerBehavior?.inputHistoryRecall !== false
  const persistDrafts = composerBehavior?.persistDrafts !== false
  const controller = usePromptInputController()
  const attachments = usePromptInputAttachments()
  // Extraction results / chip order / OCR opt-in for the staged attachments.
  const staged = useStagedAttachments()
  const ocr = useOcr(() => buildOcrDeps())
  const [ocrBubbleOpen, setOcrBubbleOpen] = useState(false)
  const [ocrBubbleResult, setOcrBubbleResult] = useState<OcrResult | null>(null)
  const [ocrBubbleImageSrc, setOcrBubbleImageSrc] = useState<string | null>(null)
  const capabilityMenu =
    props.session?.kind === "workflow-editor" ? null : (
      <ComposerCapabilityMenu
        session={props.session}
        status={props.status}
        disabled={props.disabled}
      />
    )

  // Composer attachment OCR. It used to live on a hover menu on the chip and
  // append text straight into the draft — which silently doubled the payload,
  // because the image itself stayed attached and both went to the model. OCR is
  // now one layer of the attachment preview panel's "model view": the text is
  // stored ON the staged attachment with an explicit opt-in, so the token badge
  // reflects the real cost before the user commits to it.
  const runComposerOcr = useCallback(
    async (attachmentId: string, action: "extract-to-input" | "view-result") => {
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
          // Panel gets the flat text (that is what would be sent); the per-page
          // result stays available behind the panel's "details" action so the
          // richer Live-Text sheet doesn't become unreachable.
          staged.setOcrText(attachmentId, result.combinedText)
          setOcrBubbleResult(result)
          setOcrBubbleImageSrc(
            (file.mediaType ?? "").startsWith("image/") ? (file.url ?? null) : null
          )
        },
      })
    },
    [attachments, ocr, controller.textInput, staged]
  )
  const handleRunOcrForPanel = useCallback(
    (attachmentId: string) => runComposerOcr(attachmentId, "view-result"),
    [runComposerOcr]
  )
  /** Second OCR route, kept from the old chip menu: text straight into the draft. */
  const handleExtractOcrToInput = useCallback(
    (attachmentId: string) => runComposerOcr(attachmentId, "extract-to-input"),
    [runComposerOcr]
  )
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachmentPrepareCountRef = useRef(0)
  const [attachmentPrepareCount, setAttachmentPrepareCount] = useState(0)
  const isPreparingAttachments = attachmentPrepareCount > 0
  // Tracked separately from the batch count above because only images get a
  // placeholder chip: their decode/downscale is the slow path, and the chip's
  // scan animation would misdescribe a document.
  const [preparingImageCount, setPreparingImageCount] = useState(0)
  const attachmentFileCountRef = useRef(attachments.files.length)
  useEffect(() => {
    attachmentFileCountRef.current = attachments.files.length
  }, [attachments.files])

  const [smartSnapshotPending, setSmartSnapshotPending] = useState(false)
  const captureSmartSnapshot = useCallback(
    async (options: { delayMs?: number; switchPrompt?: boolean } = {}) => {
      if (!isDesktop || smartSnapshotPending) return
      setSmartSnapshotPending(true)
      try {
        if (options.switchPrompt) {
          toast.message(t("smartSnapshot.switchPrompt"))
        }
        const delayMs = Math.max(0, options.delayMs ?? 0)
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
        const result = await captureSmartSnapshotFiles()
        attachments.add(result.files)
        toast.success(t("smartSnapshot.captured", { appName: result.appName }))
        // A global shortcut runs while another application is focused. Capture
        // first, then raise Cognia so the staged attachments are visible.
        void showMainWindow()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("smartSnapshot.captureFailed"))
      } finally {
        setSmartSnapshotPending(false)
      }
    },
    [attachments, isDesktop, smartSnapshotPending, t]
  )

  useEffect(() => {
    if (!isDesktop) return
    return registerCommand({
      id: SMART_SNAPSHOT_COMMAND_ID,
      title: t("smartSnapshot.captureTooltip"),
      category: "Chat",
      pluginId: null,
      handler: () => captureSmartSnapshot(),
    })
  }, [captureSmartSnapshot, isDesktop, t])
  // Send protection: the chat store only flips to "streaming" once the dispatch
  // pipeline reaches `setSessionStatus`, leaving a window after the click where
  // the button would still read as "send". `isSending` is set synchronously the
  // instant a turn is dispatched so the button shows the running state
  // immediately and a second submit (a fast Enter / double-click) is rejected.
  // The ref is the synchronous re-entrancy guard; the state drives the render.
  const [isSending, setIsSending] = useState(false)
  const isSendingRef = useRef(false)
  const chipOverlayRef = useRef<HTMLDivElement>(null)
  const ghostOverlayRef = useRef<HTMLDivElement>(null)
  const ghost = useComposerGhostText(props.session)
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)
  // Measured composer height — feeds the mobile @-mention popover so it floats
  // exactly above the composer instead of a hardcoded guess (which broke once
  // the composer grew with attachments / goal·loop pills / multi-line drafts).
  const composerHeight = useElementHeight(containerEl)
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
  // Restored draft attachments whose binary did NOT survive (evicted by the
  // draft quota, or saved before binaries were persisted at all). Declared here
  // so `handleSend`'s clear path can reset it. Everything else is re-staged as
  // a real attachment; these are the leftovers that surface as "re-attach"
  // reminder chips above the input.
  const [restoredAttachments, setRestoredAttachments] = useState<DraftAttachmentMeta[]>([])
  const [dragDepth, setDragDepth] = useState(0)
  // Oversized text pastes are folded into a `[Pasted N lines #id]` placeholder
  // (mirrors the CLI's paste-collapse): the full body is held aside, keyed by
  // its placeholder, and re-expanded at send time. Removable chips above the
  // textarea show what was folded. `pasteSeq` keeps ids stable + unique.
  const [pastedBlocks, setPastedBlocks] = useState<Record<string, string>>({})
  const pasteSeq = useRef(0)
  const isDragging = dragDepth > 0
  // Per-command failures from the last multi-command submit. Surfaced as
  // failed-state pills on the command queue bar; cleared when the user edits.
  const [commandErrors, setCommandErrors] = useState<CommandError[]>([])

  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const permissionMode = useChatStore((s) => s.permissionMode)
  const addReferencedPath = useChatStore((s) => s.addReferencedPath)
  const updateSession = useUpdateSession()
  // Effective cwd (session override → workspace root → character → default) —
  // NOT the raw session.workingDir, so `@` file refs, custom slash commands
  // and the footer chip agree with what a send actually runs in.
  const cwd = useEffectiveCwd(props.session)
  const sessionId = props.session?.id ?? null

  // `@` mode resolution. Callers may set `mentionMode` explicitly (team chat →
  // "agents", etc.). Otherwise a DIRECT chat defaults to the combined panel
  // (subagents + files), so every general-chat composer gets `@agent` without
  // each call site opting in; non-direct composers keep the file picker.
  const resolvedMentionMode: MentionMode =
    props.mentionMode ??
    (props.workflowMention ? "workflow" : props.session?.kind === "direct" ? "combined" : "files")
  const isCombinedMention = resolvedMentionMode === "combined"
  // Reactive subagent list for the combined panel (no-op cost otherwise). The
  // built-in/plugin/template subagents union with on-disk markdown agents
  // (`.cognia/agents/*.md`) so both surface in the `@` "Agents" section.
  const mentionableSubagents = useMentionableSubagents()
  const markdownAgents = useMarkdownChatAgents(cwd, isCombinedMention)
  const chatAgents = useMemo(() => {
    if (!isCombinedMention) return undefined
    if (markdownAgents.length === 0) return mentionableSubagents
    // Dedupe by id; the reactive (built-in/plugin/template) list wins so a
    // markdown file can't shadow a registered subagent's display metadata.
    const seen = new Set(mentionableSubagents.map((t) => t.id))
    return [...mentionableSubagents, ...markdownAgents.filter((t) => !seen.has(t.id))]
  }, [isCombinedMention, mentionableSubagents, markdownAgents])
  // `@skill:` / `@preset:` namespaced mention sources (general chat only).
  const chatSkills = useMentionableSkills(isCombinedMention)
  const chatPresets = useMentionablePresets(isCombinedMention)
  const applyPreset = useApplyPreset()

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

  // Plugin-contributed slash commands (registered in the unified registry but
  // historically never surfaced in the chat `/` picker). Reactive: a plugin
  // enabling/disabling adds/removes its commands live.
  const pluginCommands = usePluginSlashCommands()

  const slashCommands = useMemo(
    () =>
      [...BUILTIN_SLASH_COMMANDS, ...customCommands, ...pluginCommands].filter(
        (c) => !c.hiddenFromPicker
      ),
    [customCommands, pluginCommands]
  )

  // Name → command map for submit-time multi-command dispatch. Built from the
  // UNFILTERED list (includes `hiddenFromPicker` commands) so a typed command
  // still resolves even when it's not shown in the picker.
  const commandMap = useMemo(
    () =>
      new Map(
        [...BUILTIN_SLASH_COMMANDS, ...customCommands, ...pluginCommands].map((c) => [c.name, c])
      ),
    [customCommands, pluginCommands]
  )

  // Segment the live input for the submit-time command pipeline (`runSegments`)
  // and the `hasCommand` check. NO mentions here — `runSegments` expects the
  // plain command/text view.
  const segments = useMemo(
    () => parseSegments(controller.textInput.value, (name) => commandMap.has(name)),
    [controller.textInput.value, commandMap]
  )

  // The chip overlay's view: derive `@mention` pills from the already-parsed
  // `segments` (commands pass through, only text is sub-split) so we don't run a
  // second full tokenizer pass over the input on every keystroke.
  const overlaySegments = useMemo(() => splitMentionSegments(segments), [segments])

  // Recent / pinned slash commands for the popover's empty-query view.
  const recentCommands = useComposerCommandStore((s) => s.recentCommands)
  const pinnedCommands = useComposerCommandStore((s) => s.pinnedCommands)
  const noteCommandUsed = useComposerCommandStore((s) => s.noteCommandUsed)
  const togglePinnedCommand = useComposerCommandStore((s) => s.togglePin)

  // Shell-style ↑/↓ recall of previously sent messages for this session.
  const history = useInputHistory(sessionId)

  // Lets `detectTrigger` tell a chained command (`/compact /cl`) from a path
  // argument (`/add-dir /usr/loc`): only a token that could still become a real
  // command name takes the popover anchor.
  const hasCommandPrefix = useCallback(
    (query: string) => slashCommands.some((c) => c.name.startsWith(query)),
    [slashCommands]
  )

  const trigger = useMemo<ComposerTrigger | null>(() => {
    const tg = detectTrigger(controller.textInput.value, caret, {
      mentionMode: resolvedMentionMode,
      hasCommandPrefix,
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
  }, [controller.textInput.value, caret, popoverDismissed, resolvedMentionMode, hasCommandPrefix])

  useEffect(() => {
    if (!popoverDismissed) return
    const tg = detectTrigger(controller.textInput.value, caret, {
      mentionMode: resolvedMentionMode,
      hasCommandPrefix,
    })
    if (!tg || tg.kind !== popoverDismissed.kind || tg.tokenStart !== popoverDismissed.tokenStart) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPopoverDismissed(null)
    }
  }, [controller.textInput.value, caret, popoverDismissed, resolvedMentionMode, hasCommandPrefix])

  // Drop one staged command from the input. Works on the absolute segment
  // range, then eats a single adjoining separator so removing the middle of
  // `/a /b /c` doesn't leave a double space (or a blank line for line-per-
  // command batches).
  const removeCommandSegment = useCallback(
    (start: number, end: number) => {
      const value = controller.textInput.value
      let cutEnd = end
      if (value[cutEnd] === " ") cutEnd += 1
      else if (value[cutEnd] === "\r" && value[cutEnd + 1] === "\n") cutEnd += 2
      else if (value[cutEnd] === "\n") cutEnd += 1
      const next = value.slice(0, start) + value.slice(cutEnd)
      controller.textInput.setInput(next)
      setCaret(start)
      setCommandErrors([])
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (ta) {
          ta.setSelectionRange(start, start)
          ta.focus()
        }
      })
    },
    [controller.textInput]
  )

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
      // Keep the caret STATE in step with the programmatic move (the DOM
      // selection is set in rAF below, but setSelectionRange does not fire a
      // `select` event, so trigger detection / ghost suppression would read a
      // stale caret without this).
      setCaret(result.caret)
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

  // Delete the active trigger token outright (no replacement, no trailing
  // space) — used by the `@skill:` / `@preset:` picks, which act on the
  // session config rather than inserting text.
  const removeTriggerToken = useCallback(() => {
    if (!trigger) return
    const cur = controller.textInput.value
    const before = cur.slice(0, trigger.tokenStart)
    const after = cur.slice(trigger.tokenEnd)
    const next = before + after
    controller.textInput.setInput(next)
    setCaret(before.length)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.setSelectionRange(before.length, before.length)
        ta.focus()
      }
    })
    dismissPopover()
  }, [trigger, controller.textInput, dismissPopover])

  // The picker's active row → a transient canvas highlight. Depend on the
  // (memoized) onHighlight fn, not the whole props object, so this callback
  // stays stable and the popover's highlight effect doesn't re-fire per render.
  const workflowOnHighlight = props.workflowMention?.onHighlight
  const handleHighlightElement = useCallback(
    (element: MentionableWorkflowElement | null) => {
      workflowOnHighlight?.(element ? [element.id] : [])
    },
    [workflowOnHighlight]
  )

  const onPickPopoverItem = useCallback(
    async (item: PopoverItem) => {
      if (!trigger) return
      if (item.kind === "slashArgument") {
        const currentValue = controller.textInput.value
        const result = spliceToken(currentValue, item.replaceStart, item.replaceEnd, item.value)
        controller.textInput.setInput(result.value)
        setCaret(result.caret)
        requestAnimationFrame(() => {
          const textarea = textareaRef.current
          if (textarea) {
            textarea.setSelectionRange(result.caret, result.caret)
            textarea.focus()
          }
        })
        dismissPopover()
      } else if (item.kind === "slash") {
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
        // Don't run the command on pick — drop it into the composer so the user
        // can review / append args and send it together with the rest of their
        // message. Both action handlers and templates are expanded on submit by
        // `runSegments` (see the submit handler), so the behavior is uniform:
        // pick → stays in the box → Enter sends.
        //
        // Replace the whole typed `/<query>` token with `/<name>`. `trigger.query`
        // is only the command-name fragment the user typed (the slash token ends
        // at the first whitespace), so it must NOT be re-appended as args — doing
        // so turned a fuzzy pick like "res" → /reset into "/reset res". Any real
        // args typed after a space live outside [tokenStart, tokenEnd) and are
        // preserved by spliceToken, which also adds the trailing space.
        insertReplacement(`/${cmd.name}`)
        noteCommandUsed(cmd.name)
      } else if (item.kind === "memory") {
        const text = trigger.query.trim()
        if (!text) {
          toast.error(tMemory("needsLine"))
          return
        }
        if (!isMemoryTargetAvailable(item.target, isDesktop)) {
          toast.error(tMemory("desktopOnly"))
          return
        }
        const ok = await props.onSubmitMemory(item.target, text)
        // Clear only the consumed FIRST line — the `#` mode never owned the
        // rest of the message, and wiping it here silently discarded any
        // commands or prose the user had typed on later lines.
        if (ok) {
          const value = controller.textInput.value
          const newline = value.indexOf("\n")
          const rest = newline === -1 ? "" : value.slice(newline + 1)
          controller.textInput.setInput(rest)
          setCaret(0)
        }
        dismissPopover()
      } else {
        // Mention-style picks (file / agent / subagent / skill / preset /
        // wfElement) dispatch through the registry — adding a new mentionable
        // kind is a `registerMentionPickHandler` call, not a composer edit.
        const handler = getMentionPickHandler(item.kind)
        if (handler) {
          await handler.onPick(item, {
            insertReplacement,
            removeTriggerToken,
            addReferencedPath,
            toggleEphemeralSkill: (skillId) =>
              useChatStore.getState().toggleEphemeralSkill(skillId),
            addReferencedWorkflowElement: (el) =>
              useChatStore.getState().addReferencedWorkflowElement(el),
            applyPreset: (preset, session) => applyPreset(preset, session).then(() => {}),
            session: props.session,
            clearWorkflowHighlight: () => props.workflowMention?.onHighlight?.([]),
            strings: {
              skillEnabled: (name) => tSkill("enabled", { name }),
            },
          })
        }
      }
    },
    [
      trigger,
      isDesktop,
      controller.textInput,
      addReferencedPath,
      insertReplacement,
      removeTriggerToken,
      applyPreset,
      props,
      dismissPopover,
      noteCommandUsed,
      tCommands,
      tMemory,
      tSkill,
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
        noteCommandUsed(current.command.name)
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
    [controller.textInput, noteCommandUsed]
  )

  const handleParamFormCancel = useCallback(() => {
    setParamForm(null)
    textareaRef.current?.focus()
  }, [])

  // --- Submit handler ----------------------------------------------------
  const submit = useCallback(async () => {
    const text = controller.textInput.value
    if (props.disabled) return
    if (attachmentPrepareCountRef.current > 0) return
    // Re-entrancy guard (send protection): reject a second dispatch while one is
    // already in flight — covers the window between the click and the store
    // flipping to "streaming", where a fast Enter could otherwise double-send.
    if (isSendingRef.current) return

    // Emptiness is decided from the synchronous attachment count (blob→data-url
    // conversion below preserves count) so the guard can be armed BEFORE the
    // first await, leaving no race for a concurrent submit to slip through.
    const empty = text.trim().length === 0 && attachments.files.length === 0
    if (empty) return

    isSendingRef.current = true
    setIsSending(true)

    // Tactile confirmation for the most frequent chat action. The wrapper
    // no-ops off the Capacitor shell, so this is safe unconditionally.
    if (isMobile) void impact("light")

    // Post-send focus policy: desktop refocuses the textarea for rapid
    // follow-ups; mobile blurs it and collapses the soft keyboard so the
    // streaming reply isn't hidden behind it (ChatGPT-app behavior).
    const settleFocusAfterSend = () => {
      if (isMobile) {
        textareaRef.current?.blur()
        void hideKeyboard()
      } else {
        textareaRef.current?.focus()
      }
    }

    // Snapshot the attachments BEFORE the optimistic clear so the actual send
    // still has them (and so a failed send can restore the composer). The chip
    // order is the user's (drag-reordered) order, and the model must receive
    // them in exactly that order — see `buildAttachmentBlocks`.
    const snapshotFiles = applyOrder([...attachments.files], staged.order)
    // `id` is RETAINED here (unlike before): it is the key `buildSendContent`
    // uses to look each file up in the staging-time extraction cache.
    const snapshotAttachmentInputs = snapshotFiles.map((item) => ({ ...item }))
    // Snapshot the folded-paste bodies too: the optimistic clear wipes them, so
    // the send (and a restore-on-failure) reads from this stable map.
    const pasteMap = pastedBlocks

    // ── Optimistic clear ───────────────────────────────────────────────────
    // Natural chat UX: the box empties the instant you hit send — not after the
    // whole turn resolves (`onSubmit` only settles once the send pipeline has
    // run, which is why the text used to linger for the entire response). We
    // snapshot first and restore on a rejected/failed send. `clearAfterSend`
    // off keeps everything in place (the user resends/tweaks), so skip then.
    let cleared = false
    const clearInputOptimistically = () => {
      if (!clearAfterSendEnabled || cleared) return
      // Optimistically clear ONLY the text + folded-paste chips. Attachments are
      // deliberately held back until the send is confirmed (`finalizeSend`):
      // `attachments.clear()` revokes every staged blob URL, so clearing here
      // would irrecoverably destroy the files on any rejected / cancelled /
      // thrown send (e.g. declining the oversize dialog).
      controller.textInput.clear()
      setPastedBlocks({})
      cleared = true
    }
    // Run only once a send is CONFIRMED successful: now it is safe to drop (and
    // revoke) the staged attachments, the reminder chips, and the saved draft.
    const finalizeSend = () => {
      if (clearAfterSendEnabled) {
        attachments.clear()
        setRestoredAttachments([])
        if (sessionId) void clearChatDraft(sessionId)
      }
      settleFocusAfterSend()
    }
    const restoreInputAfterFailure = () => {
      if (!cleared) return
      controller.textInput.setInput(text)
      setPastedBlocks(pasteMap)
      cleared = false
      // Attachments were never cleared, so there is nothing to restore — the
      // staged files are still live in the controller.
    }
    clearInputOptimistically()

    try {
      // Let any in-flight staging extraction land first, so the send reuses it
      // instead of re-parsing the same document. Resolves synchronously when
      // nothing is pending, which is the overwhelmingly common case.
      await staged.whenSettled()
      const precomputed = staged.precomputed
      const filesToSend: SubmittedFile[] = await Promise.all(
        snapshotAttachmentInputs.map(async (item) => {
          // A file whose extraction is cached never needs its bytes again —
          // skip the blob→data-URL round trip entirely.
          if (precomputed.has(item.id)) return item
          if (item.url?.startsWith("blob:")) {
            const dataUrl = await blobUrlToDataUrl(item.url)
            return { ...item, url: dataUrl ?? item.url }
          }
          return item
        })
      )

      // Record the exact typed text for ↑/↓ recall (before any command stripping).
      history.record(text)

      // ── `!shell` / `#memory` first-line modes ────────────────────────────
      // Decided from the ORIGINAL input, never from the post-command outgoing
      // text: `/clear\n!ls` must NOT shell out just because stripping `/clear`
      // left `!ls` behind. And the mode claims only its FIRST LINE — exactly
      // what `detectTrigger` and the popover have always previewed — so lines
      // 2+ continue through the normal command/prose pipeline below.
      const modeChar = text[0]
      let pipelineText = text
      let modeRan = false
      if (modeChar === "!" || modeChar === "#") {
        const newline = text.indexOf("\n")
        const modeLine = (newline === -1 ? text : text.slice(0, newline)).slice(1).trim()
        pipelineText = newline === -1 ? "" : text.slice(newline + 1)
        modeRan = true
        if (modeChar === "!") {
          await props.onSubmitShell(modeLine)
        } else if (!modeLine) {
          toast.error(tMemory("needsLine"))
        } else {
          // Bare `#note` + Enter repeats the last destination instead of
          // demanding a popover pick every single time. The availability guard
          // matters here as much as on the pick path: a target chosen on the
          // desktop shell can be replayed in the browser, where the CLAUDE.md
          // file scopes have no Tauri command behind them.
          const remembered = parseMemoryTargetKey(
            useComposerCommandStore.getState().lastMemoryTargetKey
          )
          if (!remembered) toast.info(tMemory("pickScope"))
          else if (!isMemoryTargetAvailable(remembered, isDesktop)) {
            toast.error(tMemory("desktopOnly"))
          } else await props.onSubmitMemory(remembered, modeLine)
        }
      }

      // Multi-command: `segments` is the live memo over the whole input; when a
      // first-line mode consumed line 1 we re-parse just the remainder so the
      // consumed line can't also be sent as prose. When the message contains one
      // or more line-start `/commands`, run them in order: action handlers
      // execute via `props.onCommand` (context-rich), template commands expand
      // inline, and the leftover prose is what gets sent.
      const pipelineSegments = modeRan
        ? parseSegments(pipelineText, (name) => commandMap.has(name))
        : segments
      const hasCommand = pipelineSegments.some((s) => s.kind === "command")
      if (hasCommand) {
        // Remember every runnable command sent (covers typed-not-picked ones).
        // Skip disabled/coming-soon commands so they can't pollute Recent — the
        // pick path already guards them before noteCommandUsed.
        for (const seg of pipelineSegments) {
          if (seg.kind === "command" && !commandMap.get(seg.name)?.disabled) {
            noteCommandUsed(seg.name)
          }
        }
        const { outgoingText, overrides, ranAction, errors } = await runSegments(pipelineSegments, {
          commandMap,
          runAction: async (command, args) => {
            await props.onCommand(command, args)
          },
          applyTemplate,
        })
        useChatStore.getState().setPendingCommandOverrides(overrides)
        // A failed command in a batch used to vanish: `runSegments` isolates the
        // throw into `errors` precisely so the rest of the batch still runs, but
        // nothing read the array. Report it once, aggregated — N toasts for a
        // three-command chain would be worse than one.
        setCommandErrors(errors)
        if (errors.length > 0) {
          toast.error(
            tCommands("batchFailed", {
              count: errors.length,
              names: errors.map((e) => `/${e.name}`).join(", "),
            })
          )
        }
        // Only send a turn when there is prose or attachments. An action-only
        // batch (e.g. `/clear`) mutates client state and sends nothing — mirroring
        // today's "action command clears the input, no turn" behavior.
        let sent = true
        if (outgoingText.length > 0 || filesToSend.length > 0) {
          sent = await props.onSubmit(
            expandPastes(outgoingText, pasteMap),
            filesToSend,
            precomputed
          )
        } else if (!ranAction && !modeRan) {
          // Defensive: no prose, no files, no action, no first-line mode —
          // nothing was dispatched, so restore the optimistically-cleared input
          // rather than lose it.
          restoreInputAfterFailure()
          return
        }
        if (sent) finalizeSend()
        else {
          restoreInputAfterFailure()
          if (isMobile) void notify("error")
        }
        return
      }

      // A first-line mode that consumed the entire input has already done its
      // work — don't also send an empty turn.
      if (modeRan && pipelineText.trim().length === 0 && filesToSend.length === 0) {
        finalizeSend()
        return
      }

      const sent = await props.onSubmit(
        expandPastes(pipelineText, pasteMap),
        filesToSend,
        precomputed
      )
      if (sent) finalizeSend()
      else {
        restoreInputAfterFailure()
        if (isMobile) void notify("error")
      }
    } catch (err) {
      // A thrown send must not leave the user's text lost — restore the
      // optimistically-cleared input and surface the failure (don't rethrow
      // into the fire-and-forget click handler).
      restoreInputAfterFailure()
      if (isMobile) void notify("error")
      loggers.chat.error("composer send failed", err)
    } finally {
      // Always release the guard. On a successful send the store has already
      // flipped to "streaming" (so the button stays in stop state); on a
      // rejected/aborted send it returns to the idle send state so the user can
      // retry.
      isSendingRef.current = false
      setIsSending(false)
    }
  }, [
    controller.textInput,
    tCommands,
    tMemory,
    isDesktop,
    attachments,
    staged,
    props,
    sessionId,
    commandMap,
    segments,
    history,
    clearAfterSendEnabled,
    pastedBlocks,
    noteCommandUsed,
    isMobile,
  ])

  // Accept the inline ghost-text suggestion: write the completed value back
  // into the textarea and park the caret at the end. Shared by the keyboard
  // (Tab) path below and the mobile tap affordance (`MobileGhostAccept`), since
  // touch devices have no Tab key. Returns false when there was nothing to
  // accept so the Tab keystroke can fall through to its default behavior.
  const acceptGhost = useCallback((): boolean => {
    const next = ghost.accept()
    if (next === null) return false
    controller.textInput.setInput(next)
    setCaret(next.length)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.setSelectionRange(next.length, next.length)
        ta.focus()
      }
    })
    return true
  }, [ghost, controller.textInput])

  // --- Textarea key handling --------------------------------------------
  // Local handles so the key handler depends on the specific props it reads,
  // not the whole `props` object (react-hooks/exhaustive-deps).
  const turnStatus = props.status
  const onStopTurn = props.onStop
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // `?` opens the shortcut cheatsheet — but ONLY on a completely empty
      // input, so it never swallows a question mark the user is typing.
      if (e.key === "?" && controller.textInput.value.length === 0) {
        e.preventDefault()
        props.onOpenCheatsheet()
        return
      }
      // Shift+Tab cycles permission mode regardless of popover state.
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault()
        const next = nextPermissionMode(permissionMode)
        setPermissionMode(next)
        return
      }
      // While an IME composition is active, Enter / Arrow / Tab / Escape belong
      // to the candidate window — let them fall through so picking a Chinese (or
      // Japanese, etc.) candidate doesn't accidentally confirm/navigate the
      // popover. `nativeEvent.isComposing` is authoritative for the keystroke
      // that ends composition; the state flag is a belt-and-suspenders backup.
      if (trigger && (isComposing || e.nativeEvent.isComposing)) {
        return
      }
      if (trigger) {
        if (e.key === "Escape") {
          e.preventDefault()
          dismissPopover()
          return
        }
        if (e.key === "ArrowDown") {
          e.preventDefault()
          popoverRef.current?.navigate(1)
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          popoverRef.current?.navigate(-1)
          return
        }
        // Tab selects the highlighted item. Bash mode has no list to confirm,
        // so Tab falls through there to default textarea behavior.
        if (e.key === "Tab" && !e.shiftKey && trigger.kind !== "bash") {
          e.preventDefault()
          popoverRef.current?.confirm()
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
      // Atomic pill delete: a Backspace/Delete next to an already-inserted
      // `/command` or `@mention` removes the WHOLE token in one keystroke, so a
      // picked chip deletes as a unit instead of nibbling `/rese`. Only when no
      // popover is open (mid-typing edits stay normal), not composing, plain key
      // (let ⌥/⌘ word/line deletes through), and the selection is collapsed.
      if (
        !trigger &&
        !isComposing &&
        !e.nativeEvent.isComposing &&
        (e.key === "Backspace" || e.key === "Delete") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const ta = e.currentTarget
        if (ta.selectionStart === ta.selectionEnd) {
          const range = pillDeleteRange(
            controller.textInput.value,
            ta.selectionStart,
            overlaySegments,
            e.key === "Backspace" ? "backward" : "forward"
          )
          if (range) {
            e.preventDefault()
            const cur = controller.textInput.value
            const next = cur.slice(0, range.start) + cur.slice(range.end)
            controller.textInput.setInput(next)
            setCaret(range.start)
            requestAnimationFrame(() => {
              const ta2 = textareaRef.current
              if (ta2) {
                ta2.setSelectionRange(range.start, range.start)
                ta2.focus()
              }
            })
            return
          }
        }
      }
      // Inline ghost-text acceptance (only when no `/@!#` popover is open).
      // Tab accepts the dim continuation; Esc dismisses it. Both fall through
      // to existing behavior when there is no ghost to act on.
      if (!trigger && ghost.ghost) {
        if (e.key === "Tab" && !e.shiftKey) {
          if (acceptGhost()) {
            e.preventDefault()
            return
          }
        }
        if (e.key === "Escape") {
          e.preventDefault()
          ghost.dismiss()
          return
        }
      }
      // Esc interrupts the running turn — the keystroke behind the run-status
      // bar's "Esc to interrupt" affordance — once no popover/ghost claimed it.
      if (e.key === "Escape" && turnStatus === "streaming") {
        e.preventDefault()
        void onStopTurn()
        return
      }
      // ↑/↓ recall of previously sent messages (only when no popover is open
      // and not composing). ↑ engages from the very start of the input; while
      // navigating, both arrows walk the history and ↓ past the newest restores
      // the stashed draft.
      if (inputHistoryRecall && (e.key === "ArrowUp" || e.key === "ArrowDown") && !isComposing) {
        const ta = e.currentTarget
        const caretAtStart = ta.selectionStart === 0 && ta.selectionEnd === 0
        const next = history.recall(e.key === "ArrowUp" ? "up" : "down", {
          value: controller.textInput.value,
          caretAtStart,
        })
        if (next !== null) {
          e.preventDefault()
          controller.textInput.setInput(next)
          setCaret(next.length)
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
      // Submit on Enter. Default: plain Enter sends, Shift+Enter is a newline.
      // When `sendOnEnter` is off: Enter inserts a newline and ⌘/Ctrl+Enter
      // sends instead (the non-submit cases fall through to the textarea).
      if (e.key === "Enter" && !e.nativeEvent.isComposing && !isComposing) {
        const wantsSubmit = sendOnEnter ? !e.shiftKey : e.metaKey || e.ctrlKey
        if (wantsSubmit) {
          e.preventDefault()
          void submit()
        }
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
      overlaySegments,
      ghost,
      acceptGhost,
      inputHistoryRecall,
      sendOnEnter,
      turnStatus,
      onStopTurn,
      props,
    ]
  )

  const onChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      controller.textInput.setInput(e.target.value)
      setCaret(e.target.selectionStart ?? e.target.value.length)
      // Re-mirror the scroll onto the chip + ghost overlays. Shrinking the text
      // (or clearing it) can reset the textarea's scrollTop WITHOUT firing a
      // scroll event, which would otherwise strand the overlays at a stale
      // translateY from the last scroll.
      const offset = `translateY(${-e.target.scrollTop}px)`
      if (chipOverlayRef.current) chipOverlayRef.current.style.transform = offset
      if (ghostOverlayRef.current) ghostOverlayRef.current.style.transform = offset
      // Typing exits history-recall mode so the next ↑ starts from the newest.
      history.noteEdit()
      // Last submit's per-command failures describe text the user has now
      // changed — drop them rather than leave stale red pills on the queue bar.
      setCommandErrors((current) => (current.length > 0 ? [] : current))
    },
    [controller.textInput, history]
  )

  const onSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    setCaret(ta.selectionStart ?? ta.value.length)
  }, [])

  // --- Paste / drag for attachments -------------------------------------
  const acceptFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = [...files]
      const imageCount = list.filter((f) => (f.type ?? "").startsWith("image/")).length
      attachmentPrepareCountRef.current += 1
      setAttachmentPrepareCount((count) => count + 1)
      if (imageCount > 0) setPreparingImageCount((count) => count + imageCount)
      try {
        const prepared = await prepareComposerAttachments(list, {
          maxFileSize: MAX_FILE_SIZE,
        })
        if (prepared.unsupportedCount > 0) {
          toast.warning(tAttach("unsupported", { count: prepared.unsupportedCount }))
        }
        if (prepared.tooLargeCount > 0) {
          toast.warning(
            tAttach("fileSizeExceeded", {
              count: prepared.tooLargeCount,
              max: MAX_FILE_SIZE / (1024 * 1024),
            })
          )
        }
        if (prepared.optimizedCount > 0) {
          toast.success(tAttach("optimized", { count: prepared.optimizedCount }))
        }
        // Preparation is async for oversized images. Track the latest staged
        // list in a ref so two concurrent pick/drop operations cannot both see
        // stale headroom and exceed MAX_FILES.
        const headroom = Math.max(0, MAX_FILES - attachmentFileCountRef.current)
        const take = prepared.files.slice(0, headroom)
        if (prepared.files.length > headroom) {
          toast.warning(tAttach("countLimit", { max: MAX_FILES }))
        }
        if (take.length > 0) {
          attachmentFileCountRef.current += take.length
          attachments.add(take)
        }
      } finally {
        attachmentPrepareCountRef.current = Math.max(0, attachmentPrepareCountRef.current - 1)
        setAttachmentPrepareCount((count) => Math.max(0, count - 1))
        if (imageCount > 0) setPreparingImageCount((count) => Math.max(0, count - imageCount))
      }
    },
    [attachments, tAttach]
  )

  // Mobile "+" menu → fold every pick (camera / album multi-pick / files)
  // into the same acceptFiles gate the paperclip input uses, so the size /
  // count / type limits and their toasts stay single-source.
  const onPlusAttach = useCallback(
    (attachment: ComposerAttachment) => {
      void attachmentToFiles(attachment)
        .then((files) => {
          if (files.length > 0) void acceptFiles(files)
        })
        .catch((err: unknown) => {
          loggers.chat.warn("plus-menu attach failed", {
            err: err instanceof Error ? err.message : String(err),
          })
          toast.error(err instanceof Error ? err.message : String(err))
        })
    },
    [acceptFiles]
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
        return
      }
      // Fold an oversized text paste into a `[Pasted N lines #id]` placeholder
      // rather than flooding the textarea. Small pastes fall through to the
      // browser's native insert. The full body is held in `pastedBlocks` and
      // re-expanded on send.
      const text = e.clipboardData?.getData("text") ?? ""
      if (!text) return
      const folded = collapsePaste(text, pasteSeq.current)
      if (!folded.isLarge) return
      e.preventDefault()
      pasteSeq.current += 1
      const ta = textareaRef.current
      const cur = controller.textInput.value
      const start = ta?.selectionStart ?? cur.length
      const end = ta?.selectionEnd ?? cur.length
      const result = spliceToken(cur, start, end, folded.display)
      controller.textInput.setInput(result.value)
      setCaret(result.caret)
      setPastedBlocks((prev) => ({ ...prev, [folded.display]: folded.stored }))
      requestAnimationFrame(() => {
        const ta2 = textareaRef.current
        if (ta2) {
          ta2.setSelectionRange(result.caret, result.caret)
          ta2.focus()
        }
      })
    },
    [acceptFiles, controller.textInput]
  )

  // Drop a folded paste: remove its placeholder from the text and forget the
  // stored body (chip "×" or editing the placeholder out by hand).
  const removePastedBlock = useCallback(
    (placeholder: string) => {
      setPastedBlocks((prev) => {
        if (!(placeholder in prev)) return prev
        const next = { ...prev }
        delete next[placeholder]
        return next
      })
      const cur = controller.textInput.value
      if (cur.includes(placeholder)) {
        controller.textInput.setInput(cur.split(placeholder).join(""))
      }
    },
    [controller.textInput]
  )

  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types?.includes("Files")) return
    setDragDepth((d) => d + 1)
  }, [])
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault()
  }, [])
  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Symmetric with onDragEnter: only file drags incremented the depth, so
    // only file drags may decrement it. An interleaved non-file dragleave would
    // otherwise prematurely drop the counter and flicker the overlay off.
    if (!e.dataTransfer?.types?.includes("Files")) return
    setDragDepth((d) => Math.max(0, d - 1))
  }, [])
  // Drops are resolved generically: plain files and whole directories arrive
  // through the same handler, and a dropped folder is flattened into its files
  // rather than staging one junk zero-byte attachment. (A dropped directory
  // carries no absolute path, so it cannot take the reference path the attach
  // menu's native folder picker uses — see lib/chat/drop-entries.ts.)
  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      setDragDepth(0)
      const dataTransfer = e.dataTransfer
      const hasPayload =
        (dataTransfer?.files?.length ?? 0) > 0 || (dataTransfer?.items?.length ?? 0) > 0
      if (!dataTransfer || !hasPayload) return
      e.preventDefault()
      void collectDroppedFiles(dataTransfer)
        .then((dropped) => {
          if (dropped.truncated) {
            toast.warning(tAttach("folderTruncated", { max: MAX_DROPPED_DIR_FILES }))
          }
          if (dropped.files.length > 0) return acceptFiles(dropped.files)
          if (dropped.directories > 0) toast.warning(tAttach("folderEmpty"))
        })
        .catch((err: unknown) => {
          loggers.chat.warn("drop resolution failed", {
            err: err instanceof Error ? err.message : String(err),
          })
        })
    },
    [acceptFiles, tAttach]
  )

  const onFilePick = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) void acceptFiles(e.target.files)
      e.target.value = ""
    },
    [acceptFiles]
  )

  const openFileDialog = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const removeLink = useCallback(
    (url: string) => {
      controller.textInput.setInput(removeHttpUrl(controller.textInput.value, url))
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [controller.textInput]
  )

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
  const pendingComposerIntent = useComposerIntentStore((state) =>
    sessionId ? state.pendingBySession[sessionId] : undefined
  )
  const consumeComposerIntent = useComposerIntentStore((state) => state.consume)
  // Text an auto-sending intent staged, held until the input state catches up.
  // A ref, not state: this is a one-shot latch between two effects, and a
  // `useState` write inside an effect body is a cascading render
  // (`react-hooks/set-state-in-effect`). See the handshake below.
  const pendingAutoSendRef = useRef<string | null>(null)
  // See `restoredAttachments` above: only the ones we could not bring back.
  const tDraft = useTranslations("chat.composer.draftRestore")
  // The next-intl translator isn't a stable reference, so we read it through a
  // ref instead of listing it as an effect dependency — depending on it would
  // re-run the hydration effect every render and loop on its setState calls.
  const tDraftRef = useRef(tDraft)
  useEffect(() => {
    tDraftRef.current = tDraft
  }, [tDraft])

  // Tracks the session we last reset the box for. A ref (not state) so it can't
  // race the async draft load below.
  const clearedForSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!persistDrafts) return
    if (!sessionId) return
    if (draftHydratedFor === sessionId) return
    // Reset the input SYNCHRONOUSLY, once per session change. The Composer is
    // not remounted per session (no `key`), so without this the previous
    // session's text + staged attachments bleed into this one and then get
    // persisted into its draft. The ref guard means a re-render during the
    // async load (e.g. the user typing in the gap) doesn't wipe their input a
    // second time.
    if (clearedForSessionRef.current !== sessionId) {
      clearedForSessionRef.current = sessionId
      controller.textInput.setInput("")
      attachments.clear()
      // Folded-paste bodies are in-memory only (not persisted); drop them too.
      setPastedBlocks({})
    }
    let cancelled = false
    getChatDraft(sessionId)
      .then((row) => {
        if (cancelled) return
        // Populate the saved draft only when the target actually has one — never
        // clobber text the user typed during this async gap with an empty draft.
        if (row?.text) {
          controller.textInput.setInput(row.text)
        }
        // Attachments whose binary survived are re-staged for real: the file
        // comes back, ready to send. Seed the store with its cached extraction
        // first so re-staging doesn't re-parse a document we already read.
        // Anything whose blob was evicted (quota) still degrades to a chip.
        const restored = row?.attachments ?? []
        const revivable = restored.filter((a) => a.bytes)
        if (revivable.length > 0) {
          staged.seedIncoming(
            revivable.map((a) => ({
              filename: a.name,
              sizeBytes: a.size,
              state: {
                status: "ready" as const,
                sizeBytes: a.size,
                bytes: a.bytes,
                ...(a.extractedText
                  ? {
                      extracted: {
                        kind: "document" as const,
                        block: { type: "text" as const, text: a.extractedText },
                        tokens: a.tokens ?? 0,
                        text: a.extractedText,
                      },
                    }
                  : {}),
              },
            }))
          )
          attachments.add(
            revivable.map((a) => new File([a.bytes as BlobPart], a.name, { type: a.mediaType }))
          )
        }
        // Reminder chips are now only for the ones we could NOT bring back.
        const reminders = restored.filter((a) => !a.bytes)
        setRestoredAttachments(reminders)
        if (reminders.length > 0) {
          toast.info(tDraftRef.current("toast", { count: reminders.length }))
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
  }, [persistDrafts, sessionId, draftHydratedFor, controller.textInput, attachments, staged])

  // A system-selection action arrives while the main window and target session
  // are being activated. Consume it only after the saved draft has finished
  // hydrating, otherwise the async draft read can overwrite the inserted stock
  // instruction. Ask has no stock prompt and only focuses the textarea.
  useEffect(() => {
    if (!sessionId || !pendingComposerIntent) return
    if (persistDrafts && draftHydratedFor !== sessionId) return
    const intent = consumeComposerIntent(sessionId, pendingComposerIntent.candidateId)
    if (!intent) return
    if (intent.prompt) {
      const merged = mergeComposerIntentPrompt(controller.textInput.value, intent.prompt)
      controller.textInput.setInput(merged)
      // Auto-send (tray quick panel) is armed here but fired by the effect
      // below, once the input state has actually flushed: `submit` closes over
      // `controller.textInput.value`, so calling it now would send the text
      // that was in the box BEFORE this line.
      if (intent.autoSend) pendingAutoSendRef.current = merged
    }
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [
    consumeComposerIntent,
    controller.textInput,
    draftHydratedFor,
    pendingComposerIntent,
    persistDrafts,
    sessionId,
  ])

  // Second half of the auto-send handshake: fire only once the committed input
  // matches the text we staged, so the send can never race the state write.
  useEffect(() => {
    const pending = pendingAutoSendRef.current
    if (pending === null) return
    if (controller.textInput.value !== pending) return
    pendingAutoSendRef.current = null
    void submit()
  }, [controller.textInput.value, submit])

  // Memoised on the file list + staged state so the persist effect below — which
  // also depends on the text value — doesn't rebuild these rows on every
  // keystroke. The blobs come from `staged`, which already holds the bytes it
  // fetched for extraction, so persisting a draft costs no extra reads.
  const draftAttachments = useMemo(
    () => draftAttachmentsFromFiles(attachments.files, staged.byId),
    [attachments.files, staged.byId]
  )
  useEffect(() => {
    if (!persistDrafts) return
    if (!sessionId) return
    if (draftHydratedFor !== sessionId) return
    try {
      setChatDraftDebounced(sessionId, controller.textInput.value, draftAttachments)
    } catch {
      // Dexie unavailable (e.g., SSR / tests without fake-indexeddb) — drafts are best-effort.
    }
  }, [controller.textInput.value, draftAttachments, sessionId, draftHydratedFor, persistDrafts])

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
    ta.style.height = `${Math.min(ta.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`
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
  // Cross-fade transition for the send/stop button icon swap (reduced-motion aware).
  const sendIconTransition = useReducedMotionTransition(mobileTransition("fast"))

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
      {/* Every band stacked above the textarea shares one scroll container with
          a height cap. Six attachments plus an active goal, an open loop and the
          plan-mode banner could otherwise push the input off the bottom of the
          screen. Each band still animates its own height inside it. */}
      <div className="max-h-[40vh] overflow-y-auto overscroll-contain">
        <CommandQueueBar
          segments={segments}
          errors={commandErrors}
          onRemove={removeCommandSegment}
        />
        <ContextChipBar
          onRunOcr={handleRunOcrForPanel}
          ocrBusy={ocr.status === "running"}
          onExtractOcrToInput={handleExtractOcrToInput}
          onViewOcrDetail={ocrBubbleResult ? () => setOcrBubbleOpen(true) : undefined}
          text={controller.textInput.value}
          onRemoveLink={removeLink}
          preparingImageCount={preparingImageCount}
        />
        <Collapse>
          <DraftRestoredAttachments
            items={restoredAttachments}
            onDismiss={() => setRestoredAttachments([])}
          />
        </Collapse>
        <OcrResultBubble
          open={ocrBubbleOpen}
          onOpenChange={setOcrBubbleOpen}
          result={ocrBubbleResult}
          imageSrc={ocrBubbleImageSrc ?? undefined}
          onCopy={(text) => void navigator.clipboard?.writeText(text)}
          onCopyPage={(_page, text) => void navigator.clipboard?.writeText(text)}
        />
        <PluginExtensionSlot point="chat.input.above" className="px-1 empty:hidden" />
        <Collapse>
          <SkillChipRow
            ids={ephemeralSkillIds}
            onRemove={toggleEphemeralSkill}
            disabledIds={props.session?.disabledSkillIds}
          />
        </Collapse>
        {/* Folded large-paste chips — only those whose placeholder is still in the
          text (manual deletion drops the chip too). */}
        <Collapse>
          {(() => {
            const chips = Object.entries(pastedBlocks).filter(([ph]) =>
              controller.textInput.value.includes(ph)
            )
            if (chips.length === 0) return null
            return (
              <div className="flex flex-wrap gap-1 px-1 pb-1" data-testid="composer-pasted-chips">
                {chips.map(([ph, body]) => (
                  <span
                    key={ph}
                    className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    <FileTextIcon className="size-3 shrink-0" aria-hidden />
                    {t("pastedChip", { count: body.split("\n").length })}
                    <button
                      type="button"
                      onClick={() => removePastedBlock(ph)}
                      aria-label={t("removePastedChip")}
                      className="text-muted-foreground/60 hover:text-foreground"
                    >
                      <XIcon className="size-3" aria-hidden />
                    </button>
                  </span>
                ))}
              </div>
            )
          })()}
        </Collapse>
        {/* Re-paste reminder: a restored draft can carry `[Pasted …]` placeholders
          whose bodies weren't persisted. Nudge the user to re-paste (the
          placeholder text stays visible so they see exactly where). */}
        <Collapse>
          {(() => {
            const orphans = findPastePlaceholders(controller.textInput.value).filter(
              (ph) => !(ph in pastedBlocks)
            )
            if (orphans.length === 0) return null
            return (
              <div
                className="px-1 pb-1 text-[11px] text-amber-600 dark:text-amber-500"
                data-testid="composer-paste-reminder"
              >
                {t("pasteReminder", { count: orphans.length })}
              </div>
            )
          })()}
        </Collapse>
        {/* ADR-0019 — active/paused goal status + controls; self-hides when none. */}
        <Collapse>
          <GoalStatusPill sessionId={sessionId} />
        </Collapse>
        {/* /loop status + controls; self-hides when no open loop. */}
        <Collapse>
          <LoopStatusPill sessionId={sessionId} />
        </Collapse>
        {/* Plan-mode state banner; self-hides outside plan mode. */}
        <Collapse>
          <PlanModeBanner />
        </Collapse>
      </div>
      <div
        className={cn(
          // Claude-style stack on every platform when the container is narrow:
          // the textarea fills the first row (w-full forces the wrap), the
          // attach + send clusters share ONE bottom row. On web/desktop the
          // children's @sm/composer:* classes reset order/width so the box
          // re-forms the single-row [attach | textarea | send] layout; the
          // flex-1 textarea (basis-0) then prevents any further wrapping.
          // Mobile (Capacitor) keeps the stack at every width.
          "relative flex flex-wrap items-end gap-2 rounded-2xl border border-input/60 bg-background/70 px-2 py-2 shadow-sm transition-[border-color,box-shadow,background-color] duration-200 motion-reduce:transition-none",
          "focus-within:border-primary/40 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/15",
          compactLayout &&
            "gap-1.5 rounded-[1.75rem] border-border/70 bg-background/85 px-3 py-2.5 shadow-md",
          // Plan mode: amber tint on the input surface (with the banner above)
          // so the read-only state is unmistakable (Claude Code parity).
          permissionMode === "plan" &&
            "border-amber-500/50 focus-within:border-amber-500/70 focus-within:ring-amber-500/15"
        )}
        // Opt the input surface into the shared wallpaper-aware tonality system
        // (app/globals.css §5): when a background is active the hardcoded
        // bg-background/70 is replaced by the token-driven translucent surface
        // + blur, so the composer adapts like every other surface and honours
        // prefers-reduced-transparency. Falls back to bg-background/70 when no
        // wallpaper is set.
        data-tonality="translucent"
        data-composer-layout={compactLayout ? "compact" : "default"}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <DragOverlay visible={isDragging} />

        <input
          accept={ATTACHMENT_ACCEPT}
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
            !isMobile && !compactLayout && "@sm/composer:order-none"
          )}
        >
          {isMobile ? (
            // Mobile: one WeChat-style "+" menu (camera / album multi-pick /
            // files) replaces the paperclip + camera button pair — fewer
            // 44px targets competing for composer width. Voice stays with
            // the transcription bridge below (speech → text), so the menu's
            // record-as-attachment branch is hidden. Desktop compact keeps the
            // paperclip: the "+" menu's camera/album branches both degrade to
            // the same file picker off-mobile, so three entries would be
            // redundant there.
            <ComposerPlusMenu
              showVoice={false}
              fileAccept={ATTACHMENT_ACCEPT}
              onAttach={onPlusAttach}
              onError={(_code, message) => toast.error(message)}
              capabilities={capabilityMenu}
            />
          ) : (
            // One paperclip for both attachment models: files inline, folders
            // as references. Links need no button — typed or pasted URLs are
            // recognised in the text and chipped by `ContextChipBar`.
            <ComposerAttachMenu
              disabled={props.disabled}
              onPickFiles={openFileDialog}
              onSmartSnapshot={() =>
                void captureSmartSnapshot({ delayMs: 2200, switchPrompt: true })
              }
              smartSnapshotPending={smartSnapshotPending}
              capabilities={capabilityMenu}
            />
          )}

          {/* Voice stays outside the menu: it's an input method (speech →
              text), not a way to produce an attachment. */}
          <VoiceTranscriptionBridge disabled={props.disabled} />
          <ComposerAppendBridge sessionId={props.session?.id} />
        </div>

        <div
          className={cn(
            "relative order-1 w-full min-w-0",
            !isMobile &&
              !compactLayout &&
              "@sm/composer:order-none @sm/composer:w-auto @sm/composer:flex-1 @sm/composer:self-center"
          )}
        >
          <ComposerChipOverlay
            ref={chipOverlayRef}
            value={controller.textInput.value}
            segments={overlaySegments}
          />
          <ComposerGhostText
            ref={ghostOverlayRef}
            value={controller.textInput.value}
            ghost={ghost.ghost}
            // The "Tab" hint is meaningless on touch — mobile gets the tappable
            // accept/dismiss control below instead.
            acceptHint={isMobile ? undefined : t("ghostAcceptHint")}
          />
          <Textarea
            aria-label={t("ariaMessage")}
            className={cn(
              "field-sizing-content relative z-[1] block min-h-9 w-full resize-none break-words overflow-y-auto overscroll-contain border-0 bg-transparent shadow-none outline-none ring-0 [scrollbar-width:none] placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 [&::-webkit-scrollbar]:hidden",
              compactLayout && "min-h-14 py-1.5",
              !compactLayout && controller.textInput.value.length === 0 && "h-9 overflow-hidden",
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
            style={{ maxHeight: `${COMPOSER_MAX_HEIGHT_REM}rem` }}
            value={controller.textInput.value}
          />
          <CharCounter />
          <MobileGhostAccept
            visible={isMobile && !!ghost.ghost}
            onAccept={acceptGhost}
            onDismiss={ghost.dismiss}
          />
        </div>

        {props.toolbar ? (
          <div className="order-2 min-w-0 flex-1 self-end">{props.toolbar}</div>
        ) : null}

        <div
          className={cn(
            "order-3 ms-auto flex shrink-0 items-center",
            !isMobile && !compactLayout && "@sm/composer:order-none @sm/composer:ms-0"
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
                  aria-label={
                    isStreaming
                      ? t("ariaStop")
                      : isSending
                        ? t("ariaSending")
                        : isPreparingAttachments
                          ? tAttach("preparing")
                          : t("ariaSend")
                  }
                  className={cn(
                    "size-9 rounded-full transition-transform duration-200 ease-out active:scale-90 disabled:scale-100",
                    // Mobile: 44px minimum tap target (primary send/stop action).
                    isMobile && "touch-target"
                  )}
                  disabled={
                    // In web mode, platform-bound sessions cannot send outbound messages.
                    (!isDesktop && !!props.session?.platformBinding) ||
                    // A turn is being dispatched: the button is a non-interactive
                    // spinner until the store flips to "streaming" (then it becomes
                    // the live Stop button).
                    isSending ||
                    isPreparingAttachments ||
                    (!isStreaming &&
                      (props.disabled ||
                        (controller.textInput.value.trim().length === 0 &&
                          attachments.files.length === 0)))
                  }
                  onClick={() => (isStreaming ? void props.onStop() : void submit())}
                  size="icon"
                  type="button"
                  variant={isStreaming ? "destructive" : "default"}
                >
                  {/* Icon swap genuinely cross-fades + zooms on each state
                      change (send → running → stop): AnimatePresence keeps the
                      outgoing icon mounted through its exit while the incoming
                      one fades in, keyed by state. Honors reduced motion. */}
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={
                        isStreaming
                          ? "stop"
                          : isSending || isPreparingAttachments || props.status === "submitted"
                            ? "sending"
                            : "send"
                      }
                      className="inline-flex"
                      initial={{ opacity: 0, scale: 0.75 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.75 }}
                      transition={sendIconTransition}
                    >
                      {isStreaming ? (
                        <SquareIcon className="size-4" />
                      ) : isSending || isPreparingAttachments || props.status === "submitted" ? (
                        <Loader2Icon className="size-4 animate-spin" />
                      ) : (
                        <ArrowUpIcon className="size-4" />
                      )}
                    </motion.span>
                  </AnimatePresence>
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

      <CommandHintBar
        trigger={desktopTrigger}
        commandMap={commandMap}
        value={controller.textInput.value}
      />

      <PluginExtensionSlot point="chat.input.below" className="px-1 pt-1 empty:hidden" />

      <ComposerPopover
        ref={popoverRef}
        trigger={desktopTrigger}
        cwd={cwd}
        slashCommands={slashCommands}
        anchor={containerEl}
        mentionables={props.mentionables}
        chatAgents={chatAgents}
        chatSkills={chatSkills}
        chatPresets={chatPresets}
        workflowElements={props.workflowMention?.elements}
        onHighlightElement={props.workflowMention ? handleHighlightElement : undefined}
        recentCommands={recentCommands}
        pinnedCommands={pinnedCommands}
        onTogglePin={togglePinnedCommand}
        onPick={onPickPopoverItem}
        onDismiss={dismissPopover}
      />

      {mobileMentionEnabled ? (
        <MentionPopover
          open={mobileMentionOpen}
          query={mobileMentionQuery}
          members={props.mobileMentionMembers ?? []}
          composerHeight={composerHeight}
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

/** Window-event name a chat-message card dispatches to append text to the composer. */
export const COMPOSER_APPEND_EVENT = "cognia:composer-append"

/** Detail of a {@link COMPOSER_APPEND_EVENT}. */
export interface ComposerAppendDetail {
  text?: string
  /**
   * Which composer should take the text. More than one composer is mounted at
   * once — split view has two, and a workbench sidechat adds another — so an
   * un-addressed event would land in all of them. Omit only when the intent
   * really is "whichever composer is focused"; `undefined` is treated as
   * addressed to the active session.
   */
  sessionId?: string
}

/** Append text to one composer's draft. See {@link ComposerAppendDetail}. */
export function dispatchComposerAppend(detail: ComposerAppendDetail): void {
  window.dispatchEvent(new CustomEvent(COMPOSER_APPEND_EVENT, { detail }))
}

/**
 * Lets components outside the PromptInput controller context (e.g. the OCR
 * result card in the message list, or a sidechat handing a conclusion back)
 * append text to the composer by dispatching `COMPOSER_APPEND_EVENT`.
 */
function ComposerAppendBridge({ sessionId }: { sessionId?: string }) {
  const controller = usePromptInputController()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  useEffect(() => {
    const onAppend = (e: Event) => {
      const detail = (e as CustomEvent<ComposerAppendDetail>).detail
      const text = detail?.text
      if (!text || !text.trim()) return
      // Addressed events go to exactly one composer. An un-addressed event is
      // legacy shorthand for "the active session", which keeps the single-pane
      // callers working without making every composer echo it.
      const target = detail?.sessionId ?? activeSessionId
      if (target && sessionId && target !== sessionId) return
      const cur = controller.textInput.value
      const sep = cur && !cur.endsWith(" ") ? " " : ""
      controller.textInput.setInput(`${cur}${sep}${text}`)
    }
    window.addEventListener(COMPOSER_APPEND_EVENT, onAppend)
    return () => window.removeEventListener(COMPOSER_APPEND_EVENT, onAppend)
  }, [controller.textInput, activeSessionId, sessionId])
  return null
}

function ComposerCapabilityMenu({
  session,
  status,
  disabled,
}: {
  session?: ChatSession | null
  status: PromptStatus
  disabled?: boolean
}) {
  const controller = usePromptInputController()
  const ephemeralSkillIds = useChatStore((s) => s.ephemeralSkillIds) ?? []
  const setEphemeralSkillIds = useChatStore((s) => s.setEphemeralSkillIds) ?? (() => {})
  const enhanceEnabled = useSettingsStore(
    (s) => s.settings?.composerAssistance?.enhance?.enabled !== false
  )
  const tSkill = useTranslations("skills.composer.skillPicker")
  const [pickerOpen, setPickerOpen] = useState(false)
  const isMobile = usePlatform() === "mobile"
  const isStreaming = status === "streaming"
  const controlsDisabled = disabled || isStreaming

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" data-testid="composer-capability-menu">
        {enhanceEnabled ? (
          <EnhanceButton
            value={controller.textInput.value}
            onApply={(next) => controller.textInput.setInput(next)}
            session={session}
            disabled={controlsDisabled}
          />
        ) : null}
        <WebSearchToggle disabled={controlsDisabled} />
        <Button
          type="button"
          size="icon"
          variant={ephemeralSkillIds.length > 0 ? "default" : "ghost"}
          onClick={() => setPickerOpen(true)}
          aria-label={tSkill("trigger")}
          disabled={controlsDisabled}
          className={cn("size-7", isMobile && "touch-target")}
          data-testid="composer-skill-trigger"
        >
          <SparklesIcon className="size-3.5" />
        </Button>
      </div>
      <SkillPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        value={ephemeralSkillIds}
        onChange={setEphemeralSkillIds}
      />
    </>
  )
}

// --- Outer component ------------------------------------------------------

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    session,
    status: paneStatus,
    onStartNewSession,
    onOpenSettings,
    onSend,
    onStop,
    disabled,
    mentionMode,
    mentionables,
    placeholder,
    mobileMentionMembers,
    workflowMention,
  },
  ref
) {
  const tCommands = useTranslations("chat.composer.commands")
  const tShell = useTranslations("chat.composer.shell")
  const tMemory = useTranslations("chat.composer.memory")
  const tAttach = useTranslations("chat.composer.attachments")
  const tWebSearch = useTranslations("webSearchToggle")
  const tDraftReview = useTranslations("chat.composer.draftReview")
  const compactLayout = useSettingsStore(
    (s) => s.settings?.composerBehavior?.compactLayout === true
  )
  const focusedStatus = useChatStore((s) => s.status)
  const status = paneStatus ?? focusedStatus
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const appendMessage = useChatStore((s) => s.appendMessage)
  const clearReferencedPaths = useChatStore((s) => s.clearReferencedPaths)
  const clearContextSelections = useChatStore((s) => s.clearContextSelections)

  // Same effective-cwd chain the send path uses — a selected workspace must
  // let `!` shell commands and memory appends run without a per-session dir.
  const cwd = useEffectiveCwd(session)

  // ── Platform connector mode ─────────────────────────────────────────────
  const resolvedMode = useResolvedConnectorMode(session)
  const [pendingDrafts, setPendingDrafts] = useState<ConnectorDraftRow[]>([])
  const [draftDialogOpen, setDraftDialogOpen] = useState(false)
  // Oversize attachment confirmation: handleSubmit parks a resolver here while
  // the dialog below collects the user's choice (send anyway / cancel).
  const [oversizeConfirm, setOversizeConfirm] = useState<{
    tokens: number
    resolve: (ok: boolean) => void
  } | null>(null)
  // Shortcut cheatsheet. Owned here (not in `ComposerInner`) because the
  // onboarding chip row that links to it lives at this level, while the `?`
  // shortcut that opens it lives in the inner key handler.
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false)

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
    (payload: string | SystemMessageBlock | SlashCommandResultBlock) => {
      // Strings render as markdown text; any structured block (diagnostics card
      // or slash-result chip) rides the same data part and is dispatched by the
      // message renderer on its `kind`.
      const parts =
        typeof payload === "string"
          ? [{ type: "text", text: payload }]
          : [{ type: DIAGNOSTICS_PART_TYPE, data: payload }]
      appendMessage({
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "system",
        parts: parts as UIMessage["parts"],
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
      // An interactive command (ssh, a REPL, a login flow, `git rebase -i`, …)
      // needs a TTY the capture path lacks — it would hang or read EOF. Route it
      // to the real integrated terminal instead (desktop only; on web the
      // capture path below already surfaces the desktop-only error).
      if (isTauri() && detectInteractiveCommand(cmd).interactive) {
        try {
          await runInTerminalDock(cmd, cwd, session?.id ?? "")
          pushSystemMessage(tShell("interactiveRoutedToTerminal", { cmd }))
        } catch (err) {
          loggers.chat.error("interactive shell routing failed", err, { cmd, cwd })
          pushSystemMessage(
            tShell("failed", {
              cmd,
              error: err instanceof Error ? err.message : String(err),
            })
          )
        }
        return true
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
    [cwd, pushSystemMessage, tShell, session]
  )

  const handleMemorySubmit = useCallback(
    async (target: ComposerMemoryTarget, text: string): Promise<boolean> => {
      const noteUsed = () =>
        useComposerCommandStore.getState().noteMemoryTargetUsed(memoryTargetKey(target))
      if (target.target === "store") {
        // ADR-0069 long-term memory — the SAME write path `/remember` uses, so
        // the PII gate and the consolidator can't be bypassed here.
        const { rememberFact } = await import("@/lib/memory/write/remember-fact")
        const result = await rememberFact({
          text,
          scope: target.scope,
          sessionId: session?.id ?? null,
        })
        if (result.ok) {
          noteUsed()
          toast.success(tMemory("storedInMemory", { scope: tMemory(`scope.${target.scope}`) }))
          return true
        }
        loggers.chat.warn("memory store write refused", { reason: result.reason })
        toast.error(tMemory(`storeError.${result.reason}`))
        return false
      }
      try {
        // Project memory is written at <cwd>/CLAUDE.md — confine the write to
        // the working dir so a stray cwd can't escape it. User scope ignores it.
        const path = await appendMemory(target.scope, text, cwd, cwd ? [cwd] : null)
        noteUsed()
        toast.success(tMemory("appended", { path }))
        return true
      } catch (err) {
        loggers.chat.error("memory append failed", err, { scope: target.scope, cwd })
        toast.error(err instanceof Error ? err.message : tMemory("failed"))
        return false
      }
    },
    [cwd, tMemory, session]
  )

  const handleSubmit = useCallback(
    async (
      text: string,
      files: SubmittedFile[],
      precomputed?: ReadonlyMap<string, ExtractedAttachment>
    ) => {
      const trimmed = text.trim()
      // NOTE: `!shell` / `#memory` are NOT detected here any more. They are
      // first-line modes decided from the ORIGINAL input inside `ComposerInner`
      // (see `onSubmitShell` / `onSubmitMemory`); sniffing the prefix off this
      // post-command text meant `/clear\n!ls` executed a shell command.

      // ── Platform connector short-circuit ─────────────────────────────────
      // When a session is platform-bound, branch on the resolved mode before
      // the standard sendPrompt path.
      if (session?.platformBinding && resolvedMode && resolvedMode !== "auto") {
        const { adapterId, conversationKey, conversationRef } = session.platformBinding
        if (resolvedMode === "manual") {
          if (!trimmed && files.length === 0) return true
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
          return true // skip standard sendPrompt — caller's input cleared by ComposerInner
        }
        if (resolvedMode === "draft") {
          // In draft mode, the submit button opens the draft reviewer dialog
          const drafts = await listPendingDrafts(conversationKey)
          setPendingDrafts(drafts)
          setDraftDialogOpen(true)
          return true
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
            maxRetries: settings?.searchMaxRetries,
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

      // ── Context selections ──────────────────────────────────────────
      // Prepend the selected material + comment as context, and record the
      // edit target so the assistant reply routes into a per-hunk review
      // proposal against the targeted artifact. The first selection wins; the
      // rest contribute context only. That is now stated in the UI — the lead
      // chip carries an "edit target" badge and the others promote on click
      // (`artifact-selection-chips.tsx`) — where it used to be a `debug` log
      // nobody would ever see.
      const contextSelections = useChatStore.getState().contextSelections
      if (contextSelections.length > 0 && session?.id) {
        const selectionCtx = formatContextSelectionsForLLM(contextSelections)
        augmented = augmented.trim() ? `${selectionCtx}\n\n---\n\n${augmented}` : selectionCtx
        // The first *artifact*, not the first selection. A file, comment or web
        // reference has nothing for a revision proposal to diff against, so
        // reading index 0 blindly would let a staged workspace file silently
        // disarm the whole review round trip — the AI's reply would then
        // auto-create a duplicate artifact instead of proposing hunks against
        // the one the user was actually working on.
        const primary = contextSelections.find((sel) => sel.kind === "artifact")
        if (primary) {
          useChatStore.getState().setPendingArtifactEditTarget(session.id, {
            artifactId: primary.artifactId,
            requestId: crypto.randomUUID(),
          })
        }
      }

      // ── Review outcomes ─────────────────────────────────────────────
      // Close the revision round trip the block above opens. Rejecting a
      // proposal (or keeping 2 of its 5 hunks) used to be invisible to the
      // assistant, which could then re-propose exactly what the user had just
      // turned down. Read here but consumed only once the send commits, below —
      // the same lifetime as a staged selection — so a receipt rides exactly
      // one message and survives a send that bails before `onSend`.
      const sentReceipts = session?.id
        ? useArtifactStore.getState().peekReviewReceipts(session.id)
        : []
      if (sentReceipts.length > 0) {
        const receiptCtx = formatReviewReceiptsForLLM(sentReceipts)
        if (receiptCtx) {
          augmented = augmented.trim() ? `${receiptCtx}\n\n---\n\n${augmented}` : receiptCtx
        }
      }

      const linkContext = await buildLinkContextBlocks(text)
      // `precomputed` makes this a map lookup for anything already extracted at
      // staging time; files it doesn't cover still extract inline here.
      const attachmentResult = await buildSendContent(augmented, files, { precomputed })
      const content = mergeContextBlocks(attachmentResult.content, linkContext.blocks)
      const rejected = attachmentResult.rejected
      const tokens = attachmentResult.tokens + linkContext.tokens
      const isEmpty =
        (typeof content === "string" && !content.trim()) ||
        (Array.isArray(content) && content.length === 0)
      if (isEmpty) return true
      if (rejected.length > 0) {
        toast.warning(tAttach("skipped", { count: rejected.length }))
      }
      if (linkContext.rejected.length > 0) {
        toast.warning(tAttach("linkSkipped", { count: linkContext.rejected.length }))
      }
      // Oversize guard: above the inline-token ceiling we ask the user to
      // confirm before sending — never silently truncate. The promise resolves
      // when they pick an option in the dialog rendered below.
      if (tokens > INLINE_TOKEN_CEILING) {
        const ok = await new Promise<boolean>((resolve) => {
          setOversizeConfirm({ tokens, resolve })
        })
        setOversizeConfirm(null)
        if (!ok) return false
      }
      await onSend(content, attachmentResult.manifest)
      clearReferencedPaths()
      clearContextSelections()
      useArtifactStore.getState().consumeReviewReceipts(sentReceipts)
      return true
    },
    [
      onSend,
      clearReferencedPaths,
      clearContextSelections,
      pushSystemMessage,
      tAttach,
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
    <div
      className="@container/composer shrink-0 bg-gradient-to-t from-background via-background/95 to-transparent pb-3 pt-5 sm:pb-4 sm:pt-6"
      // Frosted-glass chrome over an active wallpaper (app/globals.css §5),
      // matching the other toolbar surfaces; bg-background/70 stays the
      // no-wallpaper fallback.
      data-tonality="glass"
    >
      {/* Padding lives INSIDE the max-width cap so the composer box and the
          message text share one content edge. With the padding on the bar
          instead, the cap measured the padded box and the composer ran 20px
          wider per side than the messages above it on any pane past ~872px
          (see `message-list.tsx`'s reading column, which caps then pads). */}
      <div
        className="mx-auto w-full max-w-[52rem] px-3 sm:px-5"
        data-slot="composer-reading-column"
      >
        <PromptInputProvider>
          {/* Owns per-attachment extraction / order / OCR opt-in. Must sit INSIDE
              the prompt-input provider: it derives everything from that
              provider's file list. */}
          <StagedAttachmentsProvider>
            <ComposerInner
              session={session}
              status={promptStatus}
              disabled={disabled}
              onSubmit={handleSubmit}
              onStop={onStop}
              onCommand={handleSlashCommand}
              onSubmitMemory={handleMemorySubmit}
              onSubmitShell={handleBashSubmit}
              onOpenCheatsheet={() => setCheatsheetOpen(true)}
              handleRef={ref}
              pendingDraftCount={pendingDrafts.length}
              mentionMode={mentionMode}
              mentionables={mentionables}
              placeholder={placeholder}
              mobileMentionMembers={mobileMentionMembers}
              workflowMention={workflowMention}
              compactLayout={compactLayout}
              toolbar={
                compactLayout ? (
                  <BottomToolbar session={session ?? null} status={status} variant="embedded" />
                ) : null
              }
            />
            {compactLayout ? null : (
              <BottomToolbar
                session={session ?? null}
                status={status}
                leading={
                  session?.platformBinding ? (
                    <>
                      <CannedResponsePicker
                        conversationKey={session.platformBinding.conversationKey}
                        context={{
                          conversation: {
                            title: session.title,
                            platform: session.platformBinding.platform,
                          },
                          contact: { platform: session.platformBinding.platform },
                        }}
                      />
                      <InboxComposerActionsHost
                        conversationKey={session.platformBinding.conversationKey}
                        adapterId={session.platformBinding.adapterId}
                        platform={session.platformBinding.platform}
                        sessionId={session.id}
                        className="flex shrink-0 items-center gap-1 empty:hidden"
                      />
                    </>
                  ) : null
                }
              />
            )}
            <HelperHints onOpenCheatsheet={() => setCheatsheetOpen(true)} />
          </StagedAttachmentsProvider>
        </PromptInputProvider>
      </div>

      <ComposerCheatsheet open={cheatsheetOpen} onOpenChange={setCheatsheetOpen} />

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

      {/* Oversize attachment confirmation — large inlined documents (decision:
          warn + confirm, never silently truncate). */}
      <AlertDialog
        open={oversizeConfirm !== null}
        onOpenChange={(next) => {
          if (!next) oversizeConfirm?.resolve(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tAttach("oversizeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tAttach("oversizeBody", {
                tokens: Math.round((oversizeConfirm?.tokens ?? 0) / 1000),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => oversizeConfirm?.resolve(false)}>
              {tAttach("oversizeCancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => oversizeConfirm?.resolve(true)}>
              {tAttach("oversizeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
