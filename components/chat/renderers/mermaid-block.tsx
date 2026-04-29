"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { AlertCircle, Copy, Check, Maximize2, Code2, Download, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface MermaidBlockProps {
  content: string
  className?: string
}

export function MermaidBlock({ content, className }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fullscreenRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string>("")
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)

  const renderMermaid = useCallback(async () => {
    try {
      setIsLoading(true)
      setError(null)

      const mermaid = (await import("mermaid")).default
      const isDark = document.documentElement.classList.contains("dark")

      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "default",
        securityLevel: "loose",
        fontFamily: "system-ui, -apple-system, sans-serif",
      })

      const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const { svg: renderedSvg } = await mermaid.render(id, content.trim())

      setSvg(renderedSvg)
      setIsLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to render diagram")
      setIsLoading(false)
    }
  }, [content])

  useEffect(() => {
    let mounted = true
    const doRender = async () => {
      if (mounted) {
        await renderMermaid()
      }
    }
    void doRender()
    return () => {
      mounted = false
    }
  }, [renderMermaid])

  // Re-render on theme change.
  useEffect(() => {
    if (typeof window === "undefined") return
    const observer = new MutationObserver(() => {
      void renderMermaid()
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [renderMermaid])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error("clipboard write failed", err)
    }
  }, [content])

  const handleExportSvg = useCallback(() => {
    if (!svg) return
    const blob = new Blob([svg], { type: "image/svg+xml" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `diagram-${Date.now()}.svg`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [svg])

  const handleRetry = useCallback(() => {
    void renderMermaid()
  }, [renderMermaid])

  if (isLoading) {
    return (
      <div className={cn("my-4 rounded-lg border bg-card p-4", className)}>
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div
        className={cn(
          "flex flex-col gap-2 p-4 rounded-lg bg-destructive/10 border border-destructive/20",
          className
        )}
        role="alert"
        aria-label="Mermaid error"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm font-medium">Mermaid error</span>
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
                  aria-label="Copy source"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy source</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{error}</p>
        <pre className="mt-2 p-2 rounded bg-muted text-xs overflow-auto max-h-40">
          <code>{content}</code>
        </pre>
      </div>
    )
  }

  return (
    <>
      <div
        className={cn("group relative rounded-lg border bg-card overflow-hidden my-4", className)}
        role="figure"
        aria-label="Mermaid diagram"
      >
        <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10 bg-background/80 backdrop-blur-sm rounded-lg p-0.5">
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
                aria-label="Copy source"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy source</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handleExportSvg}
                aria-label="Export SVG"
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Export SVG</TooltipContent>
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
          <pre className="m-2 p-3 rounded-lg bg-muted/50 border text-xs overflow-auto font-mono max-h-40">
            <code>{content}</code>
          </pre>
        )}

        <div
          ref={containerRef}
          className="flex items-center justify-center overflow-auto p-4 [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>Mermaid diagram</span>
              <div className="flex items-center gap-1 ml-auto">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={handleCopy}
                      aria-label="Copy source"
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Copy source</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={handleExportSvg}
                      aria-label="Export SVG"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Export SVG</TooltipContent>
                </Tooltip>
              </div>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div
              ref={fullscreenRef}
              className="flex items-center justify-center p-4 [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />

            <details className="group">
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-2">
                <Code2 className="h-4 w-4" />
                <span>View source</span>
              </summary>
              <pre className="mt-2 p-4 rounded-lg bg-muted text-sm overflow-auto font-mono max-h-60">
                <code>{content}</code>
              </pre>
            </details>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default MermaidBlock
