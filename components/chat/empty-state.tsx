"use client"

import type { ReactNode } from "react"
import { useTranslations, useFormatter } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  BrainCircuitIcon,
  CableIcon,
  CodeIcon,
  FileTextIcon,
  FolderTreeIcon,
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
}

const GROUP_HEADING_CLASS = "mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
const INTERACTIVE_CARD_CLASS =
  "transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

export function EmptyChatState({
  onCreate,
  onUseSample,
  variant = "fullscreen",
  composerSlot,
  onNavigate,
  recentSessions,
  onResumeSession,
}: Props) {
  const t = useTranslations("chat.empty")
  const format = useFormatter()
  const reduce = useReducedMotion()

  const recents = (recentSessions ?? []).slice(0, MAX_RECENT)
  const showCapabilities = typeof onNavigate === "function"
  const showRecents = recents.length > 0 && typeof onResumeSession === "function"

  return (
    <div
      className={
        variant === "fullscreen"
          ? "flex flex-1 flex-col items-center justify-center gap-6 p-8"
          : "flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-8"
      }
    >
      <motion.div
        className="flex w-full max-w-2xl flex-col items-center gap-6"
        initial={reduce ? false : "initial"}
        animate="animate"
        variants={STAGGER_CONTAINER}
      >
        {/* Header */}
        <motion.div
          className="flex flex-col items-center gap-3 text-center"
          variants={STAGGER_CHILD}
        >
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <SparklesIcon className="size-6" />
          </div>
          <h2 className="text-2xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </motion.div>

        {/* Centered composer (empty active session) */}
        {composerSlot ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            {composerSlot}
          </motion.div>
        ) : null}

        {/* Quick start — platform capabilities */}
        {showCapabilities ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            <h3 className={GROUP_HEADING_CLASS}>{t("sections.quickStart")}</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {CAPABILITIES.map(({ id, icon: Icon, href }) => (
                <Card
                  key={id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onNavigate?.(href)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onNavigate?.(href)
                    }
                  }}
                  className={`flex cursor-pointer items-center gap-2 p-3 ${INTERACTIVE_CARD_CLASS}`}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">{t(`capabilities.${id}`)}</span>
                </Card>
              ))}
            </div>
          </motion.div>
        ) : null}

        {/* Try a prompt — dev-tool starters */}
        <motion.div className="w-full" variants={STAGGER_CHILD}>
          <h3 className={GROUP_HEADING_CLASS}>{t("sections.tryPrompt")}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {SAMPLE_IDS.map(({ id, icon: Icon }) => {
              const title = t(`samples.${id}Title`)
              const prompt = t(`samples.${id}Prompt`)
              return (
                <Card
                  key={id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onUseSample(prompt)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onUseSample(prompt)
                    }
                  }}
                  className={`cursor-pointer p-4 text-left ${INTERACTIVE_CARD_CLASS}`}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{title}</span>
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{prompt}</p>
                </Card>
              )
            })}
          </div>
        </motion.div>

        {/* Continue — recent sessions */}
        {showRecents ? (
          <motion.div className="w-full" variants={STAGGER_CHILD}>
            <h3 className={GROUP_HEADING_CLASS}>{t("sections.continue")}</h3>
            <div className="flex flex-col gap-1">
              {recents.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onResumeSession?.(s.id)}
                  className={`flex items-center justify-between gap-2 rounded-md px-3 py-2 text-left ${INTERACTIVE_CARD_CLASS}`}
                >
                  <span className="truncate text-sm">{s.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {format.relativeTime(s.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
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
