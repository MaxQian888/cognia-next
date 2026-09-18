"use client"

import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { DynamicToolUIPart, ToolUIPart } from "ai"
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import type { ComponentProps, ReactNode } from "react"
import { isValidElement } from "react"

import { CodeBlock } from "@/components/chat/renderers/code-block"
import { DiffBlock } from "@/components/chat/renderers/diff-block"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { ErrorParsedView } from "@/components/error/error-parsed-view"
import { inferLanguageFromPath, resolveToolOutputRender } from "@/lib/chat/tool-output-format"
import { ToolSemanticBadges } from "@/components/chat/message-parts/tool-semantic-badges"
import { ToolRowBlock } from "@/components/chat/message-parts/tool-row"

export type ToolProps = ComponentProps<typeof Collapsible>

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    data-slot="ai-tool"
    className={cn(
      // No backdrop-filter: a tool-call-dense reply stacks dozens of these
      // cards in the scroll list, and each backdrop-filter layer is re-sampled
      // every scroll frame (catastrophic in WebView2). Solid bg-card paints
      // once and removes the per-card compositing cost.
      "group not-prose mb-4 w-full rounded-md border bg-card",
      className
    )}
    {...props}
  />
)

export type ToolPart = ToolUIPart | DynamicToolUIPart

const HIGH_RISK_TOOL_NAMES = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"])

const MEDIUM_RISK_TOOL_NAMES = new Set(["WebFetch", "WebSearch", "TodoWrite"])

function getToolName(type: ToolPart["type"], toolName?: string): string {
  if (type === "dynamic-tool") return toolName ?? "tool"
  return type.split("-").slice(1).join("-")
}

function getRiskLevel(name: string): "high" | "medium" | null {
  if (HIGH_RISK_TOOL_NAMES.has(name)) return "high"
  if (MEDIUM_RISK_TOOL_NAMES.has(name)) return "medium"
  return null
}

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
}

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
}

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
)

export const getRiskBadge = (level: "high" | "medium") => {
  if (level === "high") {
    return (
      <Badge className="gap-1.5 rounded-full text-[10px]" variant="destructive">
        <ShieldAlertIcon className="size-3" />
        High risk
      </Badge>
    )
  }
  return (
    <Badge
      className="gap-1.5 rounded-full text-[10px] border-yellow-500/40 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
      variant="outline"
    >
      <ShieldCheckIcon className="size-3" />
      Caution
    </Badge>
  )
}

export type ToolHeaderProps = {
  title?: string
  readOnlyHint?: boolean | null
  className?: string
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"]
      state: DynamicToolUIPart["state"]
      toolName: string
    }
)

export const ToolHeader = ({
  className,
  title,
  readOnlyHint,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName = getToolName(type, toolName)
  const riskLevel = getRiskLevel(derivedName)

  return (
    <CollapsibleTrigger
      className={cn("flex w-full items-center justify-between gap-4 p-3", className)}
      {...props}
    >
      <div className="flex flex-wrap items-center gap-2">
        <WrenchIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">{title ?? derivedName}</span>
        <ToolSemanticBadges readOnlyHint={readOnlyHint} />
        {getStatusBadge(state)}
        {riskLevel && getRiskBadge(riskLevel)}
      </div>
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  )
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
)

/** Slim uppercase caption above a payload block — same weight as `ToolRowBlock`'s header. */
const PayloadLabel = ({ children }: { children: ReactNode }) => (
  <div className="px-0.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
    {children}
  </div>
)

/**
 * Uppercase block title matching `ToolRowBlock`'s header strip, so a compact
 * `CodeBlock` next to an `input`/`error` block reads as the same chrome.
 */
const BlockHeaderTitle = ({ children }: { children: ReactNode }) => (
  <span className="text-[10px] uppercase tracking-wide">{children}</span>
)

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"]
}

/**
 * The call's arguments as a bounded, left-railed block — the same chrome the
 * tool-row expansions use (`ToolRowBlock`). The body scrolls at `max-h-56`, so
 * oversized inputs need no collapse toggle.
 */
export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const t = useTranslations("chat.toolRow")
  const json = JSON.stringify(input, null, 2)

  return (
    <div className={cn("min-w-0", className)} {...props}>
      <ToolRowBlock
        label={t("input")}
        copyValue={json}
        copyLabel={t("copyInput")}
        testId="tool-input"
      >
        <pre className="px-2.5 py-2 whitespace-pre-wrap break-all">{json}</pre>
      </ToolRowBlock>
    </div>
  )
}

/**
 * Render Edit/Write/MultiEdit tool input as a unified diff so the user can
 * scan the proposed change visually instead of reading raw JSON.
 */
export type ToolEditPreviewProps = {
  input: ToolPart["input"]
  toolName: string
}

