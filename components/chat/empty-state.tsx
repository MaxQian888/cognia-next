"use client"

import type { ReactNode } from "react"
import { useTranslations, useFormatter, useNow } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  ArrowRightIcon,
  BrainCircuitIcon,
  CableIcon,
  CodeIcon,
  FileTextIcon,
  FolderTreeIcon,
  MessageSquareTextIcon,
  MonitorIcon,
  PlusIcon,
  ScanTextIcon,
  SparklesIcon,
  Settings2Icon,
  TerminalIcon,
  UsersRoundIcon,
  WorkflowIcon,
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
export type WelcomeSection = "quickStart" | "tryPrompt"

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

type CapabilityId = "workflows" | "agentTeams" | "connectors" | "twin" | "computerUse" | "ocr"

interface CapabilityEntry {
  id: CapabilityId
  icon: LucideIcon
  href: string
  /** Tailwind classes for the icon chip (mirrors `scheduler/stat-card`). */
  iconBg: string
  /** Gradient start color for the bottom accent bar. */
  gradient: string
}

/** Deep-links mirror the registry used by the onboarding tour
 *  (`components/shell/onboarding-dialog.tsx`) and the desktop shell. The
 *  per-entry chart colors give the rich Bento grid its variety. */
const CAPABILITIES: CapabilityEntry[] = [
  {
    id: "workflows",
    icon: WorkflowIcon,
    href: "/settings?section=workflows&wfTab=templates",
    iconBg: "bg-chart-1/15 text-chart-1",
    gradient: "from-chart-1/60",
  },
  {
    id: "agentTeams",
    icon: UsersRoundIcon,
    href: "/settings?section=teams",
    iconBg: "bg-chart-2/15 text-chart-2",
    gradient: "from-chart-2/60",
  },
  {
    id: "connectors",
    icon: CableIcon,
    href: "/settings?section=connections",
    iconBg: "bg-chart-3/15 text-chart-3",
    gradient: "from-chart-3/60",
  },
  {
    id: "twin",
    icon: BrainCircuitIcon,
    href: "/settings?section=twin",
    iconBg: "bg-chart-4/15 text-chart-4",
    gradient: "from-chart-4/60",
  },
  {
    id: "computerUse",
    icon: MonitorIcon,
    href: "/settings?section=automation",
    iconBg: "bg-chart-5/15 text-chart-5",
    gradient: "from-chart-5/60",
  },
  {
    id: "ocr",
    icon: ScanTextIcon,
    href: "/settings?section=ocr",
    iconBg: "bg-primary/15 text-primary",
    gradient: "from-primary/50",
  },
]

const MAX_RECENT = 4

export interface RecentSessionEntry {
  id: string
  title: string
  updatedAt: number
}

interface Props {
  onCreate: () => void
  onUseSample: (prompt: string) => void
  /** When `inline` is true, render without the full-screen frame. */
  variant?: "fullscreen" | "inline"
  /**
   * Rendered between the greeting and the suggestion groups. The chat pane
   * passes the live `<Composer>` here for the centered-composer layout used
   * when an active session has no messages yet.
   */
  composerSlot?: ReactNode
  /** Navigate to a capability surface (a settings deep-link). When omitted,
   *  the capability group is hidden. */
  onNavigate?: (href: string) => void
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
   * Visual density. `"rich"` (default) shows the aurora backdrop, enlarged
   * brand mark, and the colored Bento capability grid; `"minimal"` falls back
   * to a flat, compact layout. The chat pane forces `"minimal"` on
   * mobile/narrow viewports.
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
  hiddenSections?: { quickStart?: boolean; tryPrompt?: boolean }
  /**
   * When provided, the "Quick start" and "Try a prompt" section headers show a
   * ✕ that calls this. The chat pane persists the dismissal so the section
   * stays hidden across reloads.
   */
  onDismissSection?: (section: WelcomeSection) => void
}

const HEADING_TEXT_CLASS = "text-xs font-medium uppercase tracking-wide text-muted-foreground"
const GROUP_HEADING_CLASS = `mb-2 ${HEADING_TEXT_CLASS}`
const INTERACTIVE_CARD_CLASS =
  "transition-all motion-safe:hover:-translate-y-0.5 hover:bg-accent hover:shadow-md hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

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

function onActivate(handler: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      handler()
    }
  }
}

