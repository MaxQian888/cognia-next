"use client"

import { useMemo, useState, useCallback } from "react"
import { AlertCircle, Copy, Check, Maximize2, Code2, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { renderMathSafe } from "@/lib/latex/cache"
import { withMathErrorBoundary } from "./math-error-boundary"

interface MathBlockProps {
  content: string
  className?: string
  scale?: number
  alignment?: "center" | "left"
}

function MathBlockBase({ content, className, scale = 1, alignment = "center" }: MathBlockProps) {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)

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
    try {
      await navigator.clipboard.writeText(cleanContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error("clipboard write failed", err)
    }
  }, [cleanContent])

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
        aria-label="LaTeX error"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm font-medium">LaTeX error</span>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleRetry}
                  aria-label="Retry"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Retry</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleCopy}
                  aria-label="Copy LaTeX"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy LaTeX</TooltipContent>
            </Tooltip>
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
        aria-label="Math expression"
      >
        <div className="absolute top-0 right-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10 bg-background/80 backdrop-blur-sm rounded-lg p-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowSource(!showSource)}
                aria-label={showSource ? "Hide source" : "Show source"}
                aria-pressed={showSource}
              >
                <Code2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showSource ? "Hide source" : "Show source"}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handleCopy}
                aria-label="Copy LaTeX"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy LaTeX</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setIsFullscreen(true)}
                aria-label="View fullscreen"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>View fullscreen</TooltipContent>
          </Tooltip>
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
              <span>Math expression</span>
              <div className="flex items-center gap-1 ml-auto">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={handleCopy}
                      aria-label="Copy LaTeX"
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Copy LaTeX</TooltipContent>
                </Tooltip>
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
                <span>View source</span>
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
