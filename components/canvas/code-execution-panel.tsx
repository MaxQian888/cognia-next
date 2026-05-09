"use client"

/**
 * CodeExecutionPanel - Displays code execution results in Canvas
 */

import { memo } from "react"
import { useTranslations } from "next-intl"
import {
  Play,
  Square,
  CheckCircle2,
  XCircle,
  Clock,
  Terminal as TerminalIcon,
  AlertTriangle,
  Copy,
  X,
  Loader2,
} from "lucide-react"
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalHeader,
  TerminalStatus,
} from "@/components/ai-elements/terminal"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useCopy } from "@/hooks/ui"
import type { CodeSandboxExecutionResult } from "@/hooks/canvas/use-code-execution"

interface CodeExecutionPanelProps {
  result: CodeSandboxExecutionResult | null
  isExecuting: boolean
  language: string
  onExecute: () => void
  onCancel: () => void
  onClear: () => void
  className?: string
}

export const CodeExecutionPanel = memo(function CodeExecutionPanel({
  result,
  isExecuting,
  language,
  onExecute,
  onCancel,
  onClear,
  className,
}: CodeExecutionPanelProps) {
  const t = useTranslations("canvas")
  const { copy, isCopying } = useCopy()
  const terminalOutput = [result?.stdout, result?.stderr].filter(Boolean).join("\n\n")

  const handleCopyOutput = async () => {
    if (terminalOutput) {
      await copy(terminalOutput)
    }
  }

  const getStatusIcon = () => {
    if (isExecuting) {
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />
    }
    if (!result) {
      return <TerminalIcon className="h-4 w-4 text-muted-foreground" />
    }
    if (result.success) {
      return <CheckCircle2 className="h-4 w-4 text-success" />
    }
    return <XCircle className="h-4 w-4 text-destructive" />
  }

  const getStatusText = () => {
    if (isExecuting) return t("executing")
    if (!result) return t("readyToRun")
    if (result.success) return t("executionSuccess")
    return t("executionFailed")
  }

  return (
    <div className={cn("border-t flex flex-col", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          {getStatusIcon()}
          <span className="text-sm font-medium">{t("codeExecution")}</span>
          <Badge variant="outline" className="text-xs">
            {language}
          </Badge>
          {result?.isSimulated && (
            <Badge variant="secondary" className="text-xs">
              {t("simulated")}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isExecuting ? (
            <Button variant="destructive" size="sm" className="h-9 px-2" onClick={onCancel}>
              <Square className="h-3 w-3 mr-1" />
              {t("stop")}
            </Button>
          ) : (
            <Button variant="default" size="sm" className="h-9 px-2" onClick={onExecute}>
              <Play className="h-3 w-3 mr-1" />
              {t("run")}
            </Button>
          )}
        </div>
      </div>

      {/* Output */}
      {(result || isExecuting) && (
        <Terminal
          output={terminalOutput}
          isStreaming={isExecuting}
          className="flex-1 rounded-none border-0"
        >
          <TerminalHeader className="bg-popover">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <TerminalIcon className="h-4 w-4" />
                <span>{t("output")}</span>
              </div>
              {result && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {result.executionTime}ms
                  </span>
                  {result.exitCode !== null && (
                    <span
                      className={cn(
                        "flex items-center gap-1",
                        result.exitCode === 0 ? "text-success" : "text-destructive"
                      )}
                    >
                      {t("exitCode")}: {result.exitCode}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <TerminalStatus>{t("executing")}</TerminalStatus>
              <TerminalActions>
                {result && (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:bg-accent hover:text-foreground"
                          onClick={handleCopyOutput}
                          disabled={isCopying || !terminalOutput}
                          aria-label={t("copyOutput")}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("copyOutput")}</TooltipContent>
                    </Tooltip>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={onClear}
                      aria-label={t("clearOutput")}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </>
                )}
              </TerminalActions>
            </div>
          </TerminalHeader>
          <TerminalContent className="max-h-[200px] p-3 text-xs sm:text-sm">
            <div className="space-y-2">
              {isExecuting && !result && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>{t("executingCode")}</span>
                  </div>
                  <Progress value={undefined} className="h-1" />
                </div>
              )}

              {result && (
                <>
                  {/* Execution stats */}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{getStatusText()}</span>
                  </div>

                  {/* stdout */}
                  {result.stdout && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-muted-foreground">
                        {t("output")}:
                      </div>
                      <pre className="p-2 rounded bg-muted text-xs sm:text-sm font-mono whitespace-pre-wrap overflow-x-auto">
                        {result.stdout}
                      </pre>
                    </div>
                  )}

                  {/* stderr */}
                  {result.stderr && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-destructive flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        {t("errors")}:
                      </div>
                      <pre className="p-2 rounded bg-destructive/10 text-destructive text-xs sm:text-sm font-mono whitespace-pre-wrap overflow-x-auto">
                        {result.stderr}
                      </pre>
                    </div>
                  )}

                  {/* No output message */}
                  {!result.stdout && !result.stderr && result.success && (
                    <div className="text-sm italic text-muted-foreground">{t("noOutput")}</div>
                  )}
                </>
              )}
            </div>
          </TerminalContent>
        </Terminal>
      )}
    </div>
  )
})
