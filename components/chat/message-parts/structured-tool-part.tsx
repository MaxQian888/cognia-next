"use client"

/**
 * StructuredToolPart — every tool call that is neither Bash nor a file tool
 * (WebFetch / WebSearch, the cognia bridge tools wiki_search / wiki_read /
 * rag_search / runtime_query / spawn_task, plan-mode signals, computer-use,
 * workflow proposals, plugin-contributed tools and unknown MCP tools) rendered
 * as the same inline row the rest of the stream uses: status dot + verb +
 * optional icon + mono target + meta + chevron.
 *
 * The row's expansion is `ToolDetailBody` — the single body dispatcher that
 * already routes error traces, the structured bodies (all borderless now),
 * A2UI surfaces, plugin renderers and MCP content blocks — so this row is a
 * pure chrome layer and never decides how a payload renders.
 *
 * Unknown tools get the generic spec: verb = the humanized tool name (or the
 * provider-supplied title), target/meta via `summarizeToolCall` /
 * `describeToolResult`, body = whatever `ToolDetailBody` resolves.
 */

import { memo, useMemo, useState } from "react"
import type { ToolUIPart } from "ai"
import { useTranslations } from "next-intl"
import {
  BookOpenIcon,
  BotIcon,
  ClipboardListIcon,
  FileSearchIcon,
  GlobeIcon,
  ListChecksIcon,
  MonitorSmartphoneIcon,
  SearchIcon,
  WorkflowIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react"

import { Shimmer } from "@/components/ai-elements/shimmer"
import { ToolSemanticBadges } from "@/components/chat/message-parts/tool-semantic-badges"
import { InlineCopyButton, ToolRowShell } from "@/components/chat/message-parts/tool-row"
import { ToolDetailBody } from "@/components/chat/message-parts/tool-detail-body"
import { parseOutputJson } from "@/components/chat/message-parts/mcp-renderers/common"
import {
  describeToolResult,
  resultErrorPreview,
  type ToolResultDescriptor,
} from "@/lib/chat/tool-result-summary"
import {
  asString,
  humanizeToolName,
  resolveProvidedToolTitle,
  resolveToolPartName,
  summarizeToolCall,
} from "@/lib/chat/tool-summary"
import { cn } from "@/lib/utils"

type ParsedOutput = Record<string, unknown> | null
type Translator = ReturnType<typeof useTranslations>

interface StructuredSpec {
  /** i18n key under `chat.toolRow.verb.*`; absent → humanized tool name. */
  verb?: string
  verbClass: string
  icon?: LucideIcon
  /** Mono target on the row; defaults to `summarizeToolCall`'s target. */
  target?: (input: Record<string, unknown>, parsed: ParsedOutput) => string | undefined
  /** Settled-state meta; defaults to `describeToolResult`. */
  meta?: (input: Record<string, unknown>, parsed: ParsedOutput, t: Translator) => string | null
  /** Hover copy value; defaults to the row target. */
  copyValue?: (input: Record<string, unknown>, parsed: ParsedOutput) => string | undefined
}

/** `N matches · via tavily` — the provider stays visible after the query echo
 *  row moved onto the row target. */
function webSearchMeta(_i: Record<string, unknown>, parsed: ParsedOutput, t: Translator) {
  const results = parsed?.results ?? parsed?.items
  const count =
    Array.isArray(results) && results.length > 0
      ? t("chat.agentFlow.result.matches", { count: results.length })
      : null
  const provider = asString(parsed?.provider)
  const via = provider ? t("chat.toolCards.webSearch.via", { provider }) : null
  return [count, via].filter(Boolean).join(" · ") || null
}

const SKY = "text-sky-600 dark:text-sky-400"
const VIOLET = "text-violet-600 dark:text-violet-400"
const AMBER = "text-amber-600 dark:text-amber-400"
const EMERALD = "text-emerald-600 dark:text-emerald-400"
const TEAL = "text-teal-600 dark:text-teal-400"
const MUTED = "text-muted-foreground"

/** Specs keyed by the normalized (namespace-folded, lower-cased) tool name. */
const SPEC: Record<string, StructuredSpec> = {
  webfetch: {
    verb: "fetch",
    verbClass: SKY,
    icon: GlobeIcon,
    target: (input) => asString(input.url),
    meta: (_i, parsed, t) =>
      typeof parsed?.status === "number"
        ? t("chat.toolRow.meta.httpStatus", { status: parsed.status })
        : (asString(parsed?.title) ?? null),
  },
  websearch: {
    verb: "search",
    verbClass: VIOLET,
    icon: SearchIcon,
    target: (input) => asString(input.query),
    meta: webSearchMeta,
  },
  web_search: {
    verb: "search",
    verbClass: VIOLET,
    icon: SearchIcon,
    target: (input) => asString(input.query),
    meta: webSearchMeta,
  },
  exit_plan_mode: { verb: "plan", verbClass: AMBER, icon: ClipboardListIcon },
  exitplanmode: { verb: "plan", verbClass: AMBER, icon: ClipboardListIcon },
  spawn_task: {
    verb: "task",
    verbClass: EMERALD,
    icon: ListChecksIcon,
    target: (input, parsed) =>
      asString(parsed?.title) ??
      asString(input.title) ??
      asString(input.task) ??
      asString(input.description),
    meta: (_i, parsed, t) =>
      parsed?.mode === "inherit"
        ? t("chat.mcp.spawnTask.inherit")
        : parsed?.mode === "aside"
          ? t("chat.mcp.spawnTask.aside")
          : null,
  },
  wiki_search: {
    verb: "wiki",
    verbClass: TEAL,
    icon: BookOpenIcon,
    target: (input) => asString(input.query),
    meta: (_i, parsed, t) =>
      Array.isArray(parsed?.hits)
        ? t("chat.agentFlow.result.matches", { count: parsed.hits.length })
        : null,
  },
  wiki_read: {
    verb: "wiki",
    verbClass: TEAL,
    icon: BookOpenIcon,
    target: (input, parsed) => asString(input.slug) ?? asString(parsed?.slug),
    meta: (_i, parsed) => asString(parsed?.title) ?? null,
  },
  rag_search: {
    verb: "recall",
    verbClass: TEAL,
    icon: FileSearchIcon,
    target: (input) => asString(input.query),
    meta: (_i, parsed, t) =>
      Array.isArray(parsed?.hits)
        ? t("chat.mcp.ragSearch.hitCount", { count: parsed.hits.length })
        : null,
  },
  runtime_query: {
    verb: "query",
    verbClass: TEAL,
    icon: BotIcon,
    target: (input) => asString(input.entityType) ?? asString(input.kind) ?? asString(input.query),
    meta: (_i, parsed, t) =>
      Array.isArray(parsed?.entities)
        ? t("chat.agentFlow.result.entries", { count: parsed.entities.length })
        : null,
  },
  wf_propose_batch: {
    verb: "workflow",
    verbClass: VIOLET,
    icon: WorkflowIcon,
    target: (_i, parsed) => asString(parsed?.summary),
    meta: (_i, parsed, t) =>
      typeof parsed?.opCount === "number"
        ? t("chat.toolRow.meta.ops", { count: parsed.opCount })
        : null,
  },
  wf_apply_template: {
    verb: "workflow",
    verbClass: VIOLET,
    icon: WorkflowIcon,
    target: (_i, parsed) => asString(parsed?.summary),
    meta: (_i, parsed, t) =>
      typeof parsed?.opCount === "number"
        ? t("chat.toolRow.meta.ops", { count: parsed.opCount })
        : null,
  },
}

/** The app-session computer-use family shares one spec keyed by action. */
const COMPUTER_USE_SPEC: StructuredSpec = {
  verb: "computer",
  verbClass: AMBER,
  icon: MonitorSmartphoneIcon,
  target: (input, parsed) => {
    const request = input.request as Record<string, unknown> | undefined
    const action = request?.action as Record<string, unknown> | undefined
    const app = parsed?.app as Record<string, unknown> | undefined
    return (
      asString(app?.displayName) ??
      asString(input.query) ??
      asString(action?.kind) ??
      asString(parsed?.status)
    )
  },
  meta: (_i, parsed, t) => {
    if (typeof parsed?.status === "string") return parsed.status
    if (parsed?.screenshotUnchanged) return t("chat.toolRow.meta.unchanged")
    const nodes = (parsed?.tree as Record<string, unknown> | undefined)?.nodes
    if (Array.isArray(nodes)) return t("chat.mcp.computerUse.nodes", { count: nodes.length })
    return typeof parsed?.revision === "number" ? `r${parsed.revision}` : null
  },
}
for (const name of [
  "get_app_state",
  "list_apps",
  "query_elements",
  "expand_element",
  "perform_action",
  "zoom",
  "find_text",
  "click_text",
]) {
  SPEC[name] = COMPUTER_USE_SPEC
}

/** `describeToolResult` descriptor → the same `agentFlow.result.*` text the
 *  simplified row's chip renders. */
function genericResultText(descriptor: ToolResultDescriptor, tFlow: Translator): string {
  switch (descriptor.kind) {
    case "diff":
      return tFlow("result.diff", { added: descriptor.added, removed: descriptor.removed })
    case "matches":
      return tFlow("result.matches", { count: descriptor.count })
    case "files":
      return tFlow("result.files", { count: descriptor.count })
    case "entries":
      return tFlow("result.entries", { count: descriptor.count })
    case "lines":
      return tFlow("result.lines", { count: descriptor.count })
    case "error":
      return descriptor.preview
  }
}

export interface StructuredToolPartProps {
  part: ToolUIPart
  sessionId?: string
  /**
   * Seeds the row's open state at mount (read once, like a Collapsible's
   * `defaultOpen`). Set by the activity group's expand-all / collapse-all and
   * by `detailed` mode; when absent a running or failed call starts open.
   */
  defaultOpen?: boolean
}

export const StructuredToolPart = memo(function StructuredToolPart({
  part,
  sessionId,
  defaultOpen,
}: StructuredToolPartProps) {
  const t = useTranslations()
  const tRow = useTranslations("chat.toolRow")
  const tFlow = useTranslations("chat.agentFlow")
  const running = part.state === "input-available"
  const [open, setOpen] = useState(defaultOpen ?? (running || part.state === "output-error"))

  const name = resolveToolPartName(part) ?? "tool"
  const spec = SPEC[name.toLowerCase()]
  const input = useMemo(() => (part.input ?? {}) as Record<string, unknown>, [part.input])
  const parsed = useMemo(() => parseOutputJson(part.output) as ParsedOutput, [part.output])

  const providedTitle = resolveProvidedToolTitle(part)
  const verbLabel =
    providedTitle ?? (spec?.verb ? tRow(`verb.${spec.verb}`) : humanizeToolName(name))
  const verbClass = spec?.verbClass ?? MUTED
  const SpecIcon = spec?.icon ?? WrenchIcon
  const target = useMemo(() => {
    const fromSpec = spec?.target?.(input, parsed)
    return fromSpec ?? summarizeToolCall(part).target ?? undefined
  }, [spec, input, parsed, part])

  const readOnlyHint = (part as ToolUIPart & { toolMetadata?: { readOnlyHint?: boolean | null } })
    .toolMetadata?.readOnlyHint

  const meta = useMemo((): { text: string; isError?: boolean } | null => {
    switch (part.state) {
      case "input-available":
        return { text: tFlow("status.running") }
      case "approval-requested":
        return { text: tFlow("status.awaitingApproval") }
      case "output-denied":
        return { text: tFlow("status.denied") }
      case "output-error": {
        const preview = resultErrorPreview(
          (part as { errorText?: unknown }).errorText ?? part.output
        )
        return { text: preview || tFlow("status.error"), isError: true }
      }
      case "output-available": {
        const text =
          spec?.meta?.(input, parsed, t) ??
          (() => {
            const descriptor = describeToolResult(part)
            return descriptor ? genericResultText(descriptor, tFlow) : null
          })()
        return text ? { text } : null
      }
      default:
        return null
    }
  }, [part, spec, input, parsed, t, tFlow])

  const copyValue = spec?.copyValue?.(input, parsed) ?? target
  const statusKey: Record<ToolUIPart["state"], string> = {
    "input-streaming": "pending",
    "input-available": "running",
    "approval-requested": "awaitingApproval",
    "approval-responded": "responded",
    "output-available": "completed",
    "output-denied": "denied",
    "output-error": "error",
  }

  return (
    <ToolRowShell
      status={part.state}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      ariaLabel={tRow("rowAria", {
        verb: verbLabel,
        target: target ?? "",
        status: tFlow(`status.${statusKey[part.state]}`),
      })}
      title={target}
      testId="structured-tool-part"
      dataKind={name.toLowerCase()}
      lead={
        <span
          className={cn("shrink-0 text-[11px] font-semibold uppercase tracking-wide", verbClass)}
        >
          {verbLabel}
        </span>
      }
      icon={<SpecIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      target={
        running && target ? (
          <Shimmer as="span" className="min-w-0 flex-1 truncate font-mono text-xs" duration={1.6}>
            {target}
          </Shimmer>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
            {target ?? verbLabel}
          </span>
        )
      }
      badges={<ToolSemanticBadges readOnlyHint={readOnlyHint} />}
      meta={
        meta ? (
          <span
            className={cn(
              "shrink-0 truncate text-[11px]",
              meta.isError ? "text-destructive" : "text-muted-foreground"
            )}
            data-testid="structured-tool-meta"
          >
            {meta.text}
          </span>
        ) : undefined
      }
      actions={
        copyValue ? (
          <InlineCopyButton
            value={copyValue}
            label={tRow("copyTarget")}
            testId="structured-tool-copy-target"
          />
        ) : undefined
      }
    >
      <ToolDetailBody part={part} sessionId={sessionId} />
    </ToolRowShell>
  )
})

export default StructuredToolPart