export const ToolEditPreview = ({ input, toolName }: ToolEditPreviewProps) => {
  const t = useTranslations("chat.toolRow")
  if (!input || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  const filePath = typeof obj.file_path === "string" ? obj.file_path : undefined

  let diffText = ""

  if (toolName === "Write") {
    const content = typeof obj.content === "string" ? obj.content : ""
    diffText = content
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n")
  } else if (toolName === "Edit") {
    const oldStr = typeof obj.old_string === "string" ? obj.old_string : ""
    const newStr = typeof obj.new_string === "string" ? obj.new_string : ""
    diffText =
      oldStr
        .split("\n")
        .map((l) => `-${l}`)
        .join("\n") +
      "\n" +
      newStr
        .split("\n")
        .map((l) => `+${l}`)
        .join("\n")
  } else if (toolName === "MultiEdit") {
    const edits = Array.isArray(obj.edits) ? obj.edits : []
    const parts: string[] = []
    for (const e of edits) {
      if (!e || typeof e !== "object") continue
      const er = e as Record<string, unknown>
      const oldStr = typeof er.old_string === "string" ? er.old_string : ""
      const newStr = typeof er.new_string === "string" ? er.new_string : ""
      parts.push(
        oldStr
          .split("\n")
          .map((l) => `-${l}`)
          .join("\n")
      )
      parts.push(
        newStr
          .split("\n")
          .map((l) => `+${l}`)
          .join("\n")
      )
    }
    diffText = parts.join("\n")
  }

  if (!diffText.trim()) return null

  return (
    <div>
      <PayloadLabel>{t("proposedChange")}</PayloadLabel>
      <DiffBlock content={diffText} filename={filePath} className="my-1" />
    </div>
  )
}

/**
 * Render Read/Glob/Grep tool output as a syntax-highlighted code block when
 * the result is a string. Falls back to the generic ToolOutput for other
 * shapes.
 */
export type ToolReadPreviewProps = {
  input: ToolPart["input"]
  output: ToolPart["output"]
}

export const ToolReadPreview = ({ input, output }: ToolReadPreviewProps) => {
  const t = useTranslations("chat.toolRow")
  if (typeof output !== "string") return null
  const filePath =
    input && typeof input === "object" ? (input as Record<string, unknown>).file_path : undefined
  const language = inferLanguageFromPath(typeof filePath === "string" ? filePath : undefined)

  return (
    <CodeBlock
      code={output}
      language={language}
      filename={typeof filePath === "string" ? filePath : undefined}
      compact
      headerTitle={<BlockHeaderTitle>{t("output")}</BlockHeaderTitle>}
    />
  )
}

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"]
  errorText: ToolPart["errorText"]
  /** Tool type (e.g. `tool-Bash`) used to resolve a tool-specific error preset. */
  toolType?: string
  /** Tool input — a shell `command` keys the output's highlight language. */
  input?: ToolPart["input"]
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"])
const READ_TOOLS = new Set(["Read"])

export const ToolOutput = ({
  className,
  output,
  errorText,
  toolType,
  input,
  ...props
}: ToolOutputProps) => {
  const t = useTranslations("chat.toolRow")
  if (!(output || errorText)) {
    return null
  }

  if (errorText) {
    return (
      <div className={cn("min-w-0", className)} {...props}>
        <ToolRowBlock
          label={t("errorLabel")}
          copyValue={errorText}
          error
          mono={false}
          testId="tool-error"
        >
          <div className="px-2.5 py-2 [&_table]:w-full">
            <ErrorParsedView rawError={errorText} toolType={toolType} />
          </div>
        </ToolRowBlock>
      </div>
    )
  }

  if (typeof output === "string") {
    // A terminal stream is not Markdown: rendering it as such reflows lines,
    // eats `<header.h>` as raw HTML, and promotes indented output to a nested
    // code block. `resolveToolOutputRender` keeps it preformatted and picks a
    // highlight language from the dumped file (`cat foo.cpp` → cpp).
    const render = resolveToolOutputRender(output, toolType, input)
    return (
      <div className={cn("min-w-0", className)} {...props}>
        {render.kind === "code" ? (
          <CodeBlock
            code={output}
            language={render.language}
            showLineNumbers={false}
            compact
            headerTitle={<BlockHeaderTitle>{t("output")}</BlockHeaderTitle>}
          />
        ) : (
          <ToolRowBlock
            label={t("output")}
            copyValue={output}
            copyLabel={t("copyOutput")}
            mono={false}
            testId="tool-output"
          >
            <div className="px-2.5 py-2 [&_table]:w-full">
              <MarkdownRenderer
                content={output}
                enableMermaid={false}
                enableMath={false}
                enableVideoEmbed={false}
                enableAudioEmbed={false}
                enableEnhancedImages={false}
              />
            </div>
          </ToolRowBlock>
        )}
      </div>
    )
  }

  if (typeof output === "object" && !isValidElement(output)) {
    const json = JSON.stringify(output, null, 2)
    return (
      <div className={cn("min-w-0", className)} {...props}>
        <ToolRowBlock
          label={t("output")}
          copyValue={json}
          copyLabel={t("copyOutput")}
          testId="tool-output"
        >
          <pre className="px-2.5 py-2 whitespace-pre-wrap break-all">{json}</pre>
        </ToolRowBlock>
      </div>
    )
  }

  return (
    <div className={cn("min-w-0", className)} {...props}>
      <ToolRowBlock label={t("output")} mono={false} testId="tool-output">
        <div className="px-2.5 py-2">{output as ReactNode}</div>
      </ToolRowBlock>
    </div>
  )
}

/**
 * High-level dispatcher. Consumers can render `<ToolBody part={part} />` and
 * get the right combination of input/output renderers based on the tool name.
 */
export type ToolBodyProps = {
  part: ToolPart
}

export const ToolBody = ({ part }: ToolBodyProps) => {
  const toolName =
    part.type === "dynamic-tool"
      ? (part as DynamicToolUIPart).toolName
      : part.type.split("-").slice(1).join("-")

  const isEditTool = EDIT_TOOLS.has(toolName)
  const isReadTool = READ_TOOLS.has(toolName)

  return (
    <>
      {part.input !== undefined && part.input !== null && (
        <>
          {isEditTool ? (
            <ToolEditPreview input={part.input} toolName={toolName} />
          ) : (
            <ToolInput input={part.input} />
          )}
        </>
      )}
      {(part.output !== undefined || part.errorText !== undefined) && (
        <>
          {isReadTool && !part.errorText ? (
            <ToolReadPreview input={part.input} output={part.output} />
          ) : (
            <ToolOutput
              output={part.output}
              errorText={part.errorText}
              toolType={part.type}
              input={part.input}
            />
          )}
        </>
      )}
    </>
  )
}
