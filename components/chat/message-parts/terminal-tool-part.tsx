"use client"

/**
 * TerminalToolPart — a Bash tool call rendered as a single inline row in the
 * message stream instead of the generic Tool card. The row carries a breathing
 * status dot, a `$` prompt and the command's first line (truncated), plus
 * hover-revealed copy / run-in-dock actions. Expanding nests a theme-matched
 * output block under the row — it echoes the full command (the way a real
 * terminal transcript does, so long / multi-line commands stay complete) above
 * the streamed output. While the call is in flight the command text sweeps a
 * shimmer (ai-elements `Shimmer`).
 *
 * A failed call keeps the same row: the expanded area shows the parsed error
 * trace, so `message-renderer` routes *every* Bash state here rather than
 * falling back to the generic card for `output-error`.
 *
 * The body is exported separately as {@link TerminalToolBody} for the body
 * slots that already provide their own collapse (`ToolCallRow` in simplified
 * mode, the generic card in `ToolDetailBody`) — there it renders the command
 * echo + output + run-in-dock affordance with no second collapse.
 */

import { memo, useCallback, useMemo, useState } from "react"
import type { ToolUIPart } from "ai"
import { useTranslations } from "next-intl"
import Ansi from "ansi-to-react"
import { TerminalSquareIcon } from "lucide-react"

import { Shimmer } from "@/components/ai-elements/shimmer"
import { Button } from "@/components/ui/button"
import { ToolSemanticBadges } from "@/components/chat/message-parts/tool-semantic-badges"
import { InlineCopyButton, ToolRowShell } from "@/components/chat/message-parts/tool-row"
import { ErrorParsedView } from "@/components/error/error-parsed-view"
import {
  TerminalTabPicker,
  type TerminalTabPickerProps,
} from "@/components/chat/terminal-tab-picker"
import { runInDockTab } from "@/lib/terminal/run-in-dock"
import { resolveDefaultShell } from "@/lib/terminal/shell-detect"
import { resultErrorPreview } from "@/lib/chat/tool-result-summary"
import { resolveToolDisplayTitle } from "@/lib/chat/tool-summary"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useChatStore } from "@/stores/chat/chat-store"
import { cn } from "@/lib/utils"

interface TerminalToolPartProps {
  part: ToolUIPart
  /**
   * Seeds the row's open state at mount (read once, like a Collapsible's
   * `defaultOpen`). Used for standalone rows; when absent a running or failed call starts open.
   */
  defaultOpen?: boolean
  expanded?: boolean
  onToggle?: () => void
}

interface TerminalToolBodyProps {
  part: ToolUIPart
}

/** stdout / stderr / exitCode lifted from a Bash result object; plain strings pass through. */
interface BashIO {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  /** Everything renderable, joined — what copy + the Ansi block use. */
  text: string
}

function extractCommand(input: unknown): string | undefined {
  if (input && typeof input === "object" && "command" in input) {
    const cmd = (input as { command?: unknown }).command
    if (typeof cmd === "string") return cmd
  }
  return undefined
}

function extractBashIO(output: unknown): BashIO {
  if (typeof output === "string") return { text: output }
  if (output && typeof output === "object") {
    const obj = output as { stdout?: unknown; stderr?: unknown; exitCode?: unknown }
    const stdout = typeof obj.stdout === "string" ? obj.stdout : undefined
    const stderr = typeof obj.stderr === "string" ? obj.stderr : undefined
    const exitCode = typeof obj.exitCode === "number" ? obj.exitCode : null
    return { stdout, stderr, exitCode, text: [stdout, stderr].filter(Boolean).join("\n") }
  }
  return { text: "" }
}

/**
 * The theme-matched output block shared by the row's expanded area and the
 * embedded body: bordered, left-railed, `bg-muted` surface (light *and* dark
 * theme — the message stream stays consistent instead of dropping a dark
 * console into light chats). Echoes the full command as a `$` prompt line so
 * multi-line commands remain intact even though the row shows only line one.
 */
