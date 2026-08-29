"use client"

import type { ReactNode } from "react"
import Image from "next/image"
import { useTranslations, useFormatter, useNow } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion"
import { Button } from "@/components/ui/button"
import {
  CodeIcon,
  FileTextIcon,
  FolderTreeIcon,
  MessageSquareTextIcon,
  PlusIcon,
  SparklesIcon,
  Settings2Icon,
  TerminalIcon,
  XIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { greetingSlot } from "@/lib/chat/greeting"
import { cn } from "@/lib/utils"

export interface StarterSample {
  /** Stable key for React + accessible test ids. */
  key: string
  title: string
  prompt: string
  icon: LucideIcon
}

/**
 * Per-surface overrides for the empty state. When a field is omitted the
 * generic chat copy / dev-tool starters are used. The workflow-editor chat
 * tab supplies workflow-specific copy + starter cards through this.
 */
export interface EmptyStateOverride {
  /** Welcome heading (defaults to the time-of-day greeting). */
  title?: string
  subtitle?: string
  /** Heading for the starter-card section (defaults to "Try a prompt"). */
  samplesHeading?: string
  /** Replace the generic dev-tool starter cards. */
  samples?: readonly StarterSample[]
}

/** Visual density of the welcome page. */
export type WelcomeStyle = "rich" | "minimal"
/** Dismissable welcome sections (persisted in `AppSettings.welcomeHidden`). */
export type WelcomeSection = "tryPrompt"

interface SampleId {
  id: "explore" | "review" | "draft" | "tests"
  icon: LucideIcon
}

const SAMPLE_IDS: SampleId[] = [
  { id: "explore", icon: FolderTreeIcon },
  { id: "review", icon: CodeIcon },
  { id: "draft", icon: FileTextIcon },
  { id: "tests", icon: TerminalIcon },
]

const MAX_RECENT = 4

export interface RecentSessionEntry {
  id: string
  title: string
  updatedAt: number
}

interface Props {
  onCreate: () => void
  /**
   * Send `prompt` as a turn. Hosts must tolerate being called with no session
   * open (the fullscreen welcome) — starting one is the host's job.
   */
  onUseSample: (prompt: string) => void
  /** When `inline` is true, render without the full-screen frame. */
  variant?: "fullscreen" | "inline"
  /** Recent sessions for the "Continue" group. Hidden when empty/omitted. */
  recentSessions?: readonly RecentSessionEntry[]
  /** Resume a recent session by id. Required for the "Continue" group. */
  onResumeSession?: (id: string) => void
  /**
   * Exemplar prompts from the active character (ADR-0030 `persona.exemplarPrompts`).
   * Rendered as quick-start chips above the generic dev-tool starters. Hidden
   * when empty/omitted (e.g. the no-session welcome).
   */
  characterSamples?: readonly string[]
  /**
   * AI-generated starter prompts (ADR — composer assistance). Rendered as
   * quick-start chips above the character / dev-tool starters. Hidden when
   * empty/omitted; the feature is opt-out via `composerAssistance.suggestions`.
   */
  aiSamples?: readonly string[]
  /**
   * Surface-specific copy / starter overrides. Lets the workflow-editor chat
   * tab show workflow-specific heading + starter cards instead of the generic
   * dev-tool ones. Each field falls back to the generic chat copy when omitted.
   */
  override?: EmptyStateOverride
  /**
   * Suppress the generic dev-tool "Try a prompt" starter cards. The mobile home
   * welcome sets this to keep the screen minimal (the desktop welcome leaves it
   * unset, so nothing changes there).
   */
  hideSamples?: boolean
  /**
   * Rendered above the greeting — the mobile home injects an active-runs card +
   * search bar here. Hidden when omitted.
   */
  headerExtraSlot?: ReactNode
  /**
   * Rendered between the composer/prompts and the sample cards — the mobile
   * home injects its customizable quick-action grid here. Hidden when omitted.
   */
  quickActionsSlot?: ReactNode
  /**
   * Usage dashboard, rendered directly under the hero. The chat pane injects
   * `<WelcomeStats />` here; it stays a slot (rather than an import) so this
   * component keeps no database dependency and surfaces with their own copy —
   * the workflow-editor chat tab — can leave it off.
   */
  statsSlot?: ReactNode
  /** New-chat execution controls shown beside the primary creation action. */
  executionControlsSlot?: ReactNode
  /**
   * A live composer, rendered directly under the greeting.
   *
   * This is the welcome screen's primary affordance when present: a user can
   * type their first message without creating a session first, the way Claude
   * and Codex both open. The chat pane supplies the real `<Composer>` (not a
   * lookalike), so attachments, slash commands and `@`-mentions all work from
   * the first keystroke.
   */
  composerSlot?: ReactNode
  /**
   * Visual density. `"rich"` (default) shows the illustrated two-column hero
   * and quiet surfaced starter cards; `"minimal"` uses a compact, media-free
   * layout. The chat pane forces `"minimal"` on mobile/narrow viewports.
   */
  welcomeStyle?: WelcomeStyle
  /**
   * When provided, an inline style switch is shown (desktop only). The chat
   * pane wires this to persist `AppSettings.welcomeStyle`.
   */
  onToggleStyle?: (next: WelcomeStyle) => void
  /** Optional display name woven into the time-of-day greeting. */
  userName?: string
  /** Persisted per-section dismissals. A truthy flag hides that section. */
  hiddenSections?: { tryPrompt?: boolean }
  /**
   * When provided, the "Try a prompt" section header shows a ✕ that calls
   * this. The chat pane persists the dismissal so the section stays hidden
   * across reloads.
   */
  onDismissSection?: (section: WelcomeSection) => void
}

const HEADING_TEXT_CLASS =
  "shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground"
/**
 * Card-less interactive surface: no border, no elevated card background — the
 * item only materialises on hover/focus so the welcome page reads as open
 * space instead of a grid of boxes.
 */
const QUIET_ITEM_CLASS =
  "rounded-xl transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"

/**
 * Section heading with a hairline rule and an optional dismiss (✕). The rule
 * is what separates groups now that the sections no longer sit inside cards.
 *
 * `actions` renders between the rule and the ✕ — the usage dashboard hangs its
 * view/range/customize controls there so every welcome section keeps one
 * heading treatment. Exported for that reuse.
 */
export function SectionHeading({
  label,
  dismissLabel,
  onDismiss,
  actions,
}: {
  label: string
  dismissLabel?: string
  onDismiss?: () => void
  /** Trailing controls, right-aligned before the dismiss affordance. */
  actions?: ReactNode
}) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <h3 className={HEADING_TEXT_CLASS}>{label}</h3>
      <span className="h-px flex-1 bg-border/60" aria-hidden />
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      {onDismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="-mr-1 size-5 shrink-0 text-muted-foreground/70 hover:text-foreground"
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      ) : null}
    </div>
  )
}

