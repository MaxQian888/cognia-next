"use client"

import { useState, memo, useCallback, useRef, useEffect } from "react"
import { useTranslations } from "next-intl"
import { Copy, Check, Download, Maximize2, WrapText, Hash } from "lucide-react"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { useCopy } from "@/hooks/ui/use-copy"
import { downloadFile } from "@/lib/files/download"
import { loggers } from "@/lib/logging"
import {
  getCachedHighlight,
  highlightCached,
  type HighlightHtml,
} from "@/lib/shiki/highlight-cache"

interface CodeBlockProps {
  code: string
  language?: string
  className?: string
  showLineNumbers?: boolean
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

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  className,
  showLineNumbers = true,
  highlightLines = [],
  filename,
  isStreaming = false,
}: CodeBlockProps) {
  const t = useTranslations("chat.renderers.code")
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [localShowLineNumbers, setLocalShowLineNumbers] = useState(showLineNumbers)
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })
  const codeRef = useRef<HTMLPreElement>(null)

  // Seed synchronously from the shared highlight cache: when a virtualized row
  // scrolls back into view, an already-highlighted snippet paints coloured on
  // the very first frame (no flash of unstyled <pre>). A cold snippet starts
  // null and fills in once the async pass below resolves.
  const [highlight, setHighlight] = useState<HighlightHtml | null>(() =>
    language && code && !isStreaming ? (getCachedHighlight(code, language) ?? null) : null
  )

  useEffect(() => {
    // During streaming, skip Shiki entirely — the block's content is still
    // growing and a fresh highlight per token is the most expensive part of
    // the streaming render path. The plain-pre fallback below still renders
    // the code with line numbers and copy/download affordances, so there is no
    // visual gap; only the syntax colours are deferred. Theme/colour parity
    // with the streaming Streamdown view comes from `CHAT_CODE_THEME`, baked
    // into the cache.
    if (!language || !code || isStreaming) {
      setHighlight(null)
      return
    }

    const cached = getCachedHighlight(code, language)
    if (cached) {
      setHighlight(cached)
      return
    }

    let cancelled = false
    void highlightCached(code, language)
      .then((result) => {
        if (!cancelled) setHighlight(result)
      })
      .catch(() => {
        if (!cancelled) setHighlight(null)
      })

    return () => {
      cancelled = true
    }
  }, [code, language, isStreaming])

  const highlightedHtml = highlight?.light ?? ""
  const darkHighlightedHtml = highlight?.dark ?? ""

  const lines = code.split("\n")

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
      // Shiki HTML path (no manual line numbers).
      if (hasHighlighting && !localShowLineNumbers) {
        return (
          <div
            className={cn(
              "overflow-x-auto text-sm",
              "[&>pre]:m-0 [&>pre]:p-4 [&>pre]:bg-muted/50!",
              "[&_code]:font-mono [&_code]:text-sm",
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
            "overflow-x-auto p-4 bg-muted/50 text-sm font-mono",
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
              <span className={wordWrap ? "whitespace-pre-wrap" : "whitespace-pre"}>{code}</span>
            )}
          </code>
        </pre>
      )
    },
    [
      code,
      language,
      langLabel,
      lines,
      localShowLineNumbers,
      wordWrap,
      isLineHighlighted,
      hasHighlighting,
      highlightedHtml,
      darkHighlightedHtml,
      t,
    ]
  )

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
            {!language && !filename && <span className="font-mono">code</span>}
          </div>

          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </TooltipIconButton>

            <TooltipIconButton
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleDownload}
              aria-label={t("downloadAria")}
              tooltip={t("download")}
            >
              <Download className="h-3 w-3" />
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
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </TooltipIconButton>
                <TooltipIconButton
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleDownload}
                  aria-label={t("downloadAria")}
                  tooltip={t("download")}
                >
                  <Download className="h-3.5 w-3.5" />
                </TooltipIconButton>
              </div>
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-auto rounded-lg border">{renderCode(true)}</div>

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
