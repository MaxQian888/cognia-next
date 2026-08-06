"use client"

/**
 * AI Shell panel — the main container for the interactive AI command planner.
 *
 * Slides in from the right side of the terminal dock (same pattern as
 * `TerminalHistoryPanel`). Contains:
 *   - Context bar (CWD, shell, branch)
 *   - Message history (scrollable)
 *   - Execution plan view (with step status)
 *   - Natural language input
 */

import { useCallback, useRef, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import {
  BotIcon,
  CircleStopIcon,
  PlayIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { MotionPopover } from "@/components/chat/motion/motion-reveal"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

import type { UseAiShellState, UseAiShellActions } from "@/hooks/terminal/use-ai-shell"
import { AiShellPlanView } from "./ai-shell-plan-view"

export interface AiShellPanelProps {
  state: UseAiShellState
  actions: UseAiShellActions
  className?: string
}

export function AiShellPanel({ state, actions, className }: AiShellPanelProps) {
  const t = useTranslations("terminal.aiShell")
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [inputValue, setInputValue] = useState("")

  const handleSubmit = useCallback(() => {
    if (!inputValue.trim()) return
    void actions.submit(inputValue.trim())
    setInputValue("")
  }, [inputValue, actions])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  return (
    <MotionPopover
      open={state.open}
      className={cn("absolute right-0 top-0 z-10 h-full", className)}
      from={{ opacity: 0, x: "100%" }}
    >
      <aside
        role="complementary"
        data-testid="ai-shell-panel"
        className="flex h-full w-80 flex-col border-l bg-background/95 backdrop-blur"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="flex items-center gap-1.5">
            <SparklesIcon className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium">{t("title")}</span>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={actions.clearHistory}
              aria-label={t("history.clear")}
              data-testid="ai-shell-clear"
            >
              <Trash2Icon className="h-3 w-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={actions.closePanel}
              aria-label={t("toggle")}
              data-testid="ai-shell-close"
            >
              <XIcon className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Messages + Plan */}
        <ScrollArea className="flex-1 px-3 py-2">
          {state.messages.length === 0 && !state.plan ? (
            <p
              className="py-4 text-center text-[11px] text-muted-foreground"
              data-testid="ai-shell-empty"
            >
              {t("history.empty")}
            </p>
          ) : (
            <div className="flex flex-col gap-2" data-testid="ai-shell-messages">
              {state.messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-[11px]",
                    msg.role === "user"
                      ? "ml-4 bg-primary/10 text-foreground"
                      : msg.role === "assistant"
                        ? "mr-4 bg-muted text-foreground"
                        : "bg-destructive/10 text-destructive"
                  )}
                  data-testid={`ai-shell-msg-${msg.role}`}
                >
                  {msg.role === "assistant" && (
                    <BotIcon className="mb-0.5 mr-1 inline h-3 w-3 text-primary" />
                  )}
                  {msg.content}
                </div>
              ))}
            </div>
          )}

          {/* Execution Plan */}
          {state.plan && (
            <AiShellPlanView
              plan={state.plan}
              generating={state.generating}
              executing={state.executing}
              advisory={state.advisory}
              advisoryLoading={state.advisoryLoading}
              onRunAll={actions.runAll}
              onRunNext={actions.runNextStep}
              onSkip={actions.skipStep}
              onEdit={actions.editStep}
              onCancel={actions.cancel}
              onRequestAdvisory={actions.requestAdvisory}
              onApplyFix={actions.applyFix}
            />
          )}
        </ScrollArea>

        {/* Input */}
        <div className="border-t px-3 py-2">
          <div className="flex items-end gap-1.5">
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("inputPlaceholder")}
              className="flex-1 resize-none rounded-md border bg-muted/50 px-2 py-1.5 text-[11px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              rows={2}
              disabled={state.generating || state.executing}
              data-testid="ai-shell-input"
            />
            <Button
              size="icon"
              variant="default"
              className="h-7 w-7"
              onClick={handleSubmit}
              disabled={!inputValue.trim() || state.generating || state.executing}
              aria-label={t("send")}
              data-testid="ai-shell-send"
            >
              {state.generating || state.executing ? (
                <CircleStopIcon className="h-3.5 w-3.5" />
              ) : (
                <PlayIcon className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>
      </aside>
    </MotionPopover>
  )
}
