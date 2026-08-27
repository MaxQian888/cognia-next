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
import { FileTextIcon, SparklesIcon, XIcon } from "lucide-react"
import {
  ChangeEvent,
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
import {
  selectComposerContextSelections,
  selectComposerPermissionMode,
  selectComposerWebSearchOn,
  useChatStore,
  useComposerEphemeralSkillIds,
  useComposerPermissionMode,
  type ChatStatus as StoreChatStatus,
} from "@/stores/chat"
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
import { applyOrder } from "@/lib/chat/attachments/reorder"
import { StagedAttachmentsProvider, useStagedAttachments } from "./composer/staged-attachment-store"
import { useAttachmentIntake } from "./composer/hooks/use-attachment-intake"
import { ComposerBox } from "./composer/composer-box"
import {
  resolveComposerSkin,
  toolbarSitsInBox,
  type ResolvedComposerSkin,
} from "@/lib/chat/composer-skin"
import { resolveStylePack } from "@/types/appearance/style-pack"
import { buildLinkContextBlocks, mergeContextBlocks } from "@/lib/chat/link-context"
import { isHttpUrlToken } from "@/lib/chat/link-token"
import { expandFoldedLinks } from "@/lib/chat/link-fold"
import { requestBrowserUrl } from "@/lib/browser/open-url-request"
import { openExternal } from "@/lib/tauri/opener"
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
import { cn } from "@/lib/utils"
import { expandPastes, findPastePlaceholders } from "@/lib/paste-collapse"
import { usePlatform } from "@/hooks/use-platform"
import { useElementHeight } from "@/hooks/use-element-height"
import { Button } from "@/components/ui/button"
import {
  detectTrigger,
  spliceToken,
  type ComposerTrigger,
  type MentionableWorkflowElement,
  type MentionMode,
} from "./composer-trigger"
import type { RemoteDocStagingItem } from "@/hooks/chat/use-remote-doc-staging"
import { useEntityMentionStaging } from "@/hooks/chat/use-entity-mention-staging"
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
import { hasSlashCompletion } from "./composer/slash-completion"
import { useLinkFolding } from "./composer/hooks/use-link-folding"
import { CommandHintBar } from "./composer/command-hint-bar"
import { ScheduleSuggestion } from "./composer/schedule-suggestion"
import { resolveSendButton } from "./composer/send-button-mode"
import { ComposerCheatsheet } from "./composer/composer-cheatsheet"
import { nextPermissionMode } from "./permission-mode-indicator"
import { useResolvedConnectorMode } from "./use-resolved-connector-mode"
import {
  InboxWriteUnavailableError,
  approveInboxDraft,
  rejectInboxDraft,
  sendManualReply,
} from "@/lib/connectors/inbox-writes"
import { listPendingForConversation as listPendingDrafts } from "@/lib/db/connector-drafts"
import type { MessageSegment } from "@/types/connectors/segment"
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
import {
  parseSegments,
  splitLinkSegments,
  splitMentionSegments,
} from "@/lib/slash-commands/parse-segments"
import type { ParamSegment } from "@/lib/slash-commands/parse-segments"
import { computeCodeRanges } from "@/lib/chat/template/code-ranges"
import { listParamTokens, splitParamSegments } from "@/lib/chat/template/param-segments"
import { renderParamTokens } from "@/lib/chat/template/render-params"
import {
  templateRunFromBinding,
  bindingFromRun,
  type ChatTemplateRun,
} from "@/lib/chat/template/run"
import { onTemplateRerunRequest } from "@/lib/chat/template/rerun-request"
import {
  seedParamValues,
  unfilledRequiredParams,
  type OfferedChatTemplate,
} from "@/lib/chat/template/template"
import { useTemplateResourceSearch } from "@/hooks/chat/use-template-resource-search"
import { useRepoChatTemplates } from "@/hooks/chat/use-repo-chat-templates"
import { REPO_TEMPLATE_ID_PREFIX } from "@/lib/chat/template/repo-templates"
import {
  createChatTemplate,
  listChatTemplates,
  recordChatTemplateUse,
  type ChatTemplateRow,
} from "@/lib/db/chat-templates"
import {
  paramState as paramStateOfValue,
  pruneBinding,
  withParamValue,
  type ChatTemplateBinding,
  type ChatTemplateParamValue,
} from "@/lib/chat/template/binding"
import { TemplateParamPopover } from "./composer/template-param-popover"
import { SaveAsTemplateDialog } from "./composer/save-as-template-dialog"
import { TemplateLaunchDiffBar } from "./template-launch-diff-bar"
import {
  diffLaunchSpec,
  launchSpecSeed,
  type ChatTemplateLaunchSpec,
  type LaunchSpecDifference,
} from "@/lib/chat/template/launch-spec"
import { startNewSession } from "@/lib/chat/start-session"
import { pillDeleteRange } from "./composer-pill-delete"
import { runSegments, type CommandError } from "@/lib/slash-commands/run-segments"
import {
  isMemoryTargetAvailable,
  memoryTargetKey,
  parseMemoryTargetKey,
  type ComposerMemoryTarget,
} from "@/lib/chat/memory-target"
import { useComposerCommandStore } from "@/stores/chat/composer-command-store"
import { useComposerGhostText } from "@/hooks/chat/use-composer-ghost-text"
import type { InlineCommandInfo } from "@/lib/chat/completion/inline/types"
import { useInputHistory } from "./composer/hooks/use-input-history"
import { CommandParamForm } from "./composer/command-param-form"
import { trackEvent } from "@/lib/telemetry/events/track-event"
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
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { BottomToolbar } from "./composer/bottom-toolbar"
import { Collapse } from "./composer/collapse"
import { SkillChipRow } from "./composer/skill-chip-row"
import { GoalStatusPill } from "@/components/goal/goal-status-pill"
import { PlanModeBanner } from "@/components/chat/plan-mode-banner"
import { LoopStatusPill } from "@/components/loop/loop-status-pill"
import { HelperHints } from "./composer/helper-hints"
import { VoiceControls } from "./composer/voice-controls"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { InboxComposerActionsHost } from "@/components/inbox/inbox-composer-actions-host"
import { CannedResponsePicker } from "@/components/inbox/canned-response-picker"
import { EnhanceButton } from "./composer/enhance-button"
import { WebSearchToggle } from "./composer/web-search-toggle"
import { SkillPicker } from "./skill-picker"
import { ComposerSessionProvider } from "./composer/composer-session-context"

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
    manifest?: readonly AttachmentManifestEntry[],
    /**
     * What this turn was written from, when it came from a template with
     * parameters. Recorded on the user message row so the turn can be re-run
     * with different values — the sent text has the values substituted in and
     * no longer says which words were parameters. Optional, so the hosts that
     * do not record it simply ignore the argument.
     */
    templateRun?: ChatTemplateRun | null
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
  /**
   * Where this composer sits. `"docked"` (default) is the bar pinned under a
   * message list. `"hero"` is the centred box on the welcome screen, which has
   * no list above it to fade from — see the class branch in the wrapper.
   */
  placement?: "docked" | "hero"
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
    precomputed?: ReadonlyMap<string, ExtractedAttachment>,
    templateRun?: ChatTemplateRun | null
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
  /** Open a settings tab — the enhance wand's "no model" toast uses it. */
  onOpenSettings: (tab: SettingsTab) => void
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
  /** Resolved by the outer `Composer` so one read feeds the whole tree. */
  skin: ResolvedComposerSkin
  toolbar?: ReactNode
}