const BashOutputView = memo(function BashOutputView({
  part,
  io,
  command,
}: {
  part: ToolUIPart
  io: BashIO
  command?: string
}) {
  const t = useTranslations("chat.toolRow")
  const streaming = part.state === "input-available"
  const isError = part.state === "output-error"
  const errorText = (part as { errorText?: unknown }).errorText
  const label = isError ? t("errorLabel") : io.stderr && !io.stdout ? t("stderr") : t("stdout")

  // Nothing to show at all (e.g. a denied call whose row already says so).
  if (!command && !io.text && !isError) return null

  return (
    <div
      className="mt-0.5 mb-1 overflow-hidden rounded-md border border-l-2 bg-muted/40 font-mono text-xs"
      data-testid="terminal-tool-output"
      data-streaming={streaming || undefined}
    >
      <div className="flex items-center justify-between gap-2 border-b px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{label}</span>
        {io.text ? (
          <InlineCopyButton
            value={io.text}
            label={t("copyOutput")}
            testId="terminal-tool-copy-output"
          />
        ) : null}
      </div>
      <div className="max-h-56 overflow-auto px-2.5 py-1.5">
        {command ? (
          <pre className="whitespace-pre-wrap break-words">
            <span className="select-none text-muted-foreground">$ </span>
            <span className="text-foreground">{command}</span>
          </pre>
        ) : null}
        {isError ? (
          <div className="mt-1 font-sans text-sm">
            <ErrorParsedView
              rawError={errorText ?? io.text}
              toolType={part.type}
              fallback={t("errorLabel")}
            />
          </div>
        ) : (
          io.text && (
            <pre className="whitespace-pre-wrap break-words text-foreground/90">
              <Ansi>{io.text}</Ansi>
            </pre>
          )
        )}
        {streaming ? (
          <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-foreground/70 align-middle" />
        ) : null}
      </div>
    </div>
  )
})

/** Everything the "Run in dock" affordance needs; shared by both render shapes. */
function useRunInDock(command: string | undefined) {
  const chatSessionId = useChatStore((s) =>
    typeof (s as { activeSessionId?: string }).activeSessionId === "string"
      ? (s as { activeSessionId: string }).activeSessionId
      : ""
  )
  const project = useProjectStore((s) =>
    s.activeProjectId ? (s.projects.find((p) => p.id === s.activeProjectId) ?? null) : null
  )
  const settingsShell = useSettingsStore(
    (s) => (s.settings?.terminal as { defaultShell?: string } | undefined)?.defaultShell
  )
  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  // Stable handler so the picker isn't handed a fresh async closure on every
  // streaming re-render while the Bash call is in flight.
  const handlePick = useCallback(
    async (choice: Parameters<TerminalTabPickerProps["onPick"]>[0]) => {
      if (!command || !chatSessionId) return
      setBusy(true)
      try {
        if (choice.kind === "existing") {
          await runInDockTab({ chatSessionId, tabId: choice.row.id, command })
        } else {
          await runInDockTab({
            chatSessionId,
            newTab: {
              req: {
                shell: resolveDefaultShell({
                  projectShell: project?.terminalConfig?.shell,
                  settingShell: settingsShell,
                }),
                cwd: project?.terminalConfig?.cwd?.trim() || project?.rootDir?.trim() || undefined,
                env: project?.terminalConfig?.env,
                projectId: project?.id,
                rows: 24,
                cols: 80,
              },
            },
            command,
          })
        }
      } finally {
        setBusy(false)
      }
    },
    [command, chatSessionId, project, settingsShell]
  )

  return {
    canRun: !!command && command.length > 0 && !!chatSessionId,
    busy,
    pickerOpen,
    setPickerOpen,
    handlePick,
  }
}

export const TerminalToolBody = memo(function TerminalToolBody({ part }: TerminalToolBodyProps) {
  const t = useTranslations("chat.terminalTool")
  const command = useMemo(() => extractCommand(part.input), [part.input])
  const io = useMemo(() => extractBashIO(part.output), [part.output])
  const { canRun, busy, pickerOpen, setPickerOpen, handlePick } = useRunInDock(command)

  return (
    <div data-testid="terminal-tool-body">
      <BashOutputView part={part} io={io} command={command} />
      {canRun ? (
        <div className="mt-1 flex justify-end">
          <TerminalTabPicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={handlePick}>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-xs"
              disabled={busy}
              data-testid="terminal-tool-part-run-in-dock"
            >
              <TerminalSquareIcon className="h-3 w-3" />
              {t("runInDock.label")}
            </Button>
          </TerminalTabPicker>
        </div>
      ) : null}
    </div>
  )
})

