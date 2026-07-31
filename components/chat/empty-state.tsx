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

const HEADING_TEXT_CLASS = "text-xs font-medium uppercase tracking-wide text-muted-foreground"
const GROUP_HEADING_CLASS = `mb-2 ${HEADING_TEXT_CLASS}`
const INTERACTIVE_CARD_CLASS =
  "rounded-xl border bg-card/70 shadow-xs transition-all motion-safe:hover:-translate-y-0.5 hover:border-foreground/15 hover:bg-accent/60 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

/** Section heading with an optional dismiss (✕) affordance. */
function SectionHeading({
  label,
  dismissLabel,
  onDismiss,
}: {
  label: string
  dismissLabel?: string
  onDismiss?: () => void
}) {
  if (!onDismiss) return <h3 className={GROUP_HEADING_CLASS}>{label}</h3>
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className={HEADING_TEXT_CLASS}>{label}</h3>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        className="-mr-1 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon className="size-3.5" aria-hidden />
      </button>
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

  return (
    <div className="@container relative flex flex-1 flex-col overflow-x-hidden overflow-y-auto px-4 py-6 sm:px-8 sm:py-10">
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
        className="relative z-10 m-auto flex w-full max-w-4xl flex-col items-center gap-8"
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

        {/* Calm, single-focus welcome hero. Rich mode adds the generated
            workspace illustration; minimal mode keeps the same hierarchy
            without decorative media. */}
        <motion.section
          className={cn(
            "w-full",
            rich
              ? "grid items-center gap-6 overflow-hidden rounded-3xl border bg-card/70 p-5 shadow-sm sm:p-7 @3xl:grid-cols-[minmax(0,1fr)_minmax(16rem,0.9fr)] @3xl:gap-8"
              : "flex flex-col items-center text-center"
          )}
          variants={STAGGER_CHILD}
          data-testid="welcome-hero"
        >
          <div
            className={cn(
              "flex flex-col gap-3",
              rich ? "items-start text-left" : "items-center text-center"
            )}
          >
            <div className="flex items-center gap-2.5">
              <Image
                src="/icons/icon-512.png"
                alt=""
                width={36}
                height={36}
                className="size-9 rounded-xl ring-1 ring-border/70"
              />
              <span className="text-sm font-semibold tracking-tight">{t("brandAlt")}</span>
            </div>
            <div className="flex flex-col gap-2">
              <h2
                className={cn(
                  "font-semibold tracking-tight text-balance",
                  rich ? "text-3xl sm:text-4xl" : "text-2xl"
                )}
              >
                {heading}
              </h2>
              {rich && !override?.title ? (
                <p className="text-base font-medium text-foreground/90">{t("title")}</p>
              ) : null}
              <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{subheading}</p>
            </div>

            {variant === "fullscreen" ? (
              <Button onClick={onCreate} variant={rich ? "default" : "outline"} className="gap-2">
                <PlusIcon className="size-4" aria-hidden />
                {t("newChat")}
              </Button>
            ) : null}
          </div>

          {rich ? (
            <div
              className="relative mx-auto aspect-[3/2] w-full max-w-sm overflow-hidden rounded-2xl bg-muted/35"
              data-testid="welcome-illustration"
            >
              <Image
                src="/illustrations/cognia-workspace-hero.png"
                alt={t("illustrationAlt")}
                width={1536}
                height={1024}
                sizes="(max-width: 767px) 82vw, 360px"
                loading="eager"
                className="size-full object-contain p-2"
              />
            </div>
          ) : null}
        </motion.section>

        {/* Mobile home customizable quick-action grid. */}
        {quickActionsSlot ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            {quickActionsSlot}
          </motion.div>
        ) : null}

        {/* AI starters — model-suggested opening prompts, surfaced as a
            horizontal row of ai-elements suggestion chips. Clicking a chip
            sends its prompt via onUseSample. */}
        {aiPrompts.length > 0 ? (
          <motion.div className="w-full" variants={STAGGER_CHILD} data-testid="ai-starters">
            <h3 className={GROUP_HEADING_CLASS}>{t("sections.aiPrompts")}</h3>
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
            <h3 className={GROUP_HEADING_CLASS}>{t("sections.characterPrompts")}</h3>
            <motion.div
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
              variants={STAGGER_CONTAINER}
            >
              {charPrompts.map((prompt, i) => (
                <motion.div key={`${i}-${prompt.slice(0, 24)}`} variants={STAGGER_CHILD}>
                  <button
                    type="button"
                    aria-label={prompt}
                    onClick={() => onUseSample(prompt)}
                    className={cn(
                      "flex h-full w-full items-center gap-2 p-3 text-left",
                      INTERACTIVE_CARD_CLASS
                    )}
                  >
                    <SparklesIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="line-clamp-2 text-sm">{prompt}</span>
                  </button>
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
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              variants={STAGGER_CONTAINER}
            >
              {starters.map(({ key, icon: Icon, title, prompt }) => (
                <motion.div key={key} variants={STAGGER_CHILD}>
                  <button
                    type="button"
                    aria-label={title}
                    onClick={() => onUseSample(prompt)}
                    className={cn(
                      "group flex h-full w-full flex-col gap-2 p-4 text-left",
                      INTERACTIVE_CARD_CLASS
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-background group-hover:text-foreground">
                        <Icon className="size-4" aria-hidden />
                      </span>
                      <span className="text-sm font-medium">{title}</span>
                    </div>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{prompt}</p>
                  </button>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        ) : null}

        {/* Continue — recent sessions */}
        {showRecents ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            <h3 className={GROUP_HEADING_CLASS}>{t("sections.continue")}</h3>
            <motion.div className="flex flex-col gap-1" variants={STAGGER_CONTAINER}>
              {recents.map((s) => (
                <motion.div key={s.id} variants={STAGGER_CHILD}>
                  <button
                    type="button"
                    onClick={() => onResumeSession?.(s.id)}
                    aria-label={s.title}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md border border-transparent px-3 py-2 text-left",
                      INTERACTIVE_CARD_CLASS
                    )}
                  >
                    <MessageSquareTextIcon
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="truncate text-sm">{s.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {format.relativeTime(s.updatedAt, now)}
                    </span>
                  </button>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        ) : null}
      </motion.div>
    </div>
  )
}
