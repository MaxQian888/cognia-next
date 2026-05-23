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
import type { ComponentProps, ReactNode } from "react"
import { isValidElement, useState } from "react"

import { CodeBlock } from "@/components/chat/renderers/code-block"
import { DiffBlock } from "@/components/chat/renderers/diff-block"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"

export type ToolProps = ComponentProps<typeof Collapsible>

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn(
      "group not-prose mb-4 w-full rounded-md border bg-card/80 backdrop-blur-sm",
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

const INPUT_AUTO_COLLAPSE_THRESHOLD = 200

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"]
}

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const json = JSON.stringify(input, null, 2)
  const [open, setOpen] = useState(json.length <= INPUT_AUTO_COLLAPSE_THRESHOLD)

  return (
    <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors text-xs uppercase tracking-wide font-medium"
      >
        <ChevronDownIcon className={cn("size-3 transition-transform", !open && "-rotate-90")} />
        Parameters
      </button>
      {open && (
        <div className="rounded-md bg-muted/80">
          <CodeBlock code={json} language="json" showLineNumbers={false} />
        </div>
      )}
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
    <div className="space-y-2">
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Proposed change
      </h4>
      <DiffBlock content={diffText} filename={filePath} />
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

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  md: "markdown",
  mdx: "markdown",
  sql: "sql",
}

function inferLanguage(filePath?: string): string | undefined {
  if (!filePath) return undefined
  const ext = filePath.split(".").pop()?.toLowerCase()
  if (!ext) return undefined
  return EXT_TO_LANG[ext]
}

export const ToolReadPreview = ({ input, output }: ToolReadPreviewProps) => {
  if (typeof output !== "string") return null
  const filePath =
    input && typeof input === "object" ? (input as Record<string, unknown>).file_path : undefined
  const language = inferLanguage(typeof filePath === "string" ? filePath : undefined)

  return (
    <div className="space-y-2">
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Result</h4>
      <CodeBlock
        code={output}
        language={language}
        filename={typeof filePath === "string" ? filePath : undefined}
      />
    </div>
  )
}

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"]
  errorText: ToolPart["errorText"]
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"])
const READ_TOOLS = new Set(["Read"])

/**
 * Detect well-formed tool-result strings: JSON objects/arrays.
 */
function looksLikeJson(s: string): boolean {
  const trimmed = s.trim()
  if (!trimmed) return false
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  )
}

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null
  }

  let Output: ReactNode

  if (typeof output === "string") {
    Output = looksLikeJson(output) ? (
      <CodeBlock code={output} language="json" showLineNumbers={false} />
    ) : (
      <MarkdownRenderer
        content={output}
        enableMermaid={false}
        enableMath={false}
        enableVideoEmbed={false}
        enableAudioEmbed={false}
        enableEnhancedImages={false}
      />
    )
  } else if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" showLineNumbers={false} />
    )
  } else {
    Output = <div>{output as ReactNode}</div>
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText ? "bg-destructive/10 text-destructive p-3" : "text-foreground"
        )}
      >
        {errorText && <pre className="whitespace-pre-wrap break-words font-mono">{errorText}</pre>}
        {!errorText && Output}
      </div>
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
            <ToolOutput output={part.output} errorText={part.errorText} />
          )}
        </>
      )}
    </>
  )
}
