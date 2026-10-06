"use client"

import { useMemo, useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { Code2, Maximize2, Sigma } from "lucide-react"
import { CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { cn } from "@/lib/utils"
import { RichBlockAction } from "@/components/chat/renderers/rich-block/rich-block-action"
import { RichBlockError } from "@/components/chat/renderers/rich-block/rich-block-error"
import { RichBlockFrame } from "@/components/chat/renderers/rich-block/rich-block-frame"
import {
  RICH_BLOCK_FULLSCREEN_ACTION_CLASS,
  RichBlockFullscreen,
} from "@/components/chat/renderers/rich-block/rich-block-fullscreen"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { renderMathSafe } from "@cognia/latex"
import { withMathErrorBoundary } from "./math-error-boundary"
import { useCopy } from "@/hooks/ui/use-copy"
import { loggers } from "@cognia/logging"

export interface MathBlockProps {
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

  if (result.error) {
    // KaTeX is deterministic, so a retry could only fail again: the error
    // offers the source and a copy action instead.
    return (
      <RichBlockError
        className={className}
        title={t("error")}
        detail={result.error}
        action={
          <RichBlockAction label={t("copyLatex")} onClick={handleCopy}>
            <CopyFeedbackIcon copied={copied} size={12} />
          </RichBlockAction>
        }
      >
        <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs">
          <code>{cleanContent}</code>
        </pre>
      </RichBlockError>
    )
  }

  const scaleStyle = scale !== 1 ? { fontSize: `${scale}em` } : undefined

  // Display math reads as prose, so the frame stays invisible until hovered
  // (ADR-0218): no border, no fill, the toolbar floating over the formula.
  return (
    <>
      <RichBlockFrame
        kind="math"
        header="overlay"
        className={cn(
          "border-transparent bg-transparent transition-colors hover:border-border/60",
          className
        )}
        role="math"
        aria-label={t("expressionLabel")}
        actions={
          <>
            <RichBlockAction
              label={showSource ? t("hideSource") : t("showSource")}
              aria-pressed={showSource}
              onClick={() => setShowSource(!showSource)}
            >
              <Code2 />
            </RichBlockAction>
            <RichBlockAction label={t("copyLatex")} onClick={handleCopy}>
              <CopyFeedbackIcon copied={copied} size={12} />
            </RichBlockAction>
            <RichBlockAction label={t("viewFullscreen")} onClick={() => setIsFullscreen(true)}>
              <Maximize2 />
            </RichBlockAction>
          </>
        }
      >
        {showSource && (
          <pre className="border-b bg-muted/40 px-3 py-2 font-mono text-xs overflow-auto">
            <code>{cleanContent}</code>
          </pre>
        )}
        <div
          className={cn(
            "overflow-x-auto px-3 py-2 katex-block",
            alignment === "left" ? "text-left" : "text-center"
          )}
          style={scaleStyle}
          dangerouslySetInnerHTML={{ __html: result.html }}
        />
      </RichBlockFrame>

      <RichBlockFullscreen
        open={isFullscreen}
        onOpenChange={setIsFullscreen}
        testId="math-fullscreen"
        icon={<Sigma />}
        title={t("expressionLabel")}
        actions={
          <TooltipIconButton
            variant="ghost"
            size="icon"
            className={RICH_BLOCK_FULLSCREEN_ACTION_CLASS}
            onClick={handleCopy}
            aria-label={t("copyLatex")}
            tooltip={t("copyLatex")}
          >
            <CopyFeedbackIcon copied={copied} size={16} />
          </TooltipIconButton>
        }
      >
        {isFullscreen ? (
          <div className="space-y-4 p-6">
            <div
              className="flex items-center justify-center p-8 text-2xl katex-block"
              dangerouslySetInnerHTML={{ __html: result.html }}
            />
            <pre className="overflow-auto rounded-lg bg-muted p-4 font-mono text-sm">
              <code>{cleanContent}</code>
            </pre>
          </div>
        ) : null}
      </RichBlockFullscreen>
    </>
  )
}

export const MathBlock = withMathErrorBoundary(MathBlockBase, (props) => props.content)
