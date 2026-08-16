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
import { runtimeLabelKey } from "./runtime-options"
import type { TeammateRuntime } from "@/types/agent/agent-team"

/**
 * Pill colors, and nothing else.
 *
 * Labels come from `runtimeLabelKey()` in `./runtime-options`, which is also
 * what the Members picker and the teammate config dialog read. This map used to
 * carry its own `labelKey` per runtime — the same key set, maintained twice,
 * with the drift guard in `runtime-options.test.ts` covering only the other two
 * consumers. Color is genuinely local to the badge; the label is not.
 *
 * Exhaustive on purpose: a new runtime must make a deliberate color choice, and
 * `Record` is what forces that.
 */
const RUNTIME_CLASSES: Record<TeammateRuntime, string> = {
  claude: "bg-orange-500/15 text-orange-700 dark:text-orange-300 ring-orange-500/30",
  codex: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-200 ring-zinc-500/30",
  "claude-code": "bg-blue-500/15 text-blue-700 dark:text-blue-300 ring-blue-500/30",
  "gemini-cli": "bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/30",
  "cursor-cli": "bg-slate-700/20 text-slate-100 ring-slate-500/30",
  "codex-app-server":
    "bg-neutral-500/15 text-neutral-700 dark:text-neutral-200 ring-neutral-500/30",
  "copilot-cli": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30",
  kiro: "bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30",
  "qwen-code": "bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-500/30",
  pi: "bg-teal-500/15 text-teal-700 dark:text-teal-300 ring-teal-500/30",
  // Deliberately a deeper teal than `pi`: same product, and the two runtimes
  // sit next to each other in the picker during the native-RPC preview, so
  // they must read as related but not interchangeable.
  "pi-rpc": "bg-teal-600/20 text-teal-800 dark:text-teal-200 ring-teal-600/40",
  droid: "bg-green-500/15 text-green-700 dark:text-green-300 ring-green-500/30",
  "opencode-server": "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 ring-cyan-500/30",
  "opencode-remote": "bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30",
}

export interface RuntimeBadgeProps {
  runtime: TeammateRuntime
  /** When true, render only the icon (used inside small avatar overlays). */
  iconOnly?: boolean
  className?: string
}

export function RuntimeBadge({ runtime, iconOnly = false, className }: RuntimeBadgeProps) {
  const t = useTranslations("agentTeamsWorkspace.chat.runtime")
  const label = safeRuntimeLabel(t, runtimeLabelKey(runtime), runtime)

  return (
    <span
      data-testid={`runtime-badge-${runtime}`}
      data-runtime={runtime}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset transition-colors duration-150",
        RUNTIME_CLASSES[runtime],
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

/**
 * Translation lookup that falls back to the runtime literal when the key is
 * missing — keeps the badge readable against a partial i18n bundle.
 *
 * Exported for its own test: `jest.setup.ts` mocks next-intl to resolve against
 * the real `en.json`, and every key in `RUNTIME_LABEL_KEYS` is present there, so
 * neither fallback branch is reachable by rendering the component. Testing it
 * through the component would assert the bundle, not this function.
 */
export function safeRuntimeLabel(
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
