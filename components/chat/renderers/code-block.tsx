"use client"

import { useState, memo, useCallback, useRef, useEffect } from "react"
import { useTranslations } from "next-intl"
import { Maximize2, WrapText, Hash } from "lucide-react"
import { AnimatedActionIcon, CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { useCopy } from "@/hooks/ui/use-copy"
import { downloadFile } from "@/lib/files/download"
import { loggers } from "@cognia/logging"
import {
  getCachedHighlight,
  highlightCached,
  type HighlightHtml,
} from "@/lib/shiki/highlight-cache"

export interface CodeBlockProps {
  code: string
  language?: string
  className?: string
  showLineNumbers?: boolean
  /**
   * Default soft-wrap (ADR-0127: from `messageDisplay.markdown.codeWrap`). The
   * toolbar toggle is an ephemeral per-block override on top of this default,
   * so a later settings change still reaches every block the user has not
   * touched.
   */
  wrapLines?: boolean
  highlightLines?: number[]
  filename?: string
  /**
   * When true, skip async Shiki highlighting and fall back to plain
   * `<pre>` rendering. Set by the parent MarkdownRenderer when the host
   * message is actively streaming — without this gate, each token append
   * triggers a fresh `codeToHtml()` call that re-parses the entire block.
   * Once streaming finalises, the parent flips the flag and Shiki kicks in.
   */
  isStreaming?: boolean
}

/**
 * Lines rendered before the block truncates itself.
 *
 * A tool that dumps a whole file can hand the transcript tens of thousands of
 * lines. Every one of them is a Shiki parse and a DOM row, on the main thread,
 * for a block the reader is usually scrolling past — the benchmark's
 * robustness tier measured an 8-second frame on a single 10k-line fence. The
 * cap is render-only: copy, download, search and export all still see the whole
 * thing.
 */
export const CODE_AUTO_RENDER_MAX_LINES = 2000

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  className,
  showLineNumbers = true,
  wrapLines = false,
  highlightLines = [],
  filename,
  isStreaming = false,
}: CodeBlockProps) {
  const t = useTranslations("chat.renderers.code")
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Per-block overrides: `null` = follow the prop default. Deriving the
  // effective value during render (instead of seeding `useState` from the
  // prop) means a settings change after mount still applies to untouched
  // blocks, without a set-state-in-effect.
  const [wordWrapOverride, setWordWrapOverride] = useState<boolean | null>(null)
  const [lineNumbersOverride, setLineNumbersOverride] = useState<boolean | null>(null)
  const wordWrap = wordWrapOverride ?? wrapLines
  const localShowLineNumbers = lineNumbersOverride ?? showLineNumbers
  const setWordWrap = (next: boolean) => setWordWrapOverride(next)
  const setLocalShowLineNumbers = (next: boolean) => setLineNumbersOverride(next)
  const [showAllLines, setShowAllLines] = useState(false)
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })
  const codeRef = useRef<HTMLPreElement>(null)

  const allLines = code.split("\n")
  const truncated = !showAllLines && allLines.length > CODE_AUTO_RENDER_MAX_LINES
  // Everything downstream — highlighting included — works off the visible
  // slice, so an oversized block costs no more than a capped one.
  const visibleCode = truncated ? allLines.slice(0, CODE_AUTO_RENDER_MAX_LINES).join("\n") : code

  // Seed synchronously from the shared highlight cache: when a virtualized row
  // scrolls back into view, an already-highlighted snippet paints coloured on
  // the very first frame (no flash of unstyled <pre>). A cold snippet starts
  // null and fills in once the async pass below resolves.
  const [highlight, setHighlight] = useState<HighlightHtml | null>(() =>
    language && visibleCode && !isStreaming
      ? (getCachedHighlight(visibleCode, language) ?? null)
      : null
  )

  useEffect(() => {
    // During streaming, skip Shiki entirely — the block's content is still
    // growing and a fresh highlight per token is the most expensive part of
    // the streaming render path. The plain-pre fallback below still renders
    // the code with line numbers and copy/download affordances, so there is no
    // visual gap; only the syntax colours are deferred. Theme/colour parity
    // with the streaming Streamdown view comes from `CHAT_CODE_THEME`, baked
    // into the cache.
    if (!language || !visibleCode || isStreaming) {
      setHighlight(null)
      return
    }

    const cached = getCachedHighlight(visibleCode, language)
    if (cached) {
      setHighlight(cached)
      return
    }

    let cancelled = false
    void highlightCached(visibleCode, language)
      .then((result) => {
        if (!cancelled) setHighlight(result)
      })
      .catch(() => {
        if (!cancelled) setHighlight(null)
      })

    return () => {
      cancelled = true
    }
  }, [visibleCode, language, isStreaming])

  const highlightedHtml = highlight?.light ?? ""
  const darkHighlightedHtml = highlight?.dark ?? ""

  const lines = truncated ? allLines.slice(0, CODE_AUTO_RENDER_MAX_LINES) : allLines

  const handleCopy = useCallback(async () => {
    await copy(code)
  }, [code, copy])

  const handleDownload = useCallback(() => {
    const extension = getExtensionFromLanguage(language)
    const name = filename || `code${extension}`
    downloadFile(name, code, "text/plain;charset=utf-8")
  }, [code, language, filename])

  const isLineHighlighted = useCallback(
    (lineNumber: number) => highlightLines.includes(lineNumber),
    [highlightLines]
  )

  const hasHighlighting = Boolean(highlightedHtml && darkHighlightedHtml)
  const langLabel = language || t("plainText")

  const renderCode = useCallback(
    (inFullscreen = false) => {
      // Shiki HTML path. Line numbers are layered on via the `.code-line-numbers`
      // CSS counter (globals.css) targeting Shiki's per-line `.line` spans, so
      // colour and line numbers co-exist — the default `showLineNumbers` view no
      // longer drops syntax colour. `highlightLines` (explicit per-line emphasis)
      // is the one case that still needs the manual table below, so it opts out.
      if (hasHighlighting && highlightLines.length === 0) {
        return (
          <div
            className={cn(
              "code-scroll-x overflow-x-auto text-sm",
              "[&>pre]:m-0 [&>pre]:p-4 [&>pre]:bg-muted/50!",
              "[&_code]:font-mono [&_code]:text-sm",
              localShowLineNumbers && "code-line-numbers",
              wordWrap && "[&>pre]:whitespace-pre-wrap",
              inFullscreen && "max-h-[70vh]"
            )}
            role="code"
            aria-label={t("ariaInLanguage", { language: langLabel })}
          >
            <div className="dark:hidden" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
            <div
              className="hidden dark:block"
              dangerouslySetInnerHTML={{ __html: darkHighlightedHtml }}
            />
          </div>
        )
      }

      // Manual line-numbered fallback.
      return (
        <pre
          ref={inFullscreen ? undefined : codeRef}
          className={cn(
            "code-scroll-x overflow-x-auto p-4 bg-muted/50 text-sm font-mono",
            wordWrap && "whitespace-pre-wrap wrap-break-word",
            inFullscreen && "max-h-[70vh]"
          )}
        >
          <code
            className={language ? `language-${language}` : undefined}
            role="code"
            aria-label={t("ariaInLanguage", { language: langLabel })}
          >
            {localShowLineNumbers ? (
              <table className="border-collapse w-full" role="presentation">
                <tbody>
                  {lines.map((line, i) => (
                    <tr
                      key={i}
                      className={cn("leading-relaxed", isLineHighlighted(i + 1) && "bg-primary/10")}
                    >
                      <td
                        className="pr-4 text-right text-muted-foreground select-none w-8 align-top border-r border-muted mr-2"
                        aria-hidden="true"
                      >
                        {i + 1}
                      </td>
                      <td
                        className={cn("pl-4", wordWrap ? "whitespace-pre-wrap" : "whitespace-pre")}
                      >
                        {line || " "}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span className={wordWrap ? "whitespace-pre-wrap" : "whitespace-pre"}>
                {visibleCode}
              </span>
            )}
          </code>
        </pre>
      )
    },
    [
      visibleCode,
      language,
      langLabel,
      lines,
      localShowLineNumbers,
      wordWrap,
      isLineHighlighted,
      highlightLines,
      hasHighlighting,
      highlightedHtml,
      darkHighlightedHtml,
      t,
    ]
  )

  const truncationFooter = truncated ? (
    <div className="flex items-center justify-between gap-2 border-t bg-muted/40 px-4 py-2 text-xs">
      <span className="text-muted-foreground">
        {t("truncatedNotice", {
          shown: CODE_AUTO_RENDER_MAX_LINES,
          total: allLines.length,
        })}
      </span>
      <button
        type="button"
        onClick={() => setShowAllLines(true)}
        className="rounded px-2 py-1 font-medium text-primary hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none"
      >
        {t("showAllLines")}
      </button>
    </div>
  ) : null

  return (
    <>
      <div
        className={cn("group relative rounded-lg overflow-hidden my-3 border", className)}
        role="figure"
        aria-label={language ? t("figureLabelWithLang", { language }) : t("figureLabel")}
      >
        <div className="flex items-center justify-between px-4 py-2 bg-muted/80 border-b text-xs">
          <div className="flex items-center gap-2 text-muted-foreground">
            {language && <span className="font-mono font-medium">{language}</span>}
            {filename && <span className="text-muted-foreground/60">{filename}</span>}
            {!language && !filename && (
              <span className="font-mono">{/* i18n-exempt: generic fallback label */}code</span>
            )}
          </div>

          {/* Hover-revealed on fine pointers; always visible on touch, where
              there is no hover to reveal it (copy/download/fullscreen would
              otherwise be unreachable on mobile). */}
          <div
            data-message-rich-control
            className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity"
          >
            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setLocalShowLineNumbers(!localShowLineNumbers)}
              aria-label={localShowLineNumbers ? t("hideLinesAria") : t("showLinesAria")}
              aria-pressed={localShowLineNumbers}
              tooltip={localShowLineNumbers ? t("hideLines") : t("showLines")}
            >
              <Hash className="h-3 w-3" />
            </TooltipIconButton>

            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setWordWrap(!wordWrap)}
              aria-label={wordWrap ? t("unwrapAria") : t("wrapAria")}
              aria-pressed={wordWrap}
              tooltip={wordWrap ? t("unwrap") : t("wrap")}
            >
              <WrapText className="h-3 w-3" />
            </TooltipIconButton>

            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleCopy}
              aria-label={t("copyAria")}
              tooltip={t("copy")}
            >
              <CopyFeedbackIcon copied={copied} size={12} />
            </TooltipIconButton>

            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleDownload}
              aria-label={t("downloadAria")}
              tooltip={t("download")}
            >
              <AnimatedActionIcon icon={AnimatedDownloadIcon} size={12} />
            </TooltipIconButton>

            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setIsFullscreen(true)}
              aria-label={t("fullscreenAria")}
              tooltip={t("fullscreen")}
            >
              <Maximize2 className="h-3 w-3" />
            </TooltipIconButton>
          </div>
        </div>

        {renderCode(false)}
        {truncationFooter}
      </div>

      <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>{language || t("defaultLabel")}</span>
              {filename && <span className="text-muted-foreground font-normal">— {filename}</span>}
              <div className="flex items-center gap-1 ml-auto">
                <TooltipIconButton
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setLocalShowLineNumbers(!localShowLineNumbers)}
                  aria-label={localShowLineNumbers ? t("hideLinesAria") : t("showLinesAria")}
                  tooltip={localShowLineNumbers ? t("hideLines") : t("showLines")}
                >
                  <Hash className="h-3.5 w-3.5" />
                </TooltipIconButton>
                <TooltipIconButton
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setWordWrap(!wordWrap)}
                  aria-label={wordWrap ? t("unwrapAria") : t("wrapAria")}
                  tooltip={wordWrap ? t("unwrap") : t("wrap")}
                >
                  <WrapText className="h-3.5 w-3.5" />
                </TooltipIconButton>
                <TooltipIconButton
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleCopy}
                  aria-label={t("copyAria")}
                  tooltip={t("copy")}
                >
                  <CopyFeedbackIcon copied={copied} size={14} />
                </TooltipIconButton>
                <TooltipIconButton
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleDownload}
                  aria-label={t("downloadAria")}
                  tooltip={t("download")}
                >
                  <AnimatedActionIcon icon={AnimatedDownloadIcon} size={14} />
                </TooltipIconButton>
              </div>
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-auto rounded-lg border">
            {renderCode(true)}
            {truncationFooter}
          </div>

          <div className="text-xs text-muted-foreground pt-2">
            {t("footer", { lineCount: lines.length, charCount: code.length })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
})