export function EmptyChatState({
  onCreate,
  onUseSample,
  variant = "fullscreen",
  recentSessions,
  onResumeSession,
  characterSamples,
  aiSamples,
  override,
  hideSamples,
  headerExtraSlot,
  quickActionsSlot,
  statsSlot,
  executionControlsSlot,
  composerSlot,
  welcomeStyle = "rich",
  onToggleStyle,
  userName,
  hiddenSections,
  onDismissSection,
}: Props) {
  const t = useTranslations("chat.empty")
  const format = useFormatter()
  // Anchor relative timestamps to a single render-time "now" so next-intl
  // doesn't fall back to an implicit current time (ENVIRONMENT_FALLBACK).
  const now = useNow()
  const reduce = useReducedMotion()

  const rich = welcomeStyle === "rich"

  const recents = (recentSessions ?? []).slice(0, MAX_RECENT)
  const showRecents = recents.length > 0 && typeof onResumeSession === "function"
  const charPrompts = (characterSamples ?? []).filter((p) => p.trim().length > 0)
  const aiPrompts = (aiSamples ?? []).filter((p) => p.trim().length > 0)

  // Surface-specific overrides fall back to the time-of-day greeting / generic
  // copy when omitted, so existing callers render unchanged.
  const trimmedName = userName?.trim()
  const baseGreeting = t(`greeting.${greetingSlot(now)}`)
  const greeting = trimmedName
    ? t("greeting.named", { greeting: baseGreeting, name: trimmedName })
    : baseGreeting
  const heading = override?.title ?? greeting
  const subheading = override?.subtitle ?? t("subtitle")
  const samplesHeading = override?.samplesHeading ?? t("sections.tryPrompt")
  const starters: readonly StarterSample[] =
    override?.samples ??
    SAMPLE_IDS.map(({ id, icon }) => ({
      key: id,
      icon,
      title: t(`samples.${id}Title`),
      prompt: t(`samples.${id}Prompt`),
    }))
  const showStarters = !hideSamples && !hiddenSections?.tryPrompt && starters.length > 0

  // Where the "New chat" action lives. The fullscreen welcome has no session,
  // so a live composer already creates one on first send — a second, louder
  // button for the same outcome is redundant (and throws away a draft). It is
  // demoted to a ghost under the composer there, and stays the hero's primary
  // action only on surfaces that render no composer at all.
  const showHeroAction = variant === "fullscreen" && !composerSlot
  const showDemotedActions = variant === "fullscreen" && !!composerSlot

  return (
    <div className="@container relative flex flex-1 flex-col overflow-x-hidden overflow-y-auto py-6 @2xl:py-10">
      {/* Inline rich/minimal switch (desktop only — the pane omits the handler
          on mobile, where the style is force-minimal). */}
      {onToggleStyle ? (
        <div className="absolute right-3 top-3 z-20 sm:right-5 sm:top-5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            onClick={() => onToggleStyle(rich ? "minimal" : "rich")}
            aria-label={t("style.toggleLabel")}
          >
            <Settings2Icon className="size-3.5" aria-hidden />
            {t(rich ? "style.minimal" : "style.rich")}
          </Button>
        </div>
      ) : null}

      <motion.div
        // Same reading column as the composer (`composer-reading-column`):
        // padding INSIDE the max-width cap, so the welcome content and the
        // composer box share one content edge at every pane width.
        className="relative z-10 m-auto flex w-full max-w-[52rem] flex-col items-center gap-8 px-3 sm:px-5 @2xl:gap-10"
        initial={reduce ? false : "initial"}
        animate="animate"
        variants={STAGGER_CONTAINER}
      >
        {/* Mobile home injects an active-runs card + search bar above the greeting. */}
        {headerExtraSlot ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            {headerExtraSlot}
          </motion.div>
        ) : null}

        {/* Greeting + composer are ONE block, not two sections: the copy is a
            label for the box, so they sit at reading distance from each other
            while the outer container's larger gap keeps the rhythm between
            this block and the sections below it. */}
        <motion.div className="flex w-full flex-col gap-4 @2xl:gap-5" variants={STAGGER_CONTAINER}>
          {/* Calm, single-focus welcome hero — card-less by design: the copy sits
              directly on the page. Rich mode floats the generated workspace
              artwork BEHIND the copy rather than beside it, so the greeting and
              the composer below share one left edge instead of stepping from a
              60%-wide column to a full-width box. Minimal mode keeps the same
              hierarchy without decorative media. */}
          <motion.section
            className={cn(
              "relative w-full",
              // Floor the height so the backdrop artwork has a band to live in
              // even when the copy is short (an `override` title with no
              // action line); the artwork sizes off this box, never past it.
              rich ? "@xl:min-h-[11rem]" : "flex flex-col items-center text-center"
            )}
            variants={STAGGER_CHILD}
            data-testid="welcome-hero"
          >
            {/* Ambient artwork. Decorative, so `alt=""` + aria-hidden: it repeats
                nothing the copy does not already say, and at 40% behind a
                left-fading mask it is texture, not an image to describe. Bleeds
                past the reading column on purpose — the scroller clips it at the
                pane edge. Hidden below @xl, where there is no room to bleed. */}
            {rich ? (
              <div
                aria-hidden
                data-testid="welcome-illustration"
                className="pointer-events-none absolute inset-y-0 right-0 hidden aspect-[3/2] h-full translate-x-10 @xl:block @3xl:translate-x-14"
              >
                <div className="absolute inset-10 rounded-full bg-primary/10 blur-3xl" />
                <Image
                  src="/illustrations/cognia-workspace-hero.png"
                  alt=""
                  width={1536}
                  height={1024}
                  sizes="(max-width: 767px) 0px, 336px"
                  loading="eager"
                  className="relative size-full object-contain opacity-40 [mask-image:linear-gradient(to_right,transparent,black_45%)]"
                />
              </div>
            ) : null}

            <div
              className={cn(
                "relative flex flex-col gap-4",
                rich ? "items-start text-left @xl:max-w-[32rem]" : "items-center text-center"
              )}
            >
              <div className="flex items-center gap-2.5">
                <Image
                  src="/icons/icon-512.png"
                  alt=""
                  width={28}
                  height={28}
                  className="size-7 rounded-lg"
                />
                <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  {t("brandAlt")}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <h2
                  className={cn(
                    "font-semibold leading-[1.1] tracking-tight text-balance",
                    rich ? "text-3xl @lg:text-4xl @3xl:text-5xl" : "text-2xl @lg:text-3xl"
                  )}
                >
                  {heading}
                </h2>
                {rich && !override?.title ? (
                  <p className="text-lg font-medium text-foreground/80 text-balance">
                    {t("title")}
                  </p>
                ) : null}
                <p
                  className={cn(
                    "max-w-md text-sm leading-relaxed text-muted-foreground text-pretty",
                    rich ? "" : "mx-auto"
                  )}
                >
                  {subheading}
                </p>
              </div>

              {/* Only surfaces WITHOUT a composer keep the creation button up
                  here as their primary action (the workflow-editor chat tab).
                  When the composer is present it is demoted below it — see
                  `showDemotedActions`. */}
              {showHeroAction ? (
                <div className="flex flex-wrap items-center gap-2">
                  {executionControlsSlot}
                  <Button
                    onClick={onCreate}
                    variant={rich ? "default" : "outline"}
                    className="gap-2"
                  >
                    <PlusIcon className="size-4" aria-hidden />
                    {t("newChat")}
                  </Button>
                </div>
              ) : null}
            </div>
          </motion.section>

          {/* The composer, directly under the greeting. Sits above every other
              section because it is what the page is FOR — the starters and recent
              sessions below are shortcuts into the same box. */}
          {composerSlot ? (
            <motion.div className="w-full" variants={STAGGER_CHILD} data-testid="welcome-composer">
              {composerSlot}
            </motion.div>
          ) : null}

          {/* Secondary actions, under the composer instead of above it. On this
              surface there is no session, so the composer IS "new chat" — the
              first send creates one. Keeping a filled button that does the same
              thing (and discards whatever was typed) above the real affordance
              made the redundant control the loudest one on the page. */}
          {showDemotedActions ? (
            <motion.div
              className="flex w-full flex-wrap items-center gap-2 pt-0.5"
              variants={STAGGER_CHILD}
              data-testid="welcome-actions"
            >
              {executionControlsSlot}
              <Button
                onClick={onCreate}
                variant="ghost"
                size="sm"
                className="ms-auto h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <PlusIcon className="size-3.5" aria-hidden />
                {t("newChat")}
              </Button>
            </motion.div>
          ) : null}
        </motion.div>

        {/* Mobile home customizable quick-action grid. */}
        {quickActionsSlot ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            {quickActionsSlot}
          </motion.div>
        ) : null}

        {/* Usage dashboard — self-hides when the user turned it off. */}
        {statsSlot ? (
          <motion.div className="w-full" variants={STAGGER_CHILD} data-testid="welcome-stats-slot">
            {statsSlot}
          </motion.div>
        ) : null}

        {/* AI starters — model-suggested opening prompts, surfaced as a
            horizontal row of ai-elements suggestion chips. Clicking a chip
            sends its prompt via onUseSample. */}
        {aiPrompts.length > 0 ? (
          <motion.div className="w-full" variants={STAGGER_CHILD} data-testid="ai-starters">
            <SectionHeading label={t("sections.aiPrompts")} />
            <Suggestions className="py-1">
              {aiPrompts.map((prompt, i) => (
                <Suggestion
                  key={`ai-${i}-${prompt.slice(0, 24)}`}
                  suggestion={prompt}
                  onClick={onUseSample}
                  aria-label={prompt}
                  className="max-w-[20rem]"
                >
                  <SparklesIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
                  <span className="truncate">{prompt}</span>
                </Suggestion>
              ))}
            </Suggestions>
          </motion.div>
        ) : null}

        {/* Character starters — exemplar prompts from the active character */}
        {charPrompts.length > 0 ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            <SectionHeading label={t("sections.characterPrompts")} />
            <motion.div
              className="grid grid-cols-1 gap-1 @2xl:grid-cols-2"
              variants={STAGGER_CONTAINER}
            >
              {charPrompts.map((prompt, i) => (
                <motion.div key={`${i}-${prompt.slice(0, 24)}`} variants={STAGGER_CHILD}>
                  <Suggestion
                    suggestion={prompt}
                    variant="ghost"
                    aria-label={prompt}
                    onClick={onUseSample}
                    className={cn(
                      "group h-full w-full justify-start gap-2.5 whitespace-normal px-3 py-2.5 text-left",
                      QUIET_ITEM_CLASS
                    )}
                  >
                    <SparklesIcon
                      className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
                      aria-hidden
                    />
                    <span className="line-clamp-2 text-sm">{prompt}</span>
                  </Suggestion>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        ) : null}

        {/* Try a prompt — dev-tool starters (dismissable; or surface overrides). */}
        {showStarters ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            <SectionHeading
              label={samplesHeading}
              dismissLabel={t("dismiss")}
              onDismiss={onDismissSection ? () => onDismissSection("tryPrompt") : undefined}
            />
            <motion.div
              className="grid grid-cols-1 gap-1 @2xl:grid-cols-2"
              variants={STAGGER_CONTAINER}
            >
              {starters.map(({ key, icon: Icon, title, prompt }) => (
                <motion.div key={key} variants={STAGGER_CHILD}>
                  <Suggestion
                    suggestion={prompt}
                    variant="ghost"
                    aria-label={title}
                    onClick={onUseSample}
                    className={cn(
                      "group h-full w-full items-start justify-start gap-3 whitespace-normal px-3 py-2.5 text-left",
                      QUIET_ITEM_CLASS
                    )}
                  >
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-medium">{title}</span>
                      <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {prompt}
                      </span>
                    </span>
                  </Suggestion>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        ) : null}

        {/* Continue — recent sessions */}
        {showRecents ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            <SectionHeading label={t("sections.continue")} />
            <motion.div className="flex flex-col" variants={STAGGER_CONTAINER}>
              {recents.map((s) => (
                <motion.div key={s.id} variants={STAGGER_CHILD}>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onResumeSession?.(s.id)}
                    aria-label={s.title}
                    className={cn(
                      "group h-auto w-full justify-start gap-2.5 whitespace-normal px-3 py-2 text-left font-normal",
                      QUIET_ITEM_CLASS
                    )}
                  >
                    <MessageSquareTextIcon
                      className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                      aria-hidden
                    />
                    <span className="truncate text-sm">{s.title}</span>
                    <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                      {format.relativeTime(s.updatedAt, now)}
                    </span>
                  </Button>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        ) : null}
      </motion.div>
    </div>
  )
}
