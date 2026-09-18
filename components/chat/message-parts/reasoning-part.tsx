"use client"

/**
 * The thinking block rendered as one activity-stream row (`● THINK … ▸`), not
 * a standalone section — in an agent transcript a thought is the same kind of
 * record as a tool call (Claude Code's `Thought for Ns` marker, Cursor's
 * collapsible Thinking row). The `Reasoning` wrapper above it still owns the
 * state — duration tracking, stream-aware auto-open, the `display.reasoning`
 * default — so this component is only the row chrome plus the Streamdown body.
 */

import { BrainIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Streamdown, type StreamdownProps } from "streamdown"

import { useReasoning } from "@/components/ai-elements/reasoning"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { InlineCopyButton, ToolRowShell } from "./tool-row"

export function ReasoningToolRow({
  text,
  streamdownProps,
}: {
  text: string
  streamdownProps: Omit<StreamdownProps, "children">
}) {
  const t = useTranslations("chat.message")
  const tRow = useTranslations("chat.toolRow")
  const { isOpen, setIsOpen, isStreaming, duration } = useReasoning()

  const label =
    isStreaming || duration === 0
      ? t("reasoning.streaming")
      : duration === undefined
        ? t("reasoning.completed")
        : t("reasoning.completedSeconds", { duration })

  return (
    <ToolRowShell
      // The dot follows the thought's own lifecycle: breathing blue while the
      // model is still thinking, green once this block is done even if the
      // rest of the turn is still streaming.
      status={isStreaming ? "input-available" : "output-available"}
      open={isOpen}
      onToggle={() => setIsOpen(!isOpen)}
      ariaLabel={label}
      testId="reasoning-row"
      dataKind="reasoning"
      lead={
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
          {tRow("verb.think")}
        </span>
      }
      icon={<BrainIcon className="size-3.5 text-muted-foreground" aria-hidden />}
      target={
        isStreaming ? (
          <Shimmer duration={1} className="font-mono text-xs">
            {label}
          </Shimmer>
        ) : (
          <span className="truncate font-mono text-xs text-muted-foreground">{label}</span>
        )
      }
      actions={
        text ? (
          <InlineCopyButton value={text} label={t("reasoning.copy")} testId="reasoning-copy" />
        ) : undefined
      }
    >
      <div className="mt-0.5 mb-1 text-xs leading-5 text-muted-foreground">
        <Streamdown {...streamdownProps}>{text}</Streamdown>
      </div>
    </ToolRowShell>
  )
}
