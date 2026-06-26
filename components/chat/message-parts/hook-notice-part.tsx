"use client"

// Renders the synthetic "hook notice" markers the adapter projects from the
// Rust hook runtime's `hook_fire` system event
// (`lib/claude/adapter.ts:appendHookNotice`). A consequential lifecycle hook —
// one that blocked an action, injected context, or warned — shows as a compact
// single-line row with a left status-colour bar, expanding to reveal the reason,
// injected-context summary, and any warnings. No-op fires never reach here (the
// Rust side emits nothing for them). The message list swaps these markers in for
// the normal MessageRenderer so they carry no avatar / actions / usage chrome.

import { useTranslations } from "next-intl"
import { ChevronRightIcon, WebhookIcon } from "lucide-react"
import type { UIMessage } from "ai"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

export interface HookNoticePartData {
  type: "hook-notice"
  event: string
  toolName?: string
  outcome: "blocked" | "context" | "warning"
  block?: string
  additionalContext?: string
  warnings: string[]
}

/** True when a message is a synthetic hook-notice marker. */
export function isHookNoticeMessage(message: UIMessage): boolean {
  return (
    message.role === "system" &&
    message.parts.length === 1 &&
    (message.parts[0] as { type?: string }).type === "hook-notice"
  )
}

// Status-keyed colours for the left bar + the outcome chip.
const OUTCOME_STYLES: Record<HookNoticePartData["outcome"], { bar: string; chip: string }> = {
  blocked: { bar: "bg-destructive", chip: "text-destructive" },
  context: { bar: "bg-primary", chip: "text-primary" },
  warning: { bar: "bg-amber-500", chip: "text-amber-600 dark:text-amber-400" },
}

// Lifecycle events we ship a localized display name for; anything else falls
// back to the raw event identifier (a stable proper noun, e.g. "PreToolUse").
const KNOWN_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "PermissionRequest",
  "PermissionDenied",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "Notification",
  "PostCompact",
])

/**
 * Message-level marker — the built-in agent projects a hook fire as a whole
 * `role:"system"` message (see `lib/claude/adapter.ts:appendHookNotice`), routed
 * here by `message-list.tsx`. Delegates to the shared row.
 */
export function HookNoticeMarker({ message }: { message: UIMessage }) {
  return <HookNoticeRow data={message.parts[0] as unknown as HookNoticePartData} />
}

/**
 * Shared hook-notice row, used both by the message-level marker (built-in agent)
 * and as an inline `hook-notice` part (external agents, via
 * `message-renderer.tsx`'s renderPart). Same visual treatment in both places.
 */
export function HookNoticeRow({ data: part }: { data: HookNoticePartData }) {
  const t = useTranslations("chat.hookNotice")
  const styles = OUTCOME_STYLES[part.outcome] ?? OUTCOME_STYLES.warning

  const eventLabel = KNOWN_EVENTS.has(part.event) ? t(`event.${part.event}`) : part.event
  const outcomeLabel = t(`outcome.${part.outcome}`)
  const hasBody = Boolean(part.block) || Boolean(part.additionalContext) || part.warnings.length > 0

  return (
    <Collapsible className="my-2" data-testid={`hook-notice-${part.outcome}`}>
      <div className="flex items-stretch overflow-hidden rounded-md bg-muted/50 text-xs">
        <div className={cn("w-0.5 shrink-0", styles.bar)} aria-hidden />
        <CollapsibleTrigger
          className="group flex flex-1 items-center gap-2 px-2 py-1.5 text-left disabled:cursor-default"
          aria-label={t("toggle")}
          disabled={!hasBody}
        >
          <WebhookIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="font-medium">{eventLabel}</span>
          {part.toolName ? (
            <span
              className="rounded bg-background px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
              data-testid="hook-notice-tool"
            >
              {part.toolName}
            </span>
          ) : null}
          <span className={cn("shrink-0", styles.chip)}>· {outcomeLabel}</span>
          {hasBody ? (
            <ChevronRightIcon
              className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
              aria-hidden
            />
          ) : null}
        </CollapsibleTrigger>
      </div>
      {hasBody ? (
        <CollapsibleContent className="ml-2.5 mt-1 flex flex-col gap-1 border-l pl-3 text-xs text-muted-foreground">
          {part.block ? (
            <div data-testid="hook-notice-reason">
              <span className="font-medium text-foreground/80">{t("section.reason")}</span>{" "}
              {part.block}
            </div>
          ) : null}
          {part.additionalContext ? (
            <div data-testid="hook-notice-context">
              <span className="font-medium text-foreground/80">{t("section.context")}</span>{" "}
              <span className="line-clamp-3 break-words align-top">{part.additionalContext}</span>
            </div>
          ) : null}
          {part.warnings.length > 0 ? (
            <ul className="flex flex-col gap-0.5" data-testid="hook-notice-warnings">
              {part.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-1 text-amber-600 dark:text-amber-400">
                  <span aria-hidden>⚠</span>
                  <span className="break-words">{w}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  )
}

export default HookNoticeMarker