export function EmptyChatState({
  onCreate,
  onUseSample,
  variant = "fullscreen",
  composerSlot,
  onNavigate,
  recentSessions,
  onResumeSession,
  characterSamples,
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
  const showCapabilities = typeof onNavigate === "function" && !hiddenSections?.quickStart
  const showRecents = recents.length > 0 && typeof onResumeSession === "function"
  const charPrompts = (characterSamples ?? []).filter((p) => p.trim().length > 0)

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
    <div className="relative flex flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 py-8 sm:px-8">
      {/* Atmospheric aurora backdrop — rich style only, decorative. */}
      {rich ? (
        <div className="welcome-aurora" data-testid="welcome-aurora" aria-hidden="true">
          <span className="welcome-aurora__blob welcome-aurora__b1" />
          <span className="welcome-aurora__blob welcome-aurora__b2" />
          <span className="welcome-aurora__blob welcome-aurora__b3" />
        </div>
      ) : null}

      {/* Inline rich/minimal switch (desktop only — the pane omits the handler
          on mobile, where the style is force-minimal). */}
      {onToggleStyle ? (
        <div className="absolute right-3 top-3 z-20">
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
        className="relative z-10 m-auto flex w-full max-w-2xl flex-col items-center gap-6"
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

        {/* Header — brand mark + time-of-day greeting */}
        <motion.div
          className="flex flex-col items-center gap-3 text-center"
          variants={STAGGER_CHILD}
        >
          <div className={cn("welcome-brand", rich && "welcome-brand--glow")}>
            <img
              src="/icons/icon-512.png"
              alt={t("brandAlt")}
              className={cn(
                "relative z-10 rounded-2xl ring-1 ring-border/60 shadow-lg",
                rich ? "size-16 sm:size-20" : "size-11"
              )}
            />
          </div>
          <h2
            className={cn(
              "font-semibold tracking-tight",
              rich ? "text-3xl sm:text-4xl" : "text-2xl"
            )}
          >
            {heading}
          </h2>
          {rich && !override?.title ? (
            <p className="text-base font-medium text-foreground/90">{t("title")}</p>
          ) : null}
          <p className="max-w-md text-sm text-muted-foreground">{subheading}</p>
        </motion.div>

        {/* Centered composer (empty active session) — reuses the live <Composer>. */}
        {composerSlot ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            {composerSlot}
          </motion.div>
        ) : null}

        {/* Mobile home customizable quick-action grid. */}
        {quickActionsSlot ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            {quickActionsSlot}
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
                  <Card
                    role="button"
                    tabIndex={0}
                    aria-label={prompt}
                    onClick={() => onUseSample(prompt)}
                    onKeyDown={onActivate(() => onUseSample(prompt))}
                    className={cn(
                      "flex h-full cursor-pointer flex-row items-center gap-2 p-3",
                      INTERACTIVE_CARD_CLASS
                    )}
                  >
                    <SparklesIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="line-clamp-2 text-sm">{prompt}</span>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        ) : null}

        {/* Quick start — platform capabilities (dismissable, Bento in rich) */}
        {showCapabilities ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            <SectionHeading
              label={t("sections.quickStart")}
              dismissLabel={t("dismiss")}
              onDismiss={onDismissSection ? () => onDismissSection("quickStart") : undefined}
            />
            {rich ? (
              <motion.div
                className="grid auto-rows-fr grid-cols-2 gap-3 sm:grid-cols-3"
                variants={STAGGER_CONTAINER}
              >
                {CAPABILITIES.map(({ id, icon: Icon, href, iconBg, gradient }, i) => {
                  const label = t(`capabilities.${id}`)
                  const featured = i === 0
                  return (
                    <motion.div
                      key={id}
                      variants={STAGGER_CHILD}
                      className={featured ? "sm:col-span-2 sm:row-span-2" : undefined}
                    >
                      <Card
                        role="button"
                        tabIndex={0}
                        aria-label={label}
                        onClick={() => onNavigate?.(href)}
                        onKeyDown={onActivate(() => onNavigate?.(href))}
                        className={cn(
                          "group relative flex h-full cursor-pointer flex-col gap-2 overflow-hidden p-4",
                          featured && "justify-between",
                          INTERACTIVE_CARD_CLASS
                        )}
                      >
                        <div
                          className={cn(
                            "flex items-center justify-center rounded-xl",
                            featured ? "size-12" : "size-10",
                            iconBg
                          )}
                        >
                          <Icon className={featured ? "size-6" : "size-5"} aria-hidden />
                        </div>
                        <div className="min-w-0">
                          <div
                            className={cn(
                              "truncate font-semibold",
                              featured ? "text-base" : "text-sm"
                            )}
                          >
                            {label}
                          </div>
                          <p
                            className={cn(
                              "mt-0.5 text-muted-foreground",
                              featured ? "text-sm line-clamp-3" : "text-xs line-clamp-2"
                            )}
                          >
                            {t(`capabilitiesDesc.${id}`)}
                          </p>
                        </div>
                        <ArrowRightIcon
                          className="absolute right-3 top-3 size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                          aria-hidden
                        />
                        <span
                          className={cn(
                            "absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r to-transparent",
                            gradient
                          )}
                        />
                      </Card>
                    </motion.div>
                  )
                })}
              </motion.div>
            ) : (
              <motion.div
                className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                variants={STAGGER_CONTAINER}
              >
                {CAPABILITIES.map(({ id, icon: Icon, href }) => (
                  <motion.div key={id} variants={STAGGER_CHILD}>
                    <Card
                      role="button"
                      tabIndex={0}
                      aria-label={t(`capabilities.${id}`)}
                      onClick={() => onNavigate?.(href)}
                      onKeyDown={onActivate(() => onNavigate?.(href))}
                      className={cn(
                        "flex h-full cursor-pointer flex-row items-center gap-2 p-3",
                        INTERACTIVE_CARD_CLASS
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate text-sm font-medium">
                        {t(`capabilities.${id}`)}
                      </span>
                    </Card>
                  </motion.div>
                ))}
              </motion.div>
            )}
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
                  <Card
                    role="button"
                    tabIndex={0}
                    aria-label={title}
                    onClick={() => onUseSample(prompt)}
                    onKeyDown={onActivate(() => onUseSample(prompt))}
                    className={cn(
                      "flex h-full cursor-pointer flex-col gap-0 p-4 text-left",
                      INTERACTIVE_CARD_CLASS
                    )}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <Icon className="size-4 text-muted-foreground" aria-hidden />
                      <span className="text-sm font-medium">{title}</span>
                    </div>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{prompt}</p>
                  </Card>
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

        {/* New chat — only on the no-session welcome (no centered composer) */}
        {variant === "fullscreen" && !composerSlot ? (
          <motion.div variants={STAGGER_CHILD}>
            <Button onClick={onCreate} variant={rich ? "default" : "outline"} className="gap-2">
              <PlusIcon className="size-4" aria-hidden />
              {t("newChat")}
            </Button>
          </motion.div>
        ) : null}
      </motion.div>
    </div>
  )
}