export const TerminalToolPart = memo(function TerminalToolPart({
  part,
  defaultOpen,
  expanded,
  onToggle,
}: TerminalToolPartProps) {
  const t = useTranslations("chat.toolRow")
  const tDock = useTranslations("chat.terminalTool")
  const tFlow = useTranslations("chat.agentFlow")
  const running = part.state === "input-available"
  const [internalOpen, setInternalOpen] = useState(
    defaultOpen ?? (running || part.state === "output-error")
  )
  const open = expanded ?? internalOpen
  const command = useMemo(() => extractCommand(part.input), [part.input])
  const io = useMemo(() => extractBashIO(part.output), [part.output])
  const { canRun, busy, pickerOpen, setPickerOpen, handlePick } = useRunInDock(command)

  const readOnlyHint = (part as ToolUIPart & { toolMetadata?: { readOnlyHint?: boolean | null } })
    .toolMetadata?.readOnlyHint
  const displayTitle = resolveToolDisplayTitle(part)

  // Long commands: the row shows only the first line; the expanded block
  // echoes the whole command, and a `+N lines` hint flags the truncation.
  const commandLines = useMemo(() => (command ? command.split("\n") : []), [command])
  const firstLine = commandLines[0] ?? ""
  const extraLines = commandLines.length - 1

  const meta = useMemo((): { text: string; isError?: boolean } | null => {
    switch (part.state) {
      case "input-available":
        return { text: tFlow("status.running") }
      case "approval-requested":
        return { text: tFlow("status.awaitingApproval") }
      case "output-denied":
        return { text: tFlow("status.denied") }
      case "output-error": {
        const preview = resultErrorPreview((part as { errorText?: unknown }).errorText ?? io.text)
        return { text: preview || t("errorLabel"), isError: true }
      }
      case "output-available":
        if (io.exitCode != null && io.exitCode !== 0) {
          return { text: t("exitCode", { code: io.exitCode }), isError: true }
        }
        if (io.exitCode != null) return { text: t("exitCode", { code: io.exitCode }) }
        return io.text ? { text: t("outputLines", { count: io.text.split("\n").length }) } : null
      default:
        return null
    }
  }, [part, io, t, tFlow])

  const toggle = () => (expanded !== undefined ? onToggle?.() : setInternalOpen((v) => !v))

  return (
    <ToolRowShell
      status={part.state}
      open={open}
      onToggle={toggle}
      ariaLabel={t("bashRowAria", { command: firstLine || displayTitle })}
      title={command}
      testId="terminal-tool-part"
      lead={
        <span className="shrink-0 font-mono text-xs text-muted-foreground" aria-hidden>
          $
        </span>
      }
      target={
        running && firstLine ? (
          <Shimmer as="span" className="min-w-0 flex-1 truncate font-mono text-xs" duration={1.6}>
            {firstLine}
          </Shimmer>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
            {firstLine || displayTitle}
          </span>
        )
      }
      badges={<ToolSemanticBadges readOnlyHint={readOnlyHint} />}
      meta={
        extraLines > 0 || meta ? (
          <>
            {extraLines > 0 ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {t("moreLines", { count: extraLines })}
              </span>
            ) : null}
            {meta ? (
              <span
                className={cn(
                  "shrink-0 truncate text-[11px]",
                  meta.isError ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {meta.text}
              </span>
            ) : null}
          </>
        ) : undefined
      }
      actions={
        command ? (
          <>
            <InlineCopyButton
              value={command}
              label={t("copyCommand")}
              testId="terminal-tool-copy-command"
            />
            {canRun ? (
              <TerminalTabPicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={handlePick}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  aria-label={tDock("runInDock.label")}
                  title={tDock("runInDock.label")}
                  disabled={busy}
                  data-testid="terminal-tool-part-run-in-dock"
                >
                  <TerminalSquareIcon className="size-3" />
                </Button>
              </TerminalTabPicker>
            ) : null}
          </>
        ) : undefined
      }
    >
      <BashOutputView part={part} io={io} command={command} />
    </ToolRowShell>
  )
})

export default TerminalToolPart
