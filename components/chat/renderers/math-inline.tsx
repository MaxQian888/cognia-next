"use client"

import { useMemo, useState, useCallback, useContext } from "react"
import { useTranslations } from "next-intl"
import { Check, Copy } from "lucide-react"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { renderMathSafe } from "@cognia/latex"
import { InlineMathLinkContext, withMathErrorBoundary } from "./math-error-boundary"
import { useCopy } from "@/hooks/ui/use-copy"
import { loggers } from "@cognia/logging"

interface MathInlineProps {
  content: string
  className?: string
  scale?: number
  showCopyOnHover?: boolean
}

function MathInlineBase({
  content,
  className,
  scale = 1,
  showCopyOnHover = true,
}: MathInlineProps) {
  const t = useTranslations("chat.renderers.math")
  const inLink = useContext(InlineMathLinkContext)
  const [isHovered, setIsHovered] = useState(false)
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })

  const cleanContent = useMemo(() => {
    return content
      .replace(/^\$/, "")
      .replace(/\$$/, "")
      .replace(/^\\\(/, "")
      .replace(/\\\)$/, "")
      .trim()
  }, [content])

  const result = useMemo(() => {
    return renderMathSafe(cleanContent, false, { trust: false })
  }, [cleanContent])

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      await copy(cleanContent)
    },
    [copy, cleanContent]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        void copy(cleanContent)
      }
    },
    [copy, cleanContent]
  )

  if (result.error) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <code
            className={cn(
              "px-1 py-0.5 rounded bg-destructive/10 text-destructive text-sm cursor-help",
              className
            )}
            role="math"
            aria-label={t("invalidLabel", { tex: cleanContent })}
          >
            {content}
          </code>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-xs">
            <p className="font-medium text-destructive">{t("inlineErrorTitle")}</p>
            <p className="text-muted-foreground">{result.error}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    )
  }

  const scaleStyle = scale !== 1 ? { fontSize: `${scale}em` } : undefined

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "katex-inline inline-flex items-center gap-0.5 cursor-pointer",
            "hover:bg-muted/50 rounded px-0.5 -mx-0.5 transition-colors",
            className
          )}
          style={scaleStyle}
          role="math"
          aria-label={t("expressionLabelInline", { tex: cleanContent })}
          tabIndex={inLink ? undefined : 0}
          onClick={inLink ? undefined : handleCopy}
          onKeyDown={inLink ? undefined : handleKeyDown}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <span dangerouslySetInnerHTML={{ __html: result.html }} />
          {showCopyOnHover && isHovered && !inLink && (
            <span className="inline-flex items-center text-muted-foreground ml-0.5">
              <span
                aria-hidden="true"
                data-slot="copy-feedback-icon"
                data-state={copied ? "copied" : "idle"}
              >
                {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
              </span>
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-xs space-y-1">
          <p className="font-mono bg-muted px-1.5 py-0.5 rounded">{cleanContent}</p>
          {!inLink && <p className="text-muted-foreground">{t("clickToCopy")}</p>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

export const MathInline = withMathErrorBoundary(MathInlineBase, (props) => props.content, true)
