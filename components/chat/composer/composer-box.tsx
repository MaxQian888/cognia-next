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
import { ArrowUpIcon, Loader2Icon, SquareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import type { PermissionMode } from "@/stores/chat/chat-store"

import { ComposerChipOverlay, TEXTAREA_TYPOGRAPHY } from "../composer-chip-overlay"
import type { RichSegment } from "@/lib/slash-commands/parse-segments"
import { ComposerGhostText } from "./composer-ghost-text"
import { CharCounter } from "./char-counter"
import { DragOverlay } from "./drag-overlay"
import { MobileGhostAccept } from "./mobile-ghost-accept"
import { ComposerAttachMenu } from "./attach-menu"
import { ComposerPlusMenu } from "@/components/mobile/chat/composer-plus-menu"
import type { ComposerAttachment } from "@/components/mobile/chat/composer-plus-menu"
import type { SendButtonState } from "./send-button-mode"

export interface ComposerBoxProps {
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
  overlaySegments: RichSegment[]
  maxHeightRem: number
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void
  onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void

  // ── inline completion ───────────────────────────────────────────────────
  ghost: { ghost: string; candidates: readonly unknown[]; index: number; dismiss: () => void }
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
  compactLayout,
  isMobile,
  disabled,
  permissionMode,
  placeholder,
  textInput,
  textareaRef,
  chipOverlayRef,
  ghostOverlayRef,
  overlaySegments,
  maxHeightRem,
  onChange,
  onKeyDown,
  onPaste,
  onSelect,
  onCompositionStart,
  onCompositionEnd,
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
  return (
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
        <ComposerChipOverlay
          ref={chipOverlayRef}
          value={textInput.value}
          segments={overlaySegments}
        />
        <ComposerGhostText
          ref={ghostOverlayRef}
          value={textInput.value}
          ghost={ghost.ghost}
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
        />
        <Textarea
          aria-label={t("ariaMessage")}
          className={cn(
            "field-sizing-content relative z-[1] block min-h-9 w-full resize-none break-words overflow-y-auto overscroll-contain border-0 bg-transparent shadow-none outline-none ring-0 [scrollbar-width:none] placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 [&::-webkit-scrollbar]:hidden",
            compactLayout && "min-h-14 py-1.5",
            !compactLayout && textInput.value.length === 0 && "h-9 overflow-hidden",
            TEXTAREA_TYPOGRAPHY
          )}
          disabled={disabled}
          name="message"
          onChange={onChange}
          onCompositionEnd={onCompositionEnd}
          onCompositionStart={onCompositionStart}
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
          placeholder={disabled ? t("placeholderDisabled") : (placeholder ?? t("placeholder"))}
          ref={textareaRef}
          rows={1}
          style={{ maxHeight: `${maxHeightRem}rem` }}
          value={textInput.value}
        />
        <CharCounter />
        <MobileGhostAccept
          visible={isMobile && !!ghost.ghost}
          onAccept={acceptGhost}
          onDismiss={ghost.dismiss}
        />
      </div>

      {toolbar ? <div className="order-2 min-w-0 flex-1 self-end">{toolbar}</div> : null}

      <div
        className={cn(
          "order-3 ms-auto flex shrink-0 items-center",
          !isMobile && !compactLayout && "@sm/composer:order-none @sm/composer:ms-0"
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            {sendButton.mode === "draft" ? (
              <Button
                aria-label={t("editDraftAria")}
                className="h-9 rounded-full px-3 text-xs"
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
                  "size-9 rounded-full transition-transform duration-200 ease-out active:scale-90 disabled:scale-100",
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
