"use client"

/**
 * Compact visual badge for a teammate's runtime. Renders a small icon + label
 * with a per-runtime color. Reused in:
 *   - the @ mention picker rows
 *   - the mention-chip row above the team composer
 *   - team chat message headers (after the sender name)
 */

import { useTranslations } from "next-intl"
import { BrandIcon } from "@/components/icons/brand-icon"
import { cn } from "@/lib/utils"
import type { TeammateRuntime } from "@/types/agent/agent-team"

interface RuntimeMeta {
  /** Tailwind classes for the rounded pill background + foreground text. */
  classes: string
  /** i18n key under `agentTeamsWorkspace.chat.runtime.*`. */
  labelKey: string
}

const RUNTIME_META: Record<TeammateRuntime, RuntimeMeta> = {
  claude: {
    classes: "bg-orange-500/15 text-orange-700 dark:text-orange-300 ring-orange-500/30",
    labelKey: "claude",
  },
  codex: {
    classes: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-200 ring-zinc-500/30",
    labelKey: "codex",
  },
  "claude-code": {
    classes: "bg-blue-500/15 text-blue-700 dark:text-blue-300 ring-blue-500/30",
    labelKey: "claudeCode",
  },
  "gemini-cli": {
    classes: "bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/30",
    labelKey: "geminiCli",
  },
  "cursor-cli": {
    classes: "bg-slate-700/20 text-slate-100 ring-slate-500/30",
    labelKey: "cursorCli",
  },
  "codex-app-server": {
    classes: "bg-neutral-500/15 text-neutral-700 dark:text-neutral-200 ring-neutral-500/30",
    labelKey: "codexAppServer",
  },
  "copilot-cli": {
    classes: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30",
    labelKey: "copilotCli",
  },
  kiro: {
    classes: "bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30",
    labelKey: "kiro",
  },
  "qwen-code": {
    classes: "bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-500/30",
    labelKey: "qwenCode",
  },
  pi: {
    classes: "bg-teal-500/15 text-teal-700 dark:text-teal-300 ring-teal-500/30",
    labelKey: "pi",
  },
  droid: {
    classes: "bg-green-500/15 text-green-700 dark:text-green-300 ring-green-500/30",
    labelKey: "droid",
  },
  "opencode-server": {
    classes: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 ring-cyan-500/30",
    labelKey: "opencodeServer",
  },
  "opencode-remote": {
    classes: "bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30",
    labelKey: "opencodeRemote",
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
  const label = safeRuntimeLabel(t, meta.labelKey, runtime)

  return (
    <span
      data-testid={`runtime-badge-${runtime}`}
      data-runtime={runtime}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset transition-colors duration-150",
        meta.classes,
        iconOnly && "px-1",
        className
      )}
      title={label}
    >
      <BrandIcon id={runtime} label={label} size={12} />
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
