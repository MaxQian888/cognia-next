"use client"

/**
 * The composer's input box: the bordered surface holding the attach cluster,
 * the textarea (with its chip + ghost overlays), an optional embedded toolbar,
 * and the send/stop button.
 *
 * Extracted from `composer.tsx` as a PRESENTATIONAL component — it reads no
 * store and owns no state, so every visual arrangement it can take is a
 * function of its props alone. That is the point: this box is the surface a
 * composer skin governs, and a skin has to be previewable in Storybook without
 * standing up the ~1400 lines of state machine that feed it.
 *
 * Deliberately NOT included: the bands stacked above the box (attachments,
 * context chips, goal/loop/plan banners) and the popovers below it. Those are
 * not skin-controlled, so pulling them in would widen the prop surface without
 * widening what the box can express.
 */

import type { ChangeEvent, ClipboardEvent, DragEvent, ReactNode, RefObject } from "react"
import { AnimatePresence, motion, type Transition } from "motion/react"
import { ArrowUpIcon, BookmarkPlusIcon, EyeIcon, EyeOffIcon, SquareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "sonner"
import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"
import { cn } from "@/lib/utils"
import type { PermissionMode } from "@/stores/chat/chat-store"

import {
  ComposerChipOverlay,
  OVERLAY_FONT_SIZE,
  TEXTAREA_TYPOGRAPHY,
  type ParamPillState,
} from "../composer-chip-overlay"
import type { RichSegment } from "@/lib/slash-commands/parse-segments"
import type { ShellDiagnostic } from "@/lib/shell-intelligence/types"
import { ComposerGhostText } from "./composer-ghost-text"
import { ShellDiagnosticOverlay } from "./shell-diagnostic-overlay"
import { CharCounter } from "./char-counter"
import { DragOverlay } from "./drag-overlay"
import { MobileGhostAccept } from "./mobile-ghost-accept"
import { ComposerAttachMenu } from "./attach-menu"
import { ComposerPlusMenu } from "@/components/mobile/chat/composer-plus-menu"
import type { ComposerAttachment } from "@/components/mobile/chat/composer-attachment"
import type { SendButtonState } from "./send-button-mode"
import { composerSkinVars, type ResolvedComposerSkin } from "@/lib/chat/composer-skin"

/**
 * Shared by every skin: layout mechanics, not looks.
 *
 * Claude-style stack on every platform when the container is narrow: the
 * textarea fills the first row (w-full forces the wrap), the attach + send
 * clusters share ONE bottom row. On web/desktop the children's @sm/composer:*
 * classes reset order/width so the box re-forms the single-row
 * [attach | textarea | send] layout; the flex-1 textarea (basis-0) then
 * prevents any further wrapping. Mobile (Capacitor) keeps the stack at every
 * width.
 */
const BOX_BASE =
  "relative flex flex-wrap items-end border shadow-sm transition-[border-color,box-shadow,background-color] duration-200 motion-reduce:transition-none focus-within:border-primary/40 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/15"

/** Verbatim from the pre-skin composer. Pinned by the parity test. */
const CLASSIC_BOX = "gap-2 rounded-2xl border-input/60 bg-background/70 px-2 py-2"

/** Every other skin drives its geometry from the inline custom properties. */
const SKIN_BOX =
  "gap-[var(--composer-gap)] rounded-[var(--composer-radius)] border-input/60 bg-background/70 px-[var(--composer-pad-x)] py-[var(--composer-pad-y)]"

export interface ComposerBoxProps {
  /** Resolved skin — geometry + which toolbar arrangement to use. */
  skin: ResolvedComposerSkin
  /** Stacked layout at every width (mobile, or the compact-layout setting). */
  compactLayout: boolean
  isMobile: boolean
  disabled?: boolean
  /** Amber-tints the surface so a read-only plan turn is unmistakable.
   *  Null before the session's mode has hydrated. */
  permissionMode: PermissionMode | null
  placeholder?: string

  // ── text ────────────────────────────────────────────────────────────────
  textInput: { value: string; setInput: (next: string) => void }
  textareaRef: RefObject<HTMLTextAreaElement | null>
  chipOverlayRef: RefObject<HTMLDivElement | null>
  ghostOverlayRef: RefObject<HTMLDivElement | null>
  /** Scroll mirror for the `!`-mode diagnostic underlines. */
  shellDiagnosticOverlayRef: RefObject<HTMLDivElement | null>
  /**
   * `!`-mode problems, with offsets already mapped into the TEXTAREA's
   * coordinates. Empty (the overwhelmingly common case) paints nothing.
   */
  shellDiagnostics?: readonly ShellDiagnostic[]
  /** Accessible name for the diagnostics status region. */
  shellDiagnosticsLabel?: string
  overlaySegments: RichSegment[]
  maxHeightRem: number
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void
  onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void
  /**
   * Pointer release inside the text. Distinct from `onSelect`, which also fires
   * for arrow keys — a panel that opened every time the caret drifted through a
   * `{{parameter}}` would flash at someone simply reading back what they wrote.
   */
  onMouseUp?: (e: React.MouseEvent<HTMLTextAreaElement>) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
  /** Settle any half-typed URL into its folded label when focus leaves. */
  onBlur?: () => void
  /** Expand folded links on the way to the clipboard. */
  onCopy?: (e: ClipboardEvent<HTMLTextAreaElement>) => void
  onCut?: (e: ClipboardEvent<HTMLTextAreaElement>) => void
  /**
   * True while an IME composition is in flight. The overlay cannot show the
   * candidate text (it only ever sees the committed value), so for those few
   * keystrokes the textarea paints its own glyphs again — see the layering note
   * on the textarea below.
   */
  isComposing?: boolean
  /** How to paint each `{{parameter}}` chip. See `ComposerChipOverlay`. */
  paramState?: (paramId: string) => ParamPillState
  /**
   * Read-only rendering of the message with its parameters substituted, and the
   * control that toggles it.
   *
   * Null when the message has no parameters — the toggle would show a preview
   * identical to what is already on screen. This is the answer to the one real
   * cost of keeping the token in the text: while editing you never see the
   * finished sentence, because the chip overlay must mirror the textarea
   * character for character.
   */
  preview?: { on: boolean; text: string; toggle: () => void } | null
  /**
   * Turn what is in the box into a saved template. Null when there is nothing
   * to save — an empty message, or a surface (mobile, a workflow composer)
   * where the template library is not reachable anyway.
   */
  saveAsTemplate?: (() => void) | null
  /**
   * The prompt-enhance wand, or null when the feature is off / there is
   * nothing to rewrite. Rendered as a third floating corner control beside
   * the save-as-template bookmark — the caller styles the button, this box
   * owns only where it sits and how much room the text gives up for it.
   */
  enhance?: ReactNode

  // ── inline completion ───────────────────────────────────────────────────
  ghost: {
    ghost: string
    candidates: readonly unknown[]
    index: number
    dismiss: () => void
    /** True when the agent tier is reachable, i.e. its key is worth advertising. */
    manualAvailable?: boolean
    /** True while the requested agent turn is running. */
    manualPending?: boolean
  }
  ghostSourceLabel?: string
  acceptGhost: () => void

  // ── attachment intake ───────────────────────────────────────────────────
  fileInputRef: RefObject<HTMLInputElement | null>
  attachmentAccept: string
  onFilePick: (e: ChangeEvent<HTMLInputElement>) => void
  openFileDialog: () => void
  onPlusAttach: (attachment: ComposerAttachment) => void
  captureSmartSnapshot: (options?: { delayMs?: number; switchPrompt?: boolean }) => void
  smartSnapshotPending: boolean
  capabilityMenu: ReactNode
  /** Type on the user's behalf — the `+` menu's namespace entries use it. */
  onInsertText?: (text: string) => void
  /** Route to external-services settings from the `+` menu. */
  onOpenExternalServices?: () => void
  isDragging: boolean
  onDragEnter: (e: DragEvent<HTMLDivElement>) => void
  onDragOver: (e: DragEvent<HTMLDivElement>) => void
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void

  // ── send ────────────────────────────────────────────────────────────────
  sendButton: SendButtonState
  sendIconTransition: Transition
  isPreparingAttachments: boolean
  submit: () => void
  onStop: () => void

  /** Embedded status toolbar (compact layouts render it inside the box). */
  toolbar?: ReactNode
  /** Voice + append bridges — they subscribe to stores, so they stay outside. */
  bridges?: ReactNode

  t: (key: string, values?: Record<string, string | number | Date>) => string
  tAttach: (key: string, values?: Record<string, string | number | Date>) => string
}

export function ComposerBox({
  skin,
  compactLayout,
  isMobile,
  disabled,
  permissionMode,
  placeholder,
  textInput,
  textareaRef,
  chipOverlayRef,
  ghostOverlayRef,
  shellDiagnosticOverlayRef,
  shellDiagnostics,
  shellDiagnosticsLabel,
  overlaySegments,
  maxHeightRem,
  onChange,
  onKeyDown,
  onPaste,
  onSelect,
  onMouseUp,
  onCompositionStart,
  onCompositionEnd,
  onBlur,
  onCopy,
  onCut,
  isComposing,
  paramState,
  preview,
  saveAsTemplate,
  enhance,
  ghost,
  ghostSourceLabel,
  acceptGhost,
  fileInputRef,
  attachmentAccept,
  onFilePick,
  openFileDialog,
  onPlusAttach,
  captureSmartSnapshot,
  smartSnapshotPending,
  capabilityMenu,
  onInsertText,
  onOpenExternalServices,
  isDragging,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  sendButton,
  sendIconTransition,
  isPreparingAttachments,
  submit,
  onStop,
  toolbar,
  bridges,
  t,
  tAttach,
}: ComposerBoxProps) {
  // Re-sync the overlays' scroll mirror to whatever the textarea's scrollTop is
  // NOW, every time the value changes.
  //
  // The mirror below is an imperative `transform` written from the textarea's
  // `scroll` event, and React never manages that style key, so it survives
  // re-renders. It also survives the value being REPLACED — send clears the
  // box, a draft restore or a session switch swaps it — which resets scrollTop
  // to 0 without necessarily emitting a `scroll` event. The chip overlay is now
  // the only layer painting the text (the textarea's glyphs are transparent),
  // so a stale offset does not misplace a pill background any more: it draws
  // the whole message outside its clipped box and the composer reads as empty.
  useIsomorphicLayoutEffect(() => {
    const offset = `translateY(${-(textareaRef.current?.scrollTop ?? 0)}px)`
    const chip = chipOverlayRef.current
    if (chip) chip.style.transform = offset
    const ghostEl = ghostOverlayRef.current
    if (ghostEl) ghostEl.style.transform = offset
    const diagnosticEl = shellDiagnosticOverlayRef.current
    if (diagnosticEl) diagnosticEl.style.transform = offset
    // `shellDiagnostics` is a dependency because the diagnostic layer MOUNTS on
    // it, and it turns non-empty on the idle timer — 200ms after the last
    // keystroke, with `textInput.value` unchanged. Keying this effect on the
    // value alone left that first paint with no offset at all, so on a `!` line
    // long enough to scroll, every underline sat `scrollTop` px above its word
    // until the next character was typed.
  }, [
    textInput.value,
    shellDiagnostics,
    textareaRef,
    chipOverlayRef,
    ghostOverlayRef,
    shellDiagnosticOverlayRef,
  ])

  // The floating corner controls fill right-to-left from the text's trailing
  // edge: preview toggle, then the bookmark, then the wand. Each is 24px in a
  // 24px step, so the slots are fixed classes rather than arithmetic — and the
  // count decides how much trailing room the text has to give up, which every
  // layer painting that text has to agree on (see `padEndClass`).
  const cornerSlots = ["end-1", "end-7", "end-13"] as const
  let takenSlots = 0
  const previewSlot = preview ? cornerSlots[takenSlots++] : null
  const saveSlot = saveAsTemplate ? cornerSlots[takenSlots++] : null
  const enhanceSlot = enhance ? cornerSlots[takenSlots++] : null
  // `pe-10` is the historic reservation for one control. Two and three need
  // their own, or the first line of the message runs under the buttons.
  const padEndClass = takenSlots >= 3 ? "pe-20" : takenSlots === 2 ? "pe-14" : "pe-10"

  return (
    <div
      className={cn(
        BOX_BASE,
        // `classic` renders the literals it always rendered — not the same
        // numbers re-expressed as variables. That is what makes "today's
        // composer is unchanged" true by construction rather than by anyone
        // getting a rem→px conversion right. See `composer-skin.ts`.
        skin.isClassic ? CLASSIC_BOX : SKIN_BOX,
        skin.isClassic &&
          compactLayout &&
          "gap-1.5 rounded-[1.75rem] border-border/70 bg-background/85 px-3 py-2.5 shadow-md",
        // Plan mode: amber tint on the input surface (with the banner above)
        // so the read-only state is unmistakable (Claude Code parity).
        permissionMode === "plan" &&
          "border-amber-500/50 focus-within:border-amber-500/70 focus-within:ring-amber-500/15"
      )}
      style={composerSkinVars(skin)}
      data-composer-skin={skin.id}
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
        accept={attachmentAccept}
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
          // An in-box layout puts this cluster on its OWN line, shared with the
          // status toolbar and the send button. Those three are 32 / 28 / 32
          // tall, so the box's `items-end` lined up their bottoms and left the
          // icons riding ~4px above the chip text beside them. Centre them on
          // the line instead — its height is the tallest child either way.
          compactLayout && "self-center",
          // ...and pull the cluster back by the glyph's own inset (a 16px icon
          // in a 32px button) so the "+" sits on the same left edge as the
          // first character of the message above it (the textarea's `px-1`).
          compactLayout && !isMobile && "-ms-1",
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
            fileAccept={attachmentAccept}
            onAttach={onPlusAttach}
            onError={(_code, message) => toast.error(message)}
            capabilities={capabilityMenu}
            {...(onInsertText ? { onInsert: onInsertText } : {})}
            {...(onOpenExternalServices ? { onOpenExternalServices } : {})}
          />
        ) : (
          // One paperclip for both attachment models: files inline, folders
          // as references. Links need no button — typed or pasted URLs are
          // recognised in the text and chipped by `ContextChipBar`.
          <ComposerAttachMenu
            disabled={disabled}
            onPickFiles={openFileDialog}
            onSmartSnapshot={() => void captureSmartSnapshot({ delayMs: 2200, switchPrompt: true })}
            smartSnapshotPending={smartSnapshotPending}
            capabilities={capabilityMenu}
            {...(onInsertText ? { onInsert: onInsertText } : {})}
            {...(onOpenExternalServices ? { onOpenExternalServices } : {})}
            // One control size for the whole action row: the voice buttons
            // beside it are already 32, and a 36px paperclip made the left end
            // of the row read as a different scale from everything else on it.
            className={compactLayout ? "size-8" : undefined}
          />
        )}

        {/* Voice stays outside the menu: it's an input method (speech →
            text), not a way to produce an attachment. */}
        {bridges}
      </div>

      <div
        className={cn(
          "relative order-1 w-full min-w-0",
          !isMobile &&
            !compactLayout &&
            "@sm/composer:order-none @sm/composer:w-auto @sm/composer:flex-1 @sm/composer:self-center"
        )}
      >
        {preview?.on ? (
          // Same box, same typography, same padding — so it reads as the input
          // showing you the finished sentence rather than as a separate panel.
          <div
            className={cn(
              "block min-h-9 w-full break-words whitespace-pre-wrap",
              compactLayout && "min-h-14 py-1.5",
              skin.mono && "font-mono",
              TEXTAREA_TYPOGRAPHY,
              padEndClass
            )}
            data-testid="composer-param-preview"
            // Same size as the textarea it stands in for, which on a coarse
            // pointer is the zoom guard's 16px and not the `text-sm` above —
            // otherwise toggling the preview reflowed the sentence.
            style={{
              fontSize: OVERLAY_FONT_SIZE,
              maxHeight: `${maxHeightRem}rem`,
              overflowY: "auto",
            }}
          >
            {preview.text}
          </div>
        ) : null}
        <ComposerChipOverlay
          ref={chipOverlayRef}
          value={textInput.value}
          segments={overlaySegments}
          paramState={paramState}
          // Same family as the textarea, or the pills drift out from under the
          // glyphs on a mono skin.
          mono={skin.mono}
          padEndClass={padEndClass}
          // The overlay IS the visible text (see the textarea below), so it has
          // to stand down whenever something else is painting the same words:
          // an IME composition (the textarea takes its glyphs back) and the
          // parameter preview (which renders the substituted sentence in its
          // own box). Painting anyway is exactly the doubled, overlapping text
          // that preview mode showed.
          hidden={isComposing || preview?.on === true}
        />
        {shellDiagnostics && shellDiagnostics.length > 0 ? (
          <ShellDiagnosticOverlay
            ref={shellDiagnosticOverlayRef}
            value={textInput.value}
            diagnostics={shellDiagnostics}
            statusLabel={shellDiagnosticsLabel ?? ""}
            // Same family and trailing inset as the textarea, for the same
            // reason the chip layer takes them: a different wrap width puts
            // every underline under the wrong word.
            mono={skin.mono}
            padEndClass={padEndClass}
            hidden={isComposing || preview?.on === true}
          />
        ) : null}
        <ComposerGhostText
          ref={ghostOverlayRef}
          value={textInput.value}
          // Same reason as the chip overlay above: nothing may paint over the
          // preview's substituted text.
          ghost={preview?.on ? "" : ghost.ghost}
          mono={skin.mono}
          padEndClass={padEndClass}
          sourceLabel={ghostSourceLabel}
          // Position + cycle hint only make sense with an alternative to
          // move to, and Alt+] is unreachable on touch.
          positionLabel={
            ghost.candidates.length > 1
              ? t("ghostPosition", {
                  index: ghost.index + 1,
                  total: ghost.candidates.length,
                })
              : undefined
          }
          cycleHint={!isMobile && ghost.candidates.length > 1 ? t("ghostCycleHint") : undefined}
          // The "Tab" hint is meaningless on touch — mobile gets the tappable
          // accept/dismiss control below instead.
          acceptHint={isMobile ? undefined : t("ghostAcceptHint")}
          // Advertise the agent tier's key only where it can be pressed (not
          // touch) and only once there is a draft worth continuing — over an
          // empty box it is noise, and the tier refuses a too-short draft
          // anyway.
          manualHint={
            !isMobile && ghost.manualAvailable && textInput.value.trim().length > 0
              ? ghost.manualPending
                ? t("ghostManualPending")
                : t("ghostManualHint")
              : undefined
          }
        />
        {/*
          Layering: the textarea keeps the caret, the selection, the scroll and
          every native input behaviour — but its GLYPHS are transparent and the
          chip overlay above paints them instead. That is what lets a link read
          as blue underlined text: a `<textarea>` has exactly one colour, so
          per-token styling is impossible inside it.

          Two details make the swap safe. `caret-foreground` is explicit because
          the caret otherwise inherits `color` and would vanish with the text.
          And during an IME composition the textarea paints its own glyphs again
          (`isComposing`): the overlay renders the committed value, which does
          not include the candidate text being composed.
        */}
        <Textarea
          aria-label={t("ariaMessage")}
          className={cn(
            "field-sizing-content relative z-[1] block min-h-9 w-full resize-none break-words overflow-y-auto overscroll-contain border-0 bg-transparent shadow-none outline-none ring-0 [scrollbar-width:none] placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 [&::-webkit-scrollbar]:hidden",
            !isComposing && "text-transparent caret-foreground",
            // Hidden, never unmounted: unmounting would drop focus, the caret,
            // the scroll position and every ref the composer holds on it.
            preview?.on && "hidden",
            compactLayout && "min-h-14 py-1.5",
            !compactLayout && textInput.value.length === 0 && "h-9 overflow-hidden",
            // A skin may ask for the code font; classic never does.
            skin.mono && "font-mono",
            TEXTAREA_TYPOGRAPHY,
            padEndClass
          )}
          disabled={disabled}
          name="message"
          onChange={onChange}
          onBlur={onBlur}
          onCompositionEnd={onCompositionEnd}
          onCompositionStart={onCompositionStart}
          onCopy={onCopy}
          onCut={onCut}
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
            const diagnosticEl = shellDiagnosticOverlayRef.current
            if (diagnosticEl) diagnosticEl.style.transform = offset
          }}
          onMouseUp={onMouseUp}
          onSelect={onSelect}
          placeholder={disabled ? t("placeholderDisabled") : (placeholder ?? t("placeholder"))}
          ref={textareaRef}
          rows={1}
          style={{ maxHeight: `${maxHeightRem}rem` }}
          value={textInput.value}
        />
        {saveAsTemplate ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("saveTemplate.trigger")}
                data-testid="composer-save-as-template"
                // Above BOTH the textarea (`z-[1]`) and the chip overlay
                // (`z-[2]`). A positioned element with `z-index: auto` paints
                // below a sibling with a positive one, and hit-testing follows
                // paint order — so without this the textarea swallowed every
                // click aimed here, and the hover never lit up either.
                className={cn(
                  "absolute top-0 z-[3] size-6 text-muted-foreground/60 hover:bg-muted hover:text-foreground",
                  // Slots are claimed in order, so the bookmark only sits one
                  // step in when there is actually a preview toggle at the edge
                  // — holding an empty place left it hanging off nothing.
                  saveSlot
                )}
                onClick={saveAsTemplate}
              >
                <BookmarkPlusIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t("saveTemplate.trigger")}</TooltipContent>
          </Tooltip>
        ) : null}
        {preview ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={
                  preview.on ? t("templateParams.previewOff") : t("templateParams.previewOn")
                }
                aria-pressed={preview.on}
                data-testid="composer-param-preview-toggle"
                className={cn(
                  "absolute top-0 z-[3] size-6 text-muted-foreground/60 hover:bg-muted hover:text-foreground aria-pressed:text-foreground",
                  previewSlot
                )}
                onClick={preview.toggle}
              >
                {preview.on ? (
                  <EyeOffIcon className="size-3.5" />
                ) : (
                  <EyeIcon className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {preview.on ? t("templateParams.previewOff") : t("templateParams.previewOn")}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {enhance ? (
          <span className={cn("absolute top-0 z-[3] flex items-center", enhanceSlot)}>
            {enhance}
          </span>
        ) : null}
        <CharCounter />
        <MobileGhostAccept
          visible={isMobile && !!ghost.ghost}
          onAccept={acceptGhost}
          onDismiss={ghost.dismiss}
        />
      </div>

      {toolbar ? <div className="order-2 min-w-0 flex-1 self-center">{toolbar}</div> : null}

      <div
        className={cn(
          "order-3 ms-auto flex shrink-0 items-center",
          compactLayout && "self-center",
          !isMobile && !compactLayout && "@sm/composer:order-none @sm/composer:ms-0"
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            {sendButton.mode === "draft" ? (
              <Button
                aria-label={t("editDraftAria")}
                className={cn(
                  "h-9 px-3 text-xs",
                  skin.isClassic ? "rounded-full" : "rounded-[var(--composer-inner-radius)]"
                )}
                disabled={sendButton.disabled}
                onClick={() => void submit()}
                type="button"
                variant={sendButton.variant}
              >
                {t("editDraftTooltip")}
              </Button>
            ) : (
              <Button
                aria-label={
                  sendButton.mode === "stop"
                    ? t("ariaStop")
                    : sendButton.mode === "busy"
                      ? isPreparingAttachments
                        ? tAttach("preparing")
                        : t("ariaSending")
                      : sendButton.queues
                        ? t("ariaSendSteer")
                        : t("ariaSend")
                }
                className={cn(
                  "transition-transform duration-200 ease-out active:scale-90 disabled:scale-100",
                  // Classic keeps its literals; every other skin sizes and
                  // shapes the button from its own resolved tokens (already
                  // floored to the touch minimum on mobile by the resolver).
                  skin.isClassic
                    ? "size-9 rounded-full"
                    : "size-[var(--composer-send-size)] rounded-[var(--composer-inner-radius)]",
                  // Mobile: 44px minimum tap target (primary send/stop action).
                  isMobile && "touch-target"
                )}
                disabled={sendButton.disabled}
                onClick={() => (sendButton.mode === "stop" ? void onStop() : void submit())}
                size="icon"
                type="button"
                variant={sendButton.variant}
              >
                {/* Icon swap genuinely cross-fades + zooms on each state
                    change (send → running → stop): AnimatePresence keeps the
                    outgoing icon mounted through its exit while the incoming
                    one fades in, keyed by state. `queues` deliberately does
                    NOT enter the key — a follow-up still sends with an arrow,
                    so typing mid-turn must not re-run the zoom. Honors
                    reduced motion. */}
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={sendButton.mode}
                    className="inline-flex"
                    initial={{ opacity: 0, scale: 0.75 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.75 }}
                    transition={sendIconTransition}
                  >
                    {sendButton.mode === "stop" ? (
                      <SquareIcon className="size-4" />
                    ) : sendButton.mode === "busy" ? (
                      <Spinner className="size-4" />
                    ) : (
                      <ArrowUpIcon className="size-4" />
                    )}
                  </motion.span>
                </AnimatePresence>
              </Button>
            )}
          </TooltipTrigger>
          <TooltipContent>
            {sendButton.mode === "draft"
              ? t("editDraftTooltip")
              : sendButton.mode === "stop"
                ? t("stopTooltip")
                : sendButton.queues
                  ? t("sendSteerTooltip")
                  : t("sendTooltip")}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