function getExtensionFromLanguage(language?: string): string {
  if (!language) return ".txt"

  const extensions: Record<string, string> = {
    javascript: ".js",
    typescript: ".ts",
    jsx: ".jsx",
    tsx: ".tsx",
    python: ".py",
    java: ".java",
    c: ".c",
    cpp: ".cpp",
    csharp: ".cs",
    go: ".go",
    rust: ".rs",
    ruby: ".rb",
    php: ".php",
    swift: ".swift",
    kotlin: ".kt",
    scala: ".scala",
    html: ".html",
    css: ".css",
    scss: ".scss",
    sass: ".sass",
    less: ".less",
    json: ".json",
    yaml: ".yaml",
    yml: ".yml",
    xml: ".xml",
    markdown: ".md",
    md: ".md",
    sql: ".sql",
    bash: ".sh",
    shell: ".sh",
    sh: ".sh",
    powershell: ".ps1",
    dockerfile: ".dockerfile",
    makefile: "Makefile",
    graphql: ".graphql",
    vue: ".vue",
    svelte: ".svelte",
    r: ".r",
    matlab: ".m",
    lua: ".lua",
    perl: ".pl",
    haskell: ".hs",
    elixir: ".ex",
    erlang: ".erl",
    clojure: ".clj",
    dart: ".dart",
    zig: ".zig",
    nim: ".nim",
    ocaml: ".ml",
    fsharp: ".fs",
    toml: ".toml",
    ini: ".ini",
    env: ".env",
  }

  return extensions[language.toLowerCase()] || `.${language.toLowerCase()}`
}

export default CodeBlock
