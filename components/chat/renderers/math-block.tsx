"use client"

import { useMemo, useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { AlertCircle, Copy, Check, Maximize2, Code2, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { renderMathSafe } from "@cognia/latex"
import { withMathErrorBoundary } from "./math-error-boundary"
import { useCopy } from "@/hooks/ui/use-copy"
import { loggers } from "@/lib/logging"

interface MathBlockProps {
  content: string
  className?: string
  scale?: number
  alignment?: "center" | "left"
}

function MathBlockBase({ content, className, scale = 1, alignment = "center" }: MathBlockProps) {
  const t = useTranslations("chat.renderers.math")
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })

  const cleanContent = useMemo(() => {
    return content
      .replace(/^\$\$/, "")
      .replace(/\$\$$/, "")
      .replace(/^\\\[/, "")
      .replace(/\\\]$/, "")
      .trim()
  }, [content])

  const result = useMemo(() => {
    return renderMathSafe(cleanContent, true, { trust: false })
  }, [cleanContent])

  const handleCopy = useCallback(async () => {
    await copy(cleanContent)
  }, [copy, cleanContent])

  const handleRetry = useCallback(() => {
    setShowSource(false)
  }, [])

  if (result.error) {
    return (
      <div
        className={cn(
          "flex flex-col gap-2 p-4 rounded-lg bg-destructive/10 border border-destructive/20",
          className
        )}
        role="alert"
        aria-label={t("error")}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm font-medium">{t("error")}</span>
          </div>
          <div className="flex items-center gap-1">
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRetry}
              aria-label={t("retry")}
              tooltip={t("retry")}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </TooltipIconButton>
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleCopy}
              aria-label={t("copyLatex")}
              tooltip={t("copyLatex")}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </TooltipIconButton>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{result.error}</p>
        <pre className="mt-2 p-2 rounded bg-muted text-xs overflow-auto">
          <code>{cleanContent}</code>
        </pre>
      </div>
    )
  }

  const scaleStyle = scale !== 1 ? { fontSize: `${scale}em` } : undefined

  return (
    <>
      <div
        className={cn("group relative my-4 rounded-lg", className)}
        role="math"
        aria-label={t("expressionLabel")}
      >
        <div className="absolute top-0 right-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10 bg-background/80 rounded-lg p-0.5">
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setShowSource(!showSource)}
            aria-label={showSource ? t("hideSource") : t("showSource")}
            aria-pressed={showSource}
            tooltip={showSource ? t("hideSource") : t("showSource")}
          >
            <Code2 className="h-3.5 w-3.5" />
          </TooltipIconButton>

          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleCopy}
            aria-label={t("copyLatex")}
            tooltip={t("copyLatex")}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </TooltipIconButton>

          <TooltipIconButton
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setIsFullscreen(true)}
            aria-label={t("viewFullscreen")}
            tooltip={t("viewFullscreen")}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </TooltipIconButton>
        </div>

        {showSource && (
          <pre className="mb-2 p-3 rounded-lg bg-muted/50 border text-xs overflow-auto font-mono">
            <code>{cleanContent}</code>
          </pre>
        )}

        <div
          className={cn(
            "overflow-x-auto py-2 katex-block",
            alignment === "left" ? "text-left" : "text-center"
          )}
          style={scaleStyle}
          dangerouslySetInnerHTML={{ __html: result.html }}
        />
      </div>

      <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>{t("expressionLabel")}</span>
              <div className="flex items-center gap-1 ml-auto">
                <TooltipIconButton
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleCopy}
                  aria-label={t("copyLatex")}
                  tooltip={t("copyLatex")}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </TooltipIconButton>
              </div>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div
              className="flex items-center justify-center p-8 text-2xl katex-block"
              dangerouslySetInnerHTML={{ __html: result.html }}
            />

            <details className="group">
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-2">
                <Code2 className="h-4 w-4" />
                <span>{t("viewSource")}</span>
              </summary>
              <pre className="mt-2 p-4 rounded-lg bg-muted text-sm overflow-auto font-mono">
                <code>{cleanContent}</code>
              </pre>
            </details>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export const MathBlock = withMathErrorBoundary(MathBlockBase, (props) => props.content)
