"use client"

/**
 * Compact visual badge for a teammate's runtime. Renders a small icon + label
 * with a per-runtime color. Reused in:
 *   - the @ mention picker rows
 *   - the mention-chip row above the team composer
 *   - team chat message headers (after the sender name)
 */

import { useTranslations } from "next-intl"
import {
  BotIcon,
  CommandIcon,
  GanttChartIcon,
  HexagonIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { TeammateRuntime } from "@/types/agent/agent-team"

interface RuntimeMeta {
  Icon: LucideIcon
  /** Tailwind classes for the rounded pill background + foreground text. */
  classes: string
  /** i18n key under `agentTeamsWorkspace.chat.runtime.*`. */
  labelKey: string
}

const RUNTIME_META: Record<TeammateRuntime, RuntimeMeta> = {
  claude: {
    Icon: HexagonIcon,
    classes: "bg-orange-500/15 text-orange-700 dark:text-orange-300 ring-orange-500/30",
    labelKey: "claude",
  },
  codex: {
    Icon: TerminalIcon,
    classes: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-200 ring-zinc-500/30",
    labelKey: "codex",
  },
  "claude-code": {
    Icon: CommandIcon,
    classes: "bg-blue-500/15 text-blue-700 dark:text-blue-300 ring-blue-500/30",
    labelKey: "claudeCode",
  },
  "gemini-cli": {
    Icon: GanttChartIcon,
    classes: "bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/30",
    labelKey: "geminiCli",
  },
  "cursor-cli": {
    Icon: BotIcon,
    classes: "bg-slate-700/20 text-slate-100 ring-slate-500/30",
    labelKey: "cursorCli",
  },
}

export interface RuntimeBadgeProps {
  runtime: TeammateRuntime
  /** When true, render only the icon (used inside small avatar overlays). */
  iconOnly?: boolean
  className?: string
}

export function RuntimeBadge({ runtime, iconOnly = false, className }: RuntimeBadgeProps) {
  const t = useTranslations("agentTeamsWorkspace.chat.runtime")
  const meta = RUNTIME_META[runtime]
  const Icon = meta.Icon
  const label = safeRuntimeLabel(t, meta.labelKey, runtime)

  return (
    <span
      data-testid={`runtime-badge-${runtime}`}
      data-runtime={runtime}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
        meta.classes,
        iconOnly && "px-1",
        className
      )}
      title={label}
    >
      <Icon className="size-3" aria-hidden />
      {!iconOnly && <span className="leading-none">{label}</span>}
    </span>
  )
}

// Translation lookup that gracefully falls back to the runtime literal if
// the key is missing — keeps the component robust against partial i18n.
function safeRuntimeLabel(
  t: ReturnType<typeof useTranslations>,
  key: string,
  fallback: string
): string {
  try {
    const value = t(key)
    if (value && value !== key) return value
  } catch {
    /* fall through */
  }
  return fallback
}