function ComposerInner(props: InnerProps) {
  const t = useTranslations("chat.composer")
  const tAttach = useTranslations("chat.composer.attachments")
  const tCommands = useTranslations("chat.composer.commands")
  const tMemory = useTranslations("chat.composer.memory")
  const tTemplateParams = useTranslations("chat.composer.templateParams")
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
  // Opt-out (`!== false`), like every other composer-assistance switch.
  const enhanceEnabled = useSettingsStore(
    (s) => s.settings?.composerAssistance?.enhance?.enabled !== false
  )
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
  // Every path that gets bytes (or a folded text paste) INTO the composer —
  // paperclip, mobile "+", paste, drop, smart snapshot, remote doc pick. They
  // share one size/count/type gate; see `use-attachment-intake`.
  const {
    fileInputRef,
    attachmentPrepareCountRef,
    setPastedBlocks,
    onPlusAttach,
    onPaste,
    onFilePick,
    openFileDialog,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    isDragging,
    pastedBlocks,
    removePastedBlock,
    isPreparingAttachments,
    preparingImageCount,
    captureSmartSnapshot,
    smartSnapshotPending,
    stageRemoteDoc,
  } = useAttachmentIntake({
    attachments,
    textInput: controller.textInput,
    textareaRef,
    setCaret,
    isDesktop,
    t,
    tAttach,
  })
  // Per-command failures from the last multi-command submit. Surfaced as
  // failed-state pills on the command queue bar; cleared when the user edits.
  const [commandErrors, setCommandErrors] = useState<CommandError[]>([])

  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  // Read the pane's OWN conversation, matching every write below. Reading
  // `s.permissionMode` here read the FOCUSED conversation, so in split view the
  // unfocused composer showed the other pane's mode and Shift+Tab cycled from
  // it — and the mode reaches the model through `resolveSendOptions`.
  const permissionMode = useComposerPermissionMode(props.session?.id ?? null)
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
  // Scope for the `@memory:` / `@issue:` / … sources. The SESSION's workspace,
  // not the focused one: a background pane composing into another workspace's
  // conversation must offer that workspace's records, matching how the send
  // path resolves everything else about the turn.
  const entityContext = useMemo(
    () => ({ projectId: props.session?.projectId ?? null, sessionId: props.session?.id ?? null }),
    [props.session?.projectId, props.session?.id]
  )
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
    setPermissionMode(props.session.permissionMode ?? null, props.session.id)
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

  // A pasted URL is FOLDED to its short label in the text, with the full URL
  // held aside (`lib/chat/link-fold.ts`). Every consumer below therefore has to
  // treat a label as a link: the parser (so a command beside one still runs),
  // the overlay (so it paints blue), and the send/clipboard paths (so the URL
  // comes back).
  const linkFolding = useLinkFolding({
    value: controller.textInput.value,
    setInput: controller.textInput.setInput,
    textareaRef,
    setCaret,
    display: composerBehavior?.linkChips,
  })
  // Destructured so this depends on the PREDICATE, not on the whole hook
  // object: `isFoldedToken` only changes when the folded-link map does, whereas
  // the object also carries `fold`/`onCut`, whose identities track the textarea
  // callbacks. Widening this dep re-ran the `parseSegments` memo hanging off it
  // — and the overlay/trigger memos below it — on every composer render.
  const { isFoldedToken } = linkFolding
  const isLinkToken = useCallback(
    (token: string) => isHttpUrlToken(token) || isFoldedToken(token),
    [isFoldedToken]
  )
  // The `useState` setter behind the hook — referentially stable, so the draft
  // effects can depend on it without re-running on every render.
  const setFoldedLinks = linkFolding.setLinks
  // The MAP, not the hook object: `submit` is the biggest callback in this file
  // and this is the only field of the hook it reads. Depending on the whole
  // object rebuilt it on every render, since `fold`/`onCut` track the textarea
  // callbacks — the same trap the two destructures above exist to avoid.
  const foldedLinks = linkFolding.links

  // Segment the live input for the submit-time command pipeline (`runSegments`)
  // and the `hasCommand` check. NO mentions here — `runSegments` expects the
  // plain command/text view.
  const segments = useMemo(
    () =>
      parseSegments(controller.textInput.value, (name) => commandMap.has(name), { isLinkToken }),
    [controller.textInput.value, commandMap, isLinkToken]
  )

  // Which spans of the input are code, so `{{parameter}}` tokens inside a fenced
  // block or an inline span stay ordinary text. `{{ }}` belongs to Vue,
  // Handlebars and Jinja too, and pasting one of those into a prompt is
  // completely ordinary.
  const codeRanges = useMemo(
    () => computeCodeRanges(controller.textInput.value),
    [controller.textInput.value]
  )

  // The chip overlay's view: derive `@mention` and `{{parameter}}` pills from
  // the already-parsed `segments` (commands pass through, only text is
  // sub-split) so we don't run a second full tokenizer pass over the input on
  // every keystroke.
  const overlaySegments = useMemo(
    // mentions → links → params. Each pass only ever sub-splits TEXT segments,
    // so the order is about which pill wins a shared span: an `@mention` and a
    // link cannot overlap (a link token has no `@` start), and `{{param}}`
    // braces never appear inside a URL run.
    () =>
      splitParamSegments(
        splitLinkSegments(splitMentionSegments(segments), linkFolding.spans),
        codeRanges
      ),
    [segments, codeRanges, linkFolding.spans]
  )

  // ── `{{parameter}}` values ────────────────────────────────────────────────
  // The tokens live in the text (so a reload recovers them for free); their
  // values live on the draft row, because the chip overlay is a
  // character-for-character mirror of the textarea and a pill can only ever
  // paint the token it covers.
  const [templateBinding, setTemplateBinding] = useState<ChatTemplateBinding | undefined>()
  /** Which parameter the editor panel is open on, if any. */
  const [activeParamId, setActiveParamId] = useState<string | null>(null)
  /** Show the message with its values substituted, read-only. */
  const [previewRequested, setPreviewRequested] = useState(false)
  /** Personal templates offered in the `/` menu. Reloaded whenever one is saved. */
  const [savedTemplates, setSavedTemplates] = useState<ChatTemplateRow[]>([])
  const [templateEpoch, setTemplateEpoch] = useState(0)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  /**
   * The launch spec of the template just inserted, held only so the diff bar
   * can offer to start a conversation that matches it. Cleared on dismiss and
   * whenever the binding goes.
   */
  const [pendingLaunchSpec, setPendingLaunchSpec] = useState<{
    spec: ChatTemplateLaunchSpec
    templateName: string
    body: string
  } | null>(null)
  useEffect(() => {
    let cancelled = false
    listChatTemplates()
      .then((rows) => {
        if (!cancelled) setSavedTemplates(rows)
      })
      // Dexie unavailable (SSR / a test without fake-indexeddb): the `/` menu
      // simply offers no templates, which is the same as having none.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [templateEpoch])
  /**
   * Load a past turn back into the box, chips and all.
   *
   * Subscribed rather than passed down: the message row that offers this sits
   * three layers inside the virtualised list and the composer is the list's
   * SIBLING, so a callback would have to be threaded through components that
   * have no interest in it. The address check is what keeps a split pane group
   * from filling in every composer at once.
   *
   * It refuses over a non-empty box. Replacing is the obvious implementation
   * and it silently destroys whatever was half-written — the input history only
   * holds SENT messages, so there would be nothing to recover it from. One
   * extra step in a rare case beats losing text in it.
   */
  useEffect(
    () =>
      onTemplateRerunRequest((detail) => {
        if (!sessionId || detail.sessionId !== sessionId) return
        if (controller.textInput.value.trim().length > 0) {
          toast.info(tTemplateParams("rerunBusy"))
          return
        }
        controller.textInput.setInput(detail.run.text)
        setTemplateBinding(bindingFromRun(detail.run, Date.now()))
        setPendingLaunchSpec(null)
        // Land on the first parameter with its editor open — the reason to
        // re-run a turn is to change one of them.
        const first = listParamTokens(detail.run.text, computeCodeRanges(detail.run.text))[0]
        requestAnimationFrame(() => {
          const ta = textareaRef.current
          if (!ta) return
          ta.focus()
          const caret = first ? first.start : detail.run.text.length
          ta.setSelectionRange(caret, caret)
          setCaret(caret)
          if (first) setActiveParamId(first.paramId)
        })
      }),
    [sessionId, controller.textInput, textareaRef, setCaret, tTemplateParams]
  )

  // Templates that travel IN the checkout, behind the same Workspace Trust
  // verdict the send path uses. Personal ones come first: they are yours, and a
  // `git pull` must never reorder the list you built muscle memory on.
  const repoTemplates = useRepoChatTemplates(cwd)
  const chatTemplates: OfferedChatTemplate[] = useMemo(
    () => [...savedTemplates, ...repoTemplates],
    [savedTemplates, repoTemplates]
  )

  const paramTokens = useMemo(
    () => overlaySegments.filter((seg): seg is ParamSegment => seg.kind === "param"),
    [overlaySegments]
  )
  // Derived from the chips rather than from a fresh scan of the text, so the
  // set that blocks a send is exactly the set the user can see and click. A
  // second scan would also count `{{x}}` inside a `/command`'s arguments, which
  // is never a chip and belongs to `applyTemplate`.
  const paramIds = useMemo(() => [...new Set(paramTokens.map((seg) => seg.paramId))], [paramTokens])
  // Values whose token has left the text are dropped here rather than in an
  // effect: breaking a token is how the user demotes a chip, and the value has
  // to go with it or retyping `{{module}}` later would resurrect an answer from
  // a sentence that no longer exists. Deriving keeps it out of a setState loop.
  const effectiveBinding = useMemo(
    () => (templateBinding ? pruneBinding(templateBinding, paramIds) : undefined),
    [templateBinding, paramIds]
  )
  /**
   * Whether a bound reference still points at something on THIS device.
   *
   * Only answered for the kinds whose whole population is already in memory. A
   * file is deliberately never judged: the workspace may simply not be loaded
   * yet, and a dangling `@path` is exactly what typing one by hand produces —
   * flagging it would be inventing a failure the composer does not otherwise
   * have. An empty candidate list means "this composer has no source for that
   * kind", not "the target is gone", so it is not evidence either.
   */
  const isResourceResolvable = useCallback(
    (value: Extract<ChatTemplateParamValue, { kind: "resource" }>) => {
      if (value.resourceKind === "subagent") {
        // `chatAgents` is undefined outside combined-mention mode — a composer
        // with no subagent source at all, which is the same "no evidence" case
        // as an empty list, not a reason to flag the chip.
        const list = chatAgents ?? []
        return list.length === 0 || list.some((agent) => agent.handle === value.id)
      }
      if (value.resourceKind === "agent") {
        const list = props.mentionables ?? []
        return list.length === 0 || list.some((target) => target.name === value.id)
      }
      return true
    },
    [chatAgents, props.mentionables]
  )
  const paramPillState = useCallback(
    (paramId: string) => paramStateOfValue(effectiveBinding?.params[paramId], isResourceResolvable),
    [effectiveBinding, isResourceResolvable]
  )
  /**
   * The declarations behind the tokens currently in the box — labels, which
   * parameters are optional, and which open an `@` picker instead of a text
   * field.
   *
   * Only honoured when the saved template is still at the revision this draft
   * was inserted at. The binding pins a version and never follows the template
   * (see `ChatTemplateBinding`), so reading a NEWER declaration list here would
   * quietly re-interpret a half-written message: a parameter demoted to
   * optional after the fact would stop blocking a send that the user set up
   * expecting it to. On a mismatch every token falls back to "required free
   * text", which is what an undeclared token already is.
   */
  const paramDeclarations = useMemo(() => {
    if (!effectiveBinding) return []
    const row = chatTemplates.find((template) => template.id === effectiveBinding.templateId)
    if (!row || String(row.revision) !== effectiveBinding.version) return []
    return row.params
  }, [chatTemplates, effectiveBinding])
  const searchTemplateResources = useTemplateResourceSearch({
    cwd,
    chatAgents,
    mentionables: props.mentionables,
  })
  /** The parameter token containing `caret`, or null. */
  const paramTokenAt = useCallback(
    (caret: number) => paramTokens.find((seg) => caret >= seg.start && caret <= seg.end) ?? null,
    [paramTokens]
  )
  // The one real cost of keeping the token in the text is that you never see
  // the finished sentence while editing — the chip overlay has to mirror the
  // textarea character for character, so a pill can only paint `{{module}}`.
  // This is the answer to that, and it only exists when there is something to
  // preview.
  const preview = useMemo(() => {
    if (paramTokens.length === 0) return null
    return {
      on: previewRequested,
      text: renderParamTokens(controller.textInput.value, paramTokens, effectiveBinding).text,
      toggle: () => setPreviewRequested((on) => !on),
    }
  }, [paramTokens, previewRequested, controller.textInput.value, effectiveBinding])

  const tSaveTemplate = useTranslations("chat.composer.saveTemplate")
  const tLaunchDiff = useTranslations("chat.composer.launchDiff")

  /** What the inserted template's setup would change about THIS conversation. */
  const launchDifferences: LaunchSpecDifference[] = useMemo(() => {
    if (!pendingLaunchSpec || !props.session) return []
    return diffLaunchSpec(pendingLaunchSpec.spec, {
      model: props.session.model,
      permissionMode: props.session.permissionMode,
      systemPrompt: props.session.systemPrompt,
      workingDir: props.session.workingDir,
      characterId: props.session.characterId,
      squadId: props.session.squadId,
      projectId: props.session.projectId,
    })
  }, [pendingLaunchSpec, props.session])

  /** The current conversation's setup, offered to "save as template". */
  const currentLaunchSpec: ChatTemplateLaunchSpec | undefined = useMemo(() => {
    const session = props.session
    if (!session) return undefined
    return {
      ...(session.model ? { model: session.model } : {}),
      ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
      ...(session.workingDir ? { workingDir: session.workingDir } : {}),
      ...(session.characterId ? { characterId: session.characterId } : {}),
      ...(session.squadId ? { squadId: session.squadId } : {}),
      ...(session.projectId ? { workspace: { projectId: session.projectId } } : {}),
    }
  }, [props.session])

  const launchFieldLabel = useCallback(
    (difference: LaunchSpecDifference): string => {
      const label = {
        characterId: tLaunchDiff("fieldCharacter"),
        squadId: tLaunchDiff("fieldSquad"),
        projectId: tLaunchDiff("fieldProject"),
        model: tLaunchDiff("fieldModel"),
        permissionMode: tLaunchDiff("fieldPermissionMode"),
        workingDir: tLaunchDiff("fieldWorkingDir"),
        systemPrompt: tLaunchDiff("fieldSystemPrompt"),
      }[difference.field]
      // The value itself for anything with a readable one; an opaque id reads
      // as noise, so those show only which axis differs.
      const opaque = difference.field === "characterId" || difference.field === "squadId"
      return opaque ? label : `${label}: ${difference.wanted}`
    },
    [tLaunchDiff]
  )

  /**
   * Start a fresh conversation configured the way the template asks, and carry
   * the body across. The current conversation is left exactly as it was.
   */
  const startSessionFromTemplate = useCallback(async () => {
    const pending = pendingLaunchSpec
    if (!pending) return
    setPendingLaunchSpec(null)
    try {
      await startNewSession(launchSpecSeed(pending.spec))
      // The composer is not remounted per session, so the draft-hydration
      // effect clears the box for the new one — set the body after it has,
      // which is the same frame the session id lands in props.
      requestAnimationFrame(() => controller.textInput.setInput(pending.body))
    } catch (err) {
      loggers.chat.error("composer: starting a session from a template failed", err)
    }
  }, [pendingLaunchSpec, controller.textInput])
  const saveCurrentAsTemplate = useCallback(
    async (input: { name: string; description?: string; launchSpec?: ChatTemplateLaunchSpec }) => {
      await createChatTemplate({ ...input, body: controller.textInput.value })
      // Re-read rather than push onto the local list: the store derives the
      // declarations and the id, and re-reading is the only way the `/` menu
      // shows exactly what was stored.
      setTemplateEpoch((epoch) => epoch + 1)
      toast.success(tSaveTemplate("saved"))
    },
    [controller.textInput, tSaveTemplate]
  )

  const setParamValue = useCallback((paramId: string, value: ChatTemplateParamValue) => {
    setTemplateBinding((prev) =>
      withParamValue(
        prev ?? { templateId: "", version: "", params: {}, insertedAt: Date.now() },
        paramId,
        value
      )
    )
  }, [])

  // Recent / pinned slash commands for the popover's empty-query view.
  const recentCommands = useComposerCommandStore((s) => s.recentCommands)
  const pinnedCommands = useComposerCommandStore((s) => s.pinnedCommands)
  const noteCommandUsed = useComposerCommandStore((s) => s.noteCommandUsed)
  const togglePinnedCommand = useComposerCommandStore((s) => s.togglePin)

  // Shell-style ↑/↓ recall of previously sent messages for this session.
  const history = useInputHistory(sessionId)

  // Inline ghost-text completion. Declared here (rather than beside the other
  // refs above) because it consumes `history` and `slashCommands` — the same
  // per-session history ↑/↓ recalls and the same command list the `/` popover
  // shows, so the ghost can never disagree with either.
  const ghostCommands = useMemo<InlineCommandInfo[]>(
    () => slashCommands.map((c) => ({ name: c.name, description: c.description })),
    [slashCommands]
  )
  const ghost = useComposerGhostText({
    session: props.session,
    history: history.entries,
    commands: ghostCommands,
  })
  // Translated badge for where the active suggestion came from. A history hit
  // is exact and free; a model hit is a guess that cost a call — the two look
  // identical as dim text, so the source has to be stated.
  const ghostSourceLabel = useMemo(() => {
    switch (ghost.suggestion?.source) {
      case "history":
        return t("ghostSourceHistory")
      case "command":
        return t("ghostSourceCommand")
      case "ai":
        return t("ghostSourceAi")
      case "agent":
        return t("ghostSourceAgent")
      case "plugin":
        return t("ghostSourcePlugin")
      default:
        return undefined
    }
  }, [ghost.suggestion?.source, t])

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
      isLinkToken,
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
  }, [
    controller.textInput.value,
    caret,
    popoverDismissed,
    resolvedMentionMode,
    hasCommandPrefix,
    isLinkToken,
  ])

  // The trigger the COMPLETION PANEL acts on. `trigger` itself stays wider on
  // purpose (the hint bar and ghost-text suppression still want to know which
  // command the caret is in); this one is null whenever the panel has nothing
  // left to offer, and it gates the popover, its keyboard capture and pill
  // delete together. One verdict, so a panel that is not showing can never eat
  // a keystroke — which is how Enter used to overwrite the first command of a
  // chained line instead of sending the message.
  const completionTrigger = useMemo(
    () => (hasSlashCompletion(trigger, slashCommands) ? trigger : null),
    [trigger, slashCommands]
  )

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
  }, [
    controller.textInput.value,
    caret,
    popoverDismissed,
    resolvedMentionMode,
    hasCommandPrefix,
    isLinkToken,
  ])

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

  // A latest-value ref, not a direct call: `stageRemoteDoc` re-identifies
  // whenever the staged-file list changes (it closes over `acceptFiles`), and
  // naming it in `onPickPopoverItem`'s deps would rebuild that whole callback
  // on every attachment add. The ref keeps the pick handler stable while still
  // reaching the current implementation. Written from an effect, never during
  // render.
  const stageRemoteDocRef = useRef<(item: RemoteDocStagingItem) => Promise<void>>(
    async () => undefined
  )
  useEffect(() => {
    stageRemoteDocRef.current = stageRemoteDoc
  }, [stageRemoteDoc])

  // `stageEntity` is stable already (it closes over the session id and the
  // translator), so it needs no latest-value ref — it can be named in the deps.
  const stageEntity = useEntityMentionStaging({ sessionId: props.session?.id ?? null })

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
      } else if (item.kind === "chatTemplate") {
        // Insert the BODY over the `/query` token, not the template's name:
        // picking a template produces a message, where picking a command drops
        // `/name` in for review. `spliceToken` is the shared insertion primitive
        // so the caret and trailing-space rules cannot drift from the others.
        const template = item.template
        const result = spliceToken(
          controller.textInput.value,
          trigger.tokenStart,
          trigger.tokenEnd,
          template.body
        )
        controller.textInput.setInput(result.value)
        // Seed from what this template was set to last time — in practice most
        // values repeat — falling back to the declared default. Both are
        // filtered to parameters the body still declares, so a value orphaned
        // by an edit cannot come back.
        const seeded = seedParamValues(template.params, template.lastParams)
        setTemplateBinding({
          templateId: template.id,
          version: String(template.revision),
          params: seeded,
          insertedAt: Date.now(),
        })
        // Held only so the diff bar can OFFER a matching conversation. Nothing
        // about the current one is touched — see `TemplateLaunchDiffBar`.
        setPendingLaunchSpec(
          template.launchSpec
            ? { spec: template.launchSpec, templateName: template.name, body: template.body }
            : null
        )
        // Land on the first parameter that still needs a value, with its editor
        // open — the whole point of inserting a template is to fill it in.
        const firstUnset = template.params.find((param) => !seeded[param.id])
        const bodyStart = trigger.tokenStart
        requestAnimationFrame(() => {
          const ta = textareaRef.current
          if (!ta) return
          ta.focus()
          const tokenAt = firstUnset ? template.body.indexOf(`{{${firstUnset.id}}}`) : -1
          const caretAt = tokenAt >= 0 ? bodyStart + tokenAt : result.caret
          ta.setSelectionRange(caretAt, caretAt)
          setCaret(caretAt)
          if (firstUnset) setActiveParamId(firstUnset.id)
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
              useChatStore.getState().toggleEphemeralSkill(skillId, props.session?.id ?? null),
            addReferencedWorkflowElement: (el) =>
              useChatStore.getState().addReferencedWorkflowElement(el, props.session?.id ?? null),
            applyPreset: (preset, session) => applyPreset(preset, session).then(() => {}),
            stageRemoteDoc: (item) => stageRemoteDocRef.current(item),
            stageEntity: (item) => stageEntity(item.candidate),
            recordMention: (ref) =>
              useChatStore.getState().addCitedRef(ref, props.session?.id ?? null),
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
      stageEntity,
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
    // Same for the folded links: the text carries short labels, and this is the
    // map that turns them back into the URLs the user actually wrote.
    const linkMap = foldedLinks
    const restoreText = (text: string) => expandFoldedLinks(expandPastes(text, pasteMap), linkMap)

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
      setFoldedLinks({})
      cleared = true
    }
    // Run only once a send is CONFIRMED successful: now it is safe to drop (and
    // revoke) the staged attachments, the reminder chips, and the saved draft.
    const finalizeSend = () => {
      // Remember what this template's parameters were set to, so the next
      // insert pre-fills them — in practice most values repeat. Fire-and-forget
      // and only after a CONFIRMED send: losing a usage counter must never
      // surface as a failure on a turn that actually went out.
      // Repository templates deliberately remember nothing. There is no row to
      // write to, and a checkout's template is not the sort of thing that
      // should accumulate one person's last answers — what it wants pre-filled
      // it declares as a default, in the file, where the team can see it.
      const usedTemplateId = effectiveBinding?.templateId
      if (usedTemplateId && !usedTemplateId.startsWith(REPO_TEMPLATE_ID_PREFIX)) {
        void recordChatTemplateUse(usedTemplateId, effectiveBinding.params).catch(() => undefined)
      }
      if (clearAfterSendEnabled) {
        attachments.clear()
        setRestoredAttachments([])
        if (sessionId) void clearChatDraft(sessionId, { hostAlreadyCleared: true })
      }
      settleFocusAfterSend()
    }
    const restoreInputAfterFailure = () => {
      if (!cleared) return
      controller.textInput.setInput(text)
      setPastedBlocks(pasteMap)
      // The text comes back holding SHORT labels, so the label→URL map has to
      // come back with it. Without this a failed send left every folded link as
      // literal prose, and the retry shipped `··owner/repo` to the model.
      setFoldedLinks(linkMap)
      cleared = false
      // Attachments were never cleared, so there is nothing to restore — the
      // staged files are still live in the controller.
    }
    // ── Unfilled `{{parameters}}` ─────────────────────────────────────────
    // A literal `{{module}}` reaching the model is never what anyone meant, and
    // the model will cheerfully act as though it understood. Refuse the send,
    // say how many are missing, and put the caret on the first one so the fix
    // is one keystroke away. Checked BEFORE the optimistic clear so nothing has
    // to be restored.
    const missingParams = unfilledRequiredParams(paramIds, effectiveBinding, paramDeclarations)
    if (missingParams.length > 0) {
      toast.error(tTemplateParams("unfilled", { count: missingParams.length }))
      const first = paramTokens.find((seg) => seg.paramId === missingParams[0])
      const ta = textareaRef.current
      if (first && ta) {
        ta.focus()
        ta.setSelectionRange(first.start, first.start)
        setCaret(first.start)
        setActiveParamId(first.paramId)
      }
      return
    }
    // Substitute on the CHIP RANGES, before the command pipeline: code stays
    // code because the chip pass already excluded it, and a `/command`'s
    // arguments stay untouched for `applyTemplate`'s own `$1` pass.
    const paramRendered = renderParamTokens(text, paramTokens, effectiveBinding)
    // Captured from the text as it reads RIGHT HERE — before substitution and
    // before the command pipeline rewrites anything — because that is the only
    // form in which the parameters are still visible as parameters. What goes
    // out has the values baked in and nothing marking which words they were.
    const templateRun = templateRunFromBinding(effectiveBinding, text)

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
      // The mode is decided from the ORIGINAL first character, but sliced out
      // of the substituted text. Safe together: whenever `text[0]` is `!` or
      // `#` it is not the start of a `{{token}}`, so substitution cannot have
      // moved index 0.
      const modeChar = text[0]
      const submittedText = paramRendered.text
      let pipelineText = submittedText
      let modeRan = false
      if (modeChar === "!" || modeChar === "#") {
        const newline = submittedText.indexOf("\n")
        const modeLine = (newline === -1 ? submittedText : submittedText.slice(0, newline))
          .slice(1)
          .trim()
        pipelineText = newline === -1 ? "" : submittedText.slice(newline + 1)
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
      // `segments` is memoised over the UNSUBSTITUTED text, so it is stale the
      // moment a parameter was replaced — re-parse then too, not just after a
      // first-line mode consumed a line.
      const pipelineSegments =
        modeRan || paramRendered.changed
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
            restoreText(outgoingText),
            filesToSend,
            precomputed,
            templateRun
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
        restoreText(pipelineText),
        filesToSend,
        precomputed,
        templateRun
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
    // Both are stable across renders (a `useState` setter and a ref), but they
    // now arrive from `useAttachmentIntake` rather than a local `useState`, so
    // the lint rule can no longer prove it. Naming them costs nothing.
    attachmentPrepareCountRef,
    setPastedBlocks,
    controller.textInput,
    paramIds,
    paramTokens,
    paramDeclarations,
    effectiveBinding,
    tTemplateParams,
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
    foldedLinks,
    setFoldedLinks,
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
  /**
   * Move the caret to the parameter after (or before) the caret and open it.
   * Returns false when there is nowhere to go, so the caller can let the key
   * do its normal job.
   */
  const stepToParam = useCallback(
    (direction: 1 | -1): boolean => {
      const ta = textareaRef.current
      if (!ta || paramTokens.length === 0) return false
      const caretAt = ta.selectionStart ?? 0
      const ordered = direction === 1 ? paramTokens : [...paramTokens].reverse()
      const next =
        ordered.find((seg) => (direction === 1 ? seg.start > caretAt : seg.end < caretAt)) ??
        ordered[0]
      if (!next) return false
      ta.setSelectionRange(next.start, next.start)
      setCaret(next.start)
      setActiveParamId(next.paramId)
      return true
    },
    [paramTokens, textareaRef]
  )

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
        setPermissionMode(next, props.session?.id ?? null)
        return
      }
      // While an IME composition is active, Enter / Arrow / Tab / Escape belong
      // to the candidate window — let them fall through so picking a Chinese (or
      // Japanese, etc.) candidate doesn't accidentally confirm/navigate the
      // popover. `nativeEvent.isComposing` is authoritative for the keystroke
      // that ends composition; the state flag is a belt-and-suspenders backup.
      if (completionTrigger && (isComposing || e.nativeEvent.isComposing)) {
        return
      }
      if (completionTrigger) {
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
        if (e.key === "Tab" && !e.shiftKey && completionTrigger.kind !== "bash") {
          e.preventDefault()
          popoverRef.current?.confirm()
          return
        }
        if (e.key === "Enter" && !e.shiftKey) {
          // Bash mode: Enter should fall through to submit (bash run).
          if (completionTrigger.kind === "bash") {
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
        !completionTrigger &&
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
      // Tab walks the `{{parameter}}` chips. Only claimed when the text
      // actually HAS parameters — otherwise Tab keeps its normal job of moving
      // focus out of the composer, which is the only way a keyboard user
      // reaches the toolbar.
      if (
        e.key === "Tab" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        // No open panel — with one showing, Tab belongs to its list.
        !completionTrigger &&
        !ghost.ghost &&
        paramTokens.length > 0
      ) {
        if (stepToParam(1)) {
          e.preventDefault()
          return
        }
      }
      // Escape closes the parameter editor before anything else claims it.
      if (e.key === "Escape" && activeParamId) {
        e.preventDefault()
        setActiveParamId(null)
        return
      }
      // Tab accepts the dim continuation; Esc dismisses it; Alt+]/Alt+[ walk
      // the ranked alternatives (the same bindings VS Code uses for cycling
      // inline suggestions). All fall through to existing behavior when there
      // is no ghost to act on.
      if (!completionTrigger && ghost.ghost) {
        if (e.key === "Tab" && !e.shiftKey) {
          if (acceptGhost()) {
            e.preventDefault()
            return
          }
        }
        if (e.altKey && (e.key === "]" || e.key === "[")) {
          // Only meaningful with something to cycle to; otherwise let the
          // keystroke through so it still types a bracket.
          if (ghost.candidates.length > 1) {
            e.preventDefault()
            if (e.key === "]") ghost.cycleNext()
            else ghost.cyclePrev()
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
      completionTrigger,
      permissionMode,
      setPermissionMode,
      dismissPopover,
      submit,
      isComposing,
      history,
      controller.textInput,
      overlaySegments,
      paramTokens,
      stepToParam,
      activeParamId,
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
      // Fold any URL the caret has moved past. Never the one being typed — the
      // caret rule inside `foldLinks` sees to that — and never mid-composition,
      // where rewriting the value would drop the IME's in-flight text.
      if (!isComposing) {
        linkFolding.fold(e.target.value, e.target.selectionStart ?? e.target.value.length)
      }
    },
    [controller.textInput, history, isComposing, linkFolding]
  )

  // Leaving the box settles every remaining URL, including one just pasted with
  // the caret still sitting at its end.
  const onBlur = useCallback(() => {
    linkFolding.fold(controller.textInput.value, -1)
  }, [linkFolding, controller.textInput.value])

  const onSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget
      const caretAt = ta.selectionStart ?? ta.value.length
      setCaret(caretAt)
      // Close the parameter editor once the caret leaves the token it belongs
      // to — including when the user breaks the token, which stops it being a
      // parameter at all. It never OPENS from here: `onSelect` also fires for
      // arrow keys, and a panel that appeared every time the caret drifted
      // through `{{module}}` would flash at someone reading back their own
      // sentence.
      if (activeParamId && paramTokenAt(caretAt)?.paramId !== activeParamId) {
        setActiveParamId(null)
      }
    },
    [activeParamId, paramTokenAt]
  )

  /**
   * Open the editor for the parameter the user just clicked in.
   *
   * Pointer release, not `onSelect`: clicking a chip is a deliberate "edit
   * this", where arrowing past one is not.
   */
  const onTextareaMouseUp = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget
      const caretAt = ta.selectionStart ?? 0
      if (caretAt !== (ta.selectionEnd ?? caretAt)) return // a drag-selection, not a click
      // ⌘/Ctrl-click follows a link, the way it does everywhere else. The
      // overlay that paints the label captures no pointer events, so the click
      // lands in the textarea and the caret tells us which token it hit.
      if (e.metaKey || e.ctrlKey) {
        const link = linkFolding.spans.find((span) => caretAt >= span.start && caretAt <= span.end)
        if (link) {
          e.preventDefault()
          // The embedded browser pane takes it when one is open; otherwise the
          // OS browser does, which is what every other link in the app does.
          if (!requestBrowserUrl(link.url)) void openExternal(link.url)
          return
        }
      }
      setActiveParamId(paramTokenAt(caretAt)?.paramId ?? null)
    },
    [paramTokenAt, linkFolding.spans]
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

  const desktopTrigger = mobileMentionOpen ? null : completionTrigger

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
      // Folded links belong to the draft they were pasted into; the restore
      // below brings this session's own map back.
      setFoldedLinks({})
      // Parameter values belong to the draft they were typed into.
      setTemplateBinding(undefined)
      setActiveParamId(null)
      setPendingLaunchSpec(null)
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
        // The tokens come back with the text; their values come back here.
        setTemplateBinding(row?.templateBinding)
        // Same for links: the text holds short labels, and this is what turns
        // them back into URLs on send. Without it a restored draft would ship
        // `svenstaro/genact` as prose.
        setFoldedLinks(row?.foldedLinks ?? {})
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
  }, [
    persistDrafts,
    sessionId,
    draftHydratedFor,
    setFoldedLinks,
    controller.textInput,
    attachments,
    staged,
    setPastedBlocks,
  ])

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
      // `undefined` keeps the default debounce. The binding is passed on every
      // save (never omitted) so clearing the last parameter actually clears the
      // stored value — omission means "preserve" in `setDraft`.
      setChatDraftDebounced(sessionId, controller.textInput.value, draftAttachments, undefined, {
        templateBinding: effectiveBinding ?? null,
        // Passed on every save (never omitted) so removing the last link
        // actually clears the stored map — omission means "preserve".
        foldedLinks,
      })
    } catch {
      // Dexie unavailable (e.g., SSR / tests without fake-indexeddb) — drafts are best-effort.
    }
  }, [
    controller.textInput.value,
    draftAttachments,
    sessionId,
    draftHydratedFor,
    persistDrafts,
    effectiveBinding,
    foldedLinks,
  ])

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
  // The primary button's whole state (send / stop / spinner / draft) in one
  // decision — see `send-button-mode.ts` for the combination table. The key
  // case the inline ternaries used to miss: a turn streaming with text already
  // typed is a *send* (it joins the running turn as a follow-up), not a stop.
  const sendButton = resolveSendButton({
    status: props.status,
    isSending,
    isPreparingAttachments,
    hasContent: controller.textInput.value.trim().length > 0 || attachments.files.length > 0,
    hasPendingDrafts,
    composerDisabled: !!props.disabled,
    // Web shell + a platform-bound session cannot write outbound at all.
    outboundBlocked: !isDesktop && !!props.session?.platformBinding,
  })
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

  const ephemeralSkillIds = useComposerEphemeralSkillIds(props.session?.id ?? null)
  const toggleEphemeralSkill = useChatStore((s) => s.toggleEphemeralSkill)

  return (
    // Every composer control below writes its draft state through actions that
    // otherwise default to "the focused conversation". In split view that made
    // the unfocused pane edit the pane beside it — including the permission
    // mode, which `resolveSendOptions` reads back, so the mistake reached the
    // model and not just the chrome.
    <ComposerSessionProvider value={props.session?.id ?? null}>
      <div ref={setContainerEl}>
        {/* Every band stacked above the textarea shares one scroll container with
          a height cap. Six attachments plus an active goal, an open loop and the
          plan-mode banner could otherwise push the input off the bottom of the
          screen. Each band still animates its own height inside it. */}
        <div className="max-h-[40vh] overflow-y-auto overscroll-contain">
          {pendingLaunchSpec ? (
            <TemplateLaunchDiffBar
              differences={launchDifferences}
              templateName={pendingLaunchSpec.templateName}
              labelFor={launchFieldLabel}
              onStartNewSession={() => void startSessionFromTemplate()}
              onDismiss={() => setPendingLaunchSpec(null)}
              className="mb-1"
            />
          ) : null}
          {/* One row, and only for what has no form in the text: attachments,
              @-references, artifacts — plus any command that FAILED. Commands
              and links show up in the text itself. */}
          <ContextChipBar
            onRunOcr={handleRunOcrForPanel}
            ocrBusy={ocr.status === "running"}
            onExtractOcrToInput={handleExtractOcrToInput}
            onViewOcrDetail={ocrBubbleResult ? () => setOcrBubbleOpen(true) : undefined}
            preparingImageCount={preparingImageCount}
            segments={segments}
            commandErrors={commandErrors}
            onRemoveCommand={removeCommandSegment}
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
              // Keyed by THIS pane's conversation, matching where the ids above
              // are read from — the bare action defaults to the focused pane,
              // so × detached a skill from the conversation beside it and left
              // this chip standing.
              onRemove={(skillId) => toggleEphemeralSkill(skillId, props.session?.id ?? null)}
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
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => removePastedBlock(ph)}
                        aria-label={t("removePastedChip")}
                        className="-mr-1 size-4 rounded-sm text-muted-foreground/60 hover:bg-transparent hover:text-foreground"
                      >
                        <XIcon className="size-3" aria-hidden />
                      </Button>
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
        <ComposerBox
          skin={props.skin}
          compactLayout={compactLayout}
          isMobile={isMobile}
          disabled={props.disabled}
          permissionMode={permissionMode}
          placeholder={props.placeholder}
          textInput={controller.textInput}
          textareaRef={textareaRef}
          chipOverlayRef={chipOverlayRef}
          ghostOverlayRef={ghostOverlayRef}
          overlaySegments={overlaySegments}
          maxHeightRem={COMPOSER_MAX_HEIGHT_REM}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onSelect={onSelect}
          onMouseUp={onTextareaMouseUp}
          paramState={paramPillState}
          preview={preview}
          saveAsTemplate={
            controller.textInput.value.trim().length > 0 ? () => setSaveTemplateOpen(true) : null
          }
          enhance={
            // Same gate as the bookmark beside it: a wand over an empty box has
            // nothing to rewrite, and `enhancePrompt` would only answer
            // "empty". Off entirely when the user disabled the feature.
            enhanceEnabled && controller.textInput.value.trim().length > 0 ? (
              <EnhanceButton
                value={controller.textInput.value}
                onApply={(next) => controller.textInput.setInput(next)}
                session={props.session}
                disabled={props.disabled || props.status === "streaming"}
                className="size-6 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                onOpenProviderSettings={() => props.onOpenSettings("api-key")}
              />
            ) : null
          }
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          isComposing={isComposing}
          onBlur={onBlur}
          onCopy={linkFolding.onCopy}
          onCut={linkFolding.onCut}
          ghost={ghost}
          ghostSourceLabel={ghostSourceLabel}
          acceptGhost={acceptGhost}
          fileInputRef={fileInputRef}
          attachmentAccept={ATTACHMENT_ACCEPT}
          onFilePick={onFilePick}
          openFileDialog={openFileDialog}
          onPlusAttach={onPlusAttach}
          captureSmartSnapshot={captureSmartSnapshot}
          smartSnapshotPending={smartSnapshotPending}
          capabilityMenu={capabilityMenu}
          // The `+` menu's namespace entries (`@lark:`, `@issue:`, `/goal`)
          // work by TYPING: the composer's own trigger detection is what opens
          // each panel, so the menu puts the caret in front of it rather than
          // owning a second picker. Append, never replace — a half-written
          // message is not the menu's to discard.
          onInsertText={(text) => {
            const current = controller.textInput.value
            const needsSpace = current.length > 0 && !/\s$/.test(current)
            controller.textInput.setInput(`${current}${needsSpace ? " " : ""}${text}`)
            textareaRef.current?.focus()
          }}
          onOpenExternalServices={() => props.onOpenSettings("services")}
          isDragging={isDragging}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          sendButton={sendButton}
          sendIconTransition={sendIconTransition}
          isPreparingAttachments={isPreparingAttachments}
          submit={() => void submit()}
          onStop={() => void props.onStop()}
          toolbar={props.toolbar}
          bridges={
            <>
              <VoiceTranscriptionBridge disabled={props.disabled} />
              <ComposerAppendBridge sessionId={props.session?.id} />
            </>
          }
          t={t}
          tAttach={tAttach}
        />

        <CommandHintBar
          trigger={desktopTrigger}
          commandMap={commandMap}
          value={controller.textInput.value}
        />

        {/* Reads scheduling intent out of what is being typed and offers the
            scheduler's create form pre-filled. Never intercepts the turn —
            Enter still sends. See `components/chat/composer/schedule-suggestion`.

            General direct chat ONLY, on the same `isCombinedMention` condition
            the entity sources use. This one component serves every composer in
            the app, and "turn this into a scheduled task?" is an offer to LEAVE
            for `/scheduler` — which in the workflow editor's chat tab means
            abandoning the graph being authored, and in a team or IM-draft
            composer means walking out of a conversation that is not the user's
            alone. A direct chat is the only place that detour is harmless. */}
        {isCombinedMention ? (
          <ScheduleSuggestion
            value={controller.textInput.value}
            sessionId={props.session?.id}
            className="mx-1"
          />
        ) : null}

        <PluginExtensionSlot point="chat.input.below" className="px-1 pt-1 empty:hidden" />

        <SaveAsTemplateDialog
          open={saveTemplateOpen}
          body={controller.textInput.value}
          launchSpec={currentLaunchSpec}
          onOpenChange={setSaveTemplateOpen}
          onSave={saveCurrentAsTemplate}
        />

        <TemplateParamPopover
          paramId={activeParamId}
          param={
            activeParamId
              ? (paramDeclarations.find((param) => param.id === activeParamId) ?? null)
              : null
          }
          searchResources={searchTemplateResources}
          value={activeParamId ? effectiveBinding?.params[activeParamId] : undefined}
          anchor={containerEl}
          position={
            activeParamId
              ? { index: paramIds.indexOf(activeParamId), total: paramIds.length }
              : undefined
          }
          onChange={(value) => activeParamId && setParamValue(activeParamId, value)}
          onClose={() => setActiveParamId(null)}
        />

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
          entityContext={entityContext}
          chatTemplates={chatTemplates}
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
    </ComposerSessionProvider>
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
  const ephemeralSkillIds = useComposerEphemeralSkillIds(session?.id ?? null) ?? []
  const setEphemeralSkillIds = useChatStore((s) => s.setEphemeralSkillIds) ?? (() => {})
  const tSkill = useTranslations("skills.composer.skillPicker")
  const [pickerOpen, setPickerOpen] = useState(false)
  const isMobile = usePlatform() === "mobile"
  const isStreaming = status === "streaming"
  const controlsDisabled = disabled || isStreaming

  return (
    <>
      {/* The prompt-enhance wand used to live here. It rewrites what is in the
          box, so it belongs ON the box: it now sits beside the save-as-template
          bookmark in the input's corner, in the same icon-button style, where
          it is visible without opening a menu first. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="composer-capability-menu">
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
        onChange={(ids) => setEphemeralSkillIds(ids, session?.id ?? null)}
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
    placement = "docked",
  },
  ref
) {
  const tCommands = useTranslations("chat.composer.commands")
  const tShell = useTranslations("chat.composer.shell")
  const tMemory = useTranslations("chat.composer.memory")
  const tAttach = useTranslations("chat.composer.attachments")
  // ADR-0131 relay failures (no paired host / host predates the relay) are
  // reported here rather than thrown at the user as a stack trace.
  const tInbox = useTranslations("inbox")
  const tWebSearch = useTranslations("webSearchToggle")
  const tDraftReview = useTranslations("chat.composer.draftReview")
  const composerBehavior = useSettingsStore((s) => s.settings?.composerBehavior)
  const stylePack = useSettingsStore((s) => s.settings?.stylePack)
  const isMobileShell = usePlatform() === "mobile"
  // One resolver owns pack default ← preset ← overrides ← mobile floors, so the
  // box never has to reason about any of it. `classic` (the default under the
  // Soft pack) resolves to today's exact geometry and emits no variables at
  // all. The pack only supplies the DEFAULT: an explicit skin choice still wins
  // (ADR-0148).
  const packSkin = resolveStylePack(stylePack).composerSkin
  const skin = useMemo(
    () => resolveComposerSkin(composerBehavior, { isMobile: isMobileShell, packSkin }),
    [composerBehavior, isMobileShell, packSkin]
  )
  const compactLayout = skin.compactLayout
  // `compactLayout` (the legacy desktop setting) has always put the row inside
  // the box; a skin can now ask for the same thing without it. `expanded` is
  // NOT in-box despite not being `detached` — it needs the full pane width.
  const toolbarInBox = toolbarSitsInBox(skin.toolbarLayout) || compactLayout
  const focusedStatus = useChatStore((s) => s.status)
  const status = paneStatus ?? focusedStatus
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  // Keyed by THIS composer's session, not by focus: in split view the
  // unfocused pane echoed its slash-command results into the other pane's
  // transcript, and those echoes are persisted messages.
  const appendMessageToSession = useChatStore((s) => s.appendMessageToSession)
  const clearReferencedPaths = useChatStore((s) => s.clearReferencedPaths)
  const clearCitedRefs = useChatStore((s) => s.clearCitedRefs)
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
      appendMessageToSession(session?.id ?? null, {
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "system",
        parts: parts as UIMessage["parts"],
      })
    },
    [appendMessageToSession, session?.id]
  )

  const handleSlashCommand = useCallback(
    async (cmd: SlashCommand, args: string): Promise<boolean> => {
      if (cmd.handler) {
        const ctx: SlashContext = {
          args,
          activeSessionId: session?.id ?? null,
          chatStatus: status,
          // Read AND written against this composer's conversation. The mode
          // cycle (`lib/slash-commands/builtin.ts`) reads this value and hands
          // it straight back, so a focused-projection read here made an
          // unfocused pane silently cycle the pane beside it — and that mode
          // reaches the model through `resolveSendOptions`.
          currentPermissionMode: selectComposerPermissionMode(
            useChatStore.getState(),
            session?.id ?? null
          ),
          startNewSession: onStartNewSession,
          openSettings: onOpenSettings,
          setPermissionMode: (mode) => setPermissionMode(mode, session?.id ?? null),
          pushSystemMessage,
        }
        try {
          await cmd.handler(ctx)
          // Registered command names only — never the argument string, which
          // is free user text.
          void trackEvent("app.command.executed", {
            command: cmd.name,
            kind: "action",
            outcome: "succeeded",
          })
        } catch (err) {
          loggers.chat.error("slash command failed", err, {
            command: cmd.name,
            sessionId: session?.id,
          })
          void trackEvent("app.command.executed", {
            command: cmd.name,
            kind: "action",
            outcome: "failed",
          })
          toast.error(err instanceof Error ? err.message : tCommands("failed"))
        }
        return true
      }
      if (cmd.template) {
        void trackEvent("app.command.executed", {
          command: cmd.name,
          kind: "template",
          outcome: "succeeded",
        })
        return true
      }
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
      precomputed?: ReadonlyMap<string, ExtractedAttachment>,
      templateRun?: ChatTemplateRun | null
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
          // ADR-0131: one shell-agnostic call. On a connector host this is
          // the same `enqueueGoverned(source: "manual")` + `messages` write it
          // always was; on a phone / web companion / desktop driving a remote
          // host it relays through the durable queue instead. The composer no
          // longer knows (or needs to know) which.
          try {
            await sendManualReply({
              adapterId,
              conversationKey,
              sessionId: session.id,
              conversationRef,
              text: trimmed,
              label: session.title ?? conversationKey,
            })
          } catch (error) {
            if (error instanceof InboxWriteUnavailableError) {
              toast.error(tInbox("relay.sendFailed"))
              return true
            }
            throw error
          }
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
      // THIS composer's conversation, matching where `WebSearchToggle` writes
      // it. The bare projection is the focused pane, so an unfocused pane's
      // armed toggle was never consumed (and never cleared, so it stayed lit)
      // while a send from the focused pane ran the search it had armed.
      const webOn = selectComposerWebSearchOn(useChatStore.getState(), session?.id ?? null)
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
        useChatStore.getState().setWebSearchOnForNextSend(false, session?.id ?? null)
      }

      // ── Context selections ──────────────────────────────────────────
      // Prepend the selected material + comment as context, and record the
      // edit target so the assistant reply routes into a per-hunk review
      // proposal against the targeted artifact. The first selection wins; the
      // rest contribute context only. That is now stated in the UI — the lead
      // chip carries an "edit target" badge and the others promote on click
      // (`artifact-selection-chips.tsx`) — where it used to be a `debug` log
      // nobody would ever see.
      // This pane's staged material, matching the chips that display it and the
      // `clearContextSelections(session?.id)` below. Reading the focused
      // projection here sent the OTHER conversation's file and artifact
      // excerpts in this turn — and cleared selections that were never used.
      const contextSelections = selectComposerContextSelections(
        useChatStore.getState(),
        session?.id ?? null
      )
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
      await onSend(content, attachmentResult.manifest, templateRun)
      clearReferencedPaths(session?.id ?? null)
      clearContextSelections(session?.id ?? null)
      // Same lifetime as the chips they describe: the citations rode exactly
      // this message. Cleared AFTER `onSend` so the controller has already read
      // them into `metadata.mentions`.
      clearCitedRefs(session?.id ?? null)
      useArtifactStore.getState().consumeReviewReceipts(sentReceipts)
      return true
    },
    [
      onSend,
      clearReferencedPaths,
      clearCitedRefs,
      clearContextSelections,
      pushSystemMessage,
      tAttach,
      tInbox,
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
  // Both draft actions route through the ADR-0131 facade so the phone's
  // reviewer and this dialog share one code path (and one idempotency key
  // derived from the draft id — a retried approval can never send twice).
  const handleApproveDraft = useCallback(
    async (draft: ConnectorDraftRow, segments?: MessageSegment[]) => {
      const binding = session?.platformBinding
      try {
        await approveInboxDraft(draft, {
          segments,
          ...(binding ? { binding } : {}),
          label: session?.title ?? draft.conversationKey,
        })
      } catch (error) {
        if (error instanceof InboxWriteUnavailableError) {
          toast.error(tInbox("relay.sendFailed"))
          return
        }
        throw error
      }
      setPendingDrafts((prev) => prev.filter((d) => d.id !== draft.id))
    },
    // `session` whole, not its two fields: the React Compiler infers the
    // object here and refuses to preserve a narrower manual dep list.
    [session, tInbox]
  )

  const handleRejectDraft = useCallback(
    async (draft: ConnectorDraftRow) => {
      try {
        await rejectInboxDraft(draft)
      } catch (error) {
        if (error instanceof InboxWriteUnavailableError) {
          toast.error(tInbox("relay.sendFailed"))
          return
        }
        throw error
      }
      setPendingDrafts((prev) => prev.filter((d) => d.id !== draft.id))
    },
    [tInbox]
  )

  return (
    <div
      // `composer-scrim` (app/globals.css §4d) owns the fade from the message
      // list into the input box. It replaces a Tailwind gradient +
      // `data-tonality="glass"` pair that could not compose: the tonality rules
      // swap `background-color`, and the gradient is a `background-image`, so
      // the opaque slab won and the composer stopped matching the message area
      // as soon as a wallpaper was active.
      className={cn(
        "@container/composer shrink-0",
        // Docked: the scrim fades the message list into the box, and the top
        // padding separates them. In the hero there is no list above — the
        // scrim would paint a gradient across the middle of an empty page, and
        // the dock padding would push the box off the vertical centre.
        placement === "docked" && "composer-scrim pb-3 pt-5 sm:pb-4 sm:pt-6"
      )}
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
              onOpenSettings={onOpenSettings}
              handleRef={ref}
              pendingDraftCount={pendingDrafts.length}
              mentionMode={mentionMode}
              mentionables={mentionables}
              placeholder={placeholder}
              mobileMentionMembers={mobileMentionMembers}
              workflowMention={workflowMention}
              compactLayout={compactLayout}
              skin={skin}
              toolbar={
                // The skin decides WHERE the status row sits. `detached` keeps
                // it below the box (today's desktop default); every other
                // arrangement puts it inside, and the toolbar itself decides
                // how much of the roster is spelled out vs. folded.
                toolbarInBox ? (
                  <BottomToolbar
                    session={session ?? null}
                    status={status}
                    variant={skin.toolbarLayout === "detached" ? "embedded" : skin.toolbarLayout}
                    onOpenProviderSettings={() => onOpenSettings("api-key")}
                  />
                ) : null
              }
            />
            {toolbarInBox ? null : (
              <BottomToolbar
                session={session ?? null}
                status={status}
                onOpenProviderSettings={() => onOpenSettings("api-key")}
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
