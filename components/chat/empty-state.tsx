"use client"

import type { ReactNode } from "react"
import { useTranslations, useFormatter, useNow } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
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
  TerminalIcon,
  UsersRoundIcon,
  WorkflowIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"

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
  /** Welcome heading (defaults to the generic chat copy). */
  title?: string
  subtitle?: string
  /** Heading for the starter-card section (defaults to "Try a prompt"). */
  samplesHeading?: string
  /** Replace the generic dev-tool starter cards. */
  samples?: readonly StarterSample[]
}

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

interface CapabilityEntry {
  id: "workflows" | "agentTeams" | "connectors" | "twin" | "computerUse" | "ocr"
  icon: LucideIcon
  href: string
}

/** Deep-links mirror the registry used by the onboarding tour
 *  (`components/shell/onboarding-dialog.tsx`) and the desktop shell. */
const CAPABILITIES: CapabilityEntry[] = [
  { id: "workflows", icon: WorkflowIcon, href: "/settings?section=workflows&wfTab=templates" },
  { id: "agentTeams", icon: UsersRoundIcon, href: "/settings?section=teams" },
  { id: "connectors", icon: CableIcon, href: "/settings?section=connections" },
  { id: "twin", icon: BrainCircuitIcon, href: "/settings?section=twin" },
  { id: "computerUse", icon: MonitorIcon, href: "/settings?section=automation" },
  { id: "ocr", icon: ScanTextIcon, href: "/settings?section=ocr" },
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
}

const GROUP_HEADING_CLASS = "mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
const INTERACTIVE_CARD_CLASS =
  "transition-all motion-safe:hover:-translate-y-0.5 hover:bg-accent hover:shadow-md hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

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
}: Props) {
  const t = useTranslations("chat.empty")
  const format = useFormatter()
  // Anchor relative timestamps to a single render-time "now" so next-intl
  // doesn't fall back to an implicit current time (ENVIRONMENT_FALLBACK).
  const now = useNow()
  const reduce = useReducedMotion()

  const recents = (recentSessions ?? []).slice(0, MAX_RECENT)
  const showCapabilities = typeof onNavigate === "function"
  const showRecents = recents.length > 0 && typeof onResumeSession === "function"
  const charPrompts = (characterSamples ?? []).filter((p) => p.trim().length > 0)

  // Surface-specific overrides fall back to the generic chat copy / dev-tool
  // starters when omitted, so existing callers render unchanged.
  const heading = override?.title ?? t("title")
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

  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-4 py-8 sm:px-8">
      <motion.div
        className="m-auto flex w-full max-w-2xl flex-col items-center gap-6"
        initial={reduce ? false : "initial"}
        animate="animate"
        variants={STAGGER_CONTAINER}
      >
        {/* Header */}
        <motion.div
          className="flex flex-col items-center gap-3 text-center"
          variants={STAGGER_CHILD}
        >
          <div className="flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-primary/15 to-primary/5 text-primary ring-1 ring-primary/10">
            <SparklesIcon className="size-6" />
          </div>
          <h2 className="text-2xl font-semibold">{heading}</h2>
          <p className="text-sm text-muted-foreground">{subheading}</p>
        </motion.div>

        {/* Centered composer (empty active session) */}
        {composerSlot ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            {composerSlot}
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
                    onClick={() => onUseSample(prompt)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        onUseSample(prompt)
                      }
                    }}
                    className={`flex h-full cursor-pointer flex-row items-center gap-2 p-3 ${INTERACTIVE_CARD_CLASS}`}
                  >
                    <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="line-clamp-2 text-sm">{prompt}</span>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        ) : null}

        {/* Quick start — platform capabilities */}
        {showCapabilities ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            <h3 className={GROUP_HEADING_CLASS}>{t("sections.quickStart")}</h3>
            <motion.div
              className="grid grid-cols-2 gap-2 sm:grid-cols-3"
              variants={STAGGER_CONTAINER}
            >
              {CAPABILITIES.map(({ id, icon: Icon, href }) => (
                <motion.div key={id} variants={STAGGER_CHILD}>
                  <Card
                    role="button"
                    tabIndex={0}
                    onClick={() => onNavigate?.(href)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        onNavigate?.(href)
                      }
                    }}
                    className={`flex h-full cursor-pointer flex-row items-center gap-2 p-3 ${INTERACTIVE_CARD_CLASS}`}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium">{t(`capabilities.${id}`)}</span>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        ) : null}

        {/* Try a prompt — dev-tool starters (or surface-specific overrides) */}
        <motion.div className="w-full" variants={STAGGER_CHILD}>
          <h3 className={GROUP_HEADING_CLASS}>{samplesHeading}</h3>
          <motion.div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            variants={STAGGER_CONTAINER}
          >
            {starters.map(({ key, icon: Icon, title, prompt }) => {
              return (
                <motion.div key={key} variants={STAGGER_CHILD}>
                  <Card
                    role="button"
                    tabIndex={0}
                    onClick={() => onUseSample(prompt)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        onUseSample(prompt)
                      }
                    }}
                    className={`flex h-full cursor-pointer flex-col gap-0 p-4 text-left ${INTERACTIVE_CARD_CLASS}`}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <Icon className="size-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{title}</span>
                    </div>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{prompt}</p>
                  </Card>
                </motion.div>
              )
            })}
          </motion.div>
        </motion.div>

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
                    className={`flex w-full items-center gap-2 rounded-md border border-transparent px-3 py-2 text-left ${INTERACTIVE_CARD_CLASS}`}
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
            <Button onClick={onCreate} variant="outline" className="gap-2">
              <PlusIcon className="size-4" />
              {t("newChat")}
            </Button>
          </motion.div>
        ) : null}
      </motion.div>
    </div>
  )
}
