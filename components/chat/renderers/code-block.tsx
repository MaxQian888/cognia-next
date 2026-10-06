"use client"

import { useState, memo, useCallback, useRef, useEffect, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Code2, Expand, ListOrdered, WrapText } from "lucide-react"
import { AnimatedActionIcon, CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"
import { cn } from "@/lib/utils"
import { RichBlockAction } from "@/components/chat/renderers/rich-block/rich-block-action"
import { RichBlockFrame } from "@/components/chat/renderers/rich-block/rich-block-frame"
import { CodeBlockFullscreen } from "@/components/chat/renderers/code-block-fullscreen"
import { useCopy } from "@/hooks/ui/use-copy"
import { downloadFile } from "@/lib/files/download"
import { loggers } from "@cognia/logging"
import { CHAT_CODE_THEME, type ChatCodeThemePair } from "@/lib/chat/code-theme"
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
   * Number the gutter shows on the first line (default 1). A file-tool read of
   * an `offset` window passes the window's first line so the gutter keeps the
   * file's own numbering. `highlightLines` uses the same numbering.
   */
  startLineNumber?: number
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
  /**
   * Tighter chrome for a block nested inside another component's surface —
   * the file-tool row expansions, where the standalone margin / header height
   * / padding tuned for prose reads as a loose card-in-card. Same features,
   * denser packing; fullscreen keeps the same density.
   */
  compact?: boolean
  /**
   * Replaces the header's left label (default: language + filename). File-tool
   * bodies pass a workbench link so the header doubles as the file identity —
   * `language` then drops to a muted suffix. `filename` still feeds the
   * download name independently.
   */
  headerTitle?: React.ReactNode
  /**
   * ADR-0218 — the resolved `markdown.codeTheme` pair, the same one the
   * streaming branch hands Streamdown. Defaults to `CHAT_CODE_THEME`.
   */
  theme?: ChatCodeThemePair
  /**
   * ADR-0218 — cap the body at `--rich-code-max-h` (the `codeMaxHeight`
   * setting) and scroll inside it. Chat messages opt in; tool cards, which
   * own their own height, do not. Fullscreen is never capped.
   */
  capHeight?: boolean
  /** Extra header actions (the chat renderer's "create artifact"). */
  extraActions?: React.ReactNode
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

/**
 * The code surface and its header strip — theme tokens only, so the block
 * reads as part of the app in light and dark alike (the same `bg-muted/40`
 * as the tool-row blocks it nests among) rather than as a Shiki theme card.
 */
const CODE_SURFACE = "bg-muted/40"

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  className,
  showLineNumbers = true,
  startLineNumber = 1,
  wrapLines = false,
  highlightLines = [],
  filename,
  isStreaming = false,
  compact = false,
  headerTitle,
  theme = CHAT_CODE_THEME,
  capHeight = false,
  extraActions,
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

  // Count without retaining an array for the hidden tail. Toolbar changes
  // reuse this scan; only the rendered prefix is split into individual lines.
  const { totalLines, previewEnd } = useMemo(() => {
    let totalLines = 1
    let previewEnd = code.length
    let from = 0
    for (
      let newline = code.indexOf("\n", from);
      newline !== -1;
      newline = code.indexOf("\n", from)
    ) {
      if (totalLines === CODE_AUTO_RENDER_MAX_LINES) previewEnd = newline
      totalLines++
      from = newline + 1
    }
    return { totalLines, previewEnd }
  }, [code])
  const truncated = !showAllLines && totalLines > CODE_AUTO_RENDER_MAX_LINES
  const visibleCode = truncated ? code.slice(0, previewEnd) : code
  const lines = useMemo(() => visibleCode.split("\n"), [visibleCode])

  // Seed synchronously from the shared highlight cache: when a virtualized row
  // scrolls back into view, an already-highlighted snippet paints coloured on
  // the very first frame (no flash of unstyled <pre>). A cold snippet starts
  // null and fills in once the async pass below resolves.
  const [highlight, setHighlight] = useState<{
    code: string
    language: string
    theme: ChatCodeThemePair
    html: HighlightHtml
  } | null>(() => {
    const html =
      language && visibleCode && !isStreaming
        ? getCachedHighlight(visibleCode, language, theme)
        : undefined
    return html && language ? { code: visibleCode, language, theme, html } : null
  })

  useEffect(() => {
    // During streaming, skip Shiki entirely — the block's content is still
    // growing and a fresh highlight per token is the most expensive part of
    // the streaming render path. The plain-pre fallback below still renders
    // the code with line numbers and copy/download affordances, so there is no
    // visual gap; only the syntax colours are deferred. Theme/colour parity
    // with the streaming Streamdown view comes from the shared theme pair
    // (ADR-0218), baked into the cache key.
    if (!language || !visibleCode || isStreaming) {
      setHighlight(null)
      return
    }

    const cached = getCachedHighlight(visibleCode, language, theme)
    if (cached) {
      setHighlight({ code: visibleCode, language, theme, html: cached })
      return
    }

    let cancelled = false
    void highlightCached(visibleCode, language, theme)
      .then((result) => {
        if (!cancelled) setHighlight({ code: visibleCode, language, theme, html: result })
      })
      .catch(() => {
        if (!cancelled) setHighlight(null)
      })

    return () => {
      cancelled = true
    }
  }, [visibleCode, language, isStreaming, theme])

  // A prop change must show the new source immediately, while its async
  // highlight is pending; retaining the previous HTML would display old code.
  const currentHighlight =
    !isStreaming &&
    highlight?.code === visibleCode &&
    highlight.language === language &&
    highlight.theme.light === theme.light &&
    highlight.theme.dark === theme.dark
      ? highlight.html
      : null
  const highlightedHtml = currentHighlight?.light ?? ""
  const darkHighlightedHtml = currentHighlight?.dark ?? ""

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
        // Shiki's `<pre>` sits one level down (inside the light / dark theme
        // wrappers), so the rules target `[&_pre]` — a `[&>pre]` selector never
        // matched, which let each theme's own background (one-dark-pro's blue
        // slate) and zero padding through instead of the app's surface.
        const offsetGutter = localShowLineNumbers && startLineNumber !== 1
        return (
          <div
            className={cn(
              "code-scroll-x overflow-x-auto",
              CODE_SURFACE,
              compact ? "text-xs" : "text-sm",
              compact ? "[&_pre]:p-2.5" : "[&_pre]:p-4",
              "[&_pre]:m-0 [&_pre]:bg-transparent!",
              "[&_code]:font-mono",
              compact ? "[&_code]:text-xs" : "[&_code]:text-sm",
              localShowLineNumbers && "code-line-numbers",
              // The gutter counter (globals.css) resets to 0 per `<code>`; an
              // offset window resets it to `start - 1` instead.
              offsetGutter && "[&_.shiki_code]:[counter-reset:shiki-line_var(--code-line-offset)]!",
              wordWrap && "[&_pre]:whitespace-pre-wrap"
            )}
            style={
              offsetGutter
                ? ({ "--code-line-offset": String(startLineNumber - 1) } as React.CSSProperties)
                : undefined
            }
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
            "code-scroll-x overflow-x-auto font-mono",
            CODE_SURFACE,
            compact ? "p-2.5 text-xs" : "p-4 text-sm",
            wordWrap && "whitespace-pre-wrap wrap-break-word"
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
                      className={cn(
                        compact ? "leading-5" : "leading-relaxed",
                        isLineHighlighted(startLineNumber + i) && "bg-primary/10"
                      )}
                    >
                      <td
                        className={cn(
                          "text-right text-muted-foreground select-none align-top border-r border-muted",
                          compact ? "pr-2 w-6" : "pr-4 w-8 mr-2"
                        )}
                        aria-hidden="true"
                      >
                        {startLineNumber + i}
                      </td>
                      <td
                        className={cn(
                          compact ? "pl-2" : "pl-4",
                          wordWrap ? "whitespace-pre-wrap" : "whitespace-pre"
                        )}
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
      compact,
      startLineNumber,
      t,
    ]
  )

  const truncationFooter = truncated ? (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-t bg-muted/40",
        compact ? "px-2.5 py-1 text-[11px]" : "px-4 py-2 text-xs"
      )}
    >
      <span className="text-muted-foreground">
        {t("truncatedNotice", {
          shown: CODE_AUTO_RENDER_MAX_LINES,
          total: totalLines,
        })}
      </span>
      <button
        type="button"
        data-scroll-disclosure
        onClick={() => setShowAllLines(true)}
        className={cn(
          "rounded font-medium text-primary hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none",
          compact ? "px-1.5 py-0.5" : "px-2 py-1"
        )}
      >
        {t("showAllLines")}
      </button>
    </div>
  ) : null

  const actions = (
    <>
      {extraActions}
      <RichBlockAction
        compact={compact}
        onClick={() => setLocalShowLineNumbers(!localShowLineNumbers)}
        label={localShowLineNumbers ? t("hideLinesAria") : t("showLinesAria")}
        tooltip={localShowLineNumbers ? t("hideLines") : t("showLines")}
        aria-pressed={localShowLineNumbers}
      >
        <ListOrdered />
      </RichBlockAction>
      <RichBlockAction
        compact={compact}
        onClick={() => setWordWrap(!wordWrap)}
        label={wordWrap ? t("unwrapAria") : t("wrapAria")}
        tooltip={wordWrap ? t("unwrap") : t("wrap")}
        aria-pressed={wordWrap}
      >
        <WrapText />
      </RichBlockAction>
      <RichBlockAction
        compact={compact}
        onClick={handleCopy}
        label={t("copyAria")}
        tooltip={t("copy")}
      >
        <CopyFeedbackIcon copied={copied} size={compact ? 10 : 12} />
      </RichBlockAction>
      <RichBlockAction
        compact={compact}
        onClick={handleDownload}
        label={t("downloadAria")}
        tooltip={t("download")}
      >
        <AnimatedActionIcon icon={AnimatedDownloadIcon} size={compact ? 10 : 12} />
      </RichBlockAction>
      <RichBlockAction
        compact={compact}
        onClick={() => setIsFullscreen(true)}
        label={t("fullscreenAria")}
        tooltip={t("fullscreen")}
      >
        <Expand />
      </RichBlockAction>
    </>
  )

  const headerLabel = headerTitle ? (
    <span className="font-mono">{headerTitle}</span>
  ) : (
    <span className="font-mono">
      {language || (filename ? null : /* i18n-exempt: generic fallback label */ "code")}
    </span>
  )
  const headerMeta = headerTitle ? (language ? `· ${language}` : null) : filename || null

  return (
    <>
      <RichBlockFrame
        kind="code"
        compact={compact}
        className={className}
        role="figure"
        aria-label={language ? t("figureLabelWithLang", { language }) : t("figureLabel")}
        icon={<Code2 />}
        label={headerLabel}
        meta={headerMeta}
        actions={actions}
        bodyClassName={cn(
          capHeight && "max-h-(--rich-code-max-h) overflow-y-auto overscroll-contain"
        )}
        footer={truncationFooter}
      >
        {renderCode(false)}
      </RichBlockFrame>

      <CodeBlockFullscreen
        open={isFullscreen}
        onOpenChange={setIsFullscreen}
        filename={filename}
        languageLabel={langLabel}
        lineCount={totalLines}
        charCount={code.length}
        showLineNumbers={localShowLineNumbers}
        onToggleLineNumbers={() => setLocalShowLineNumbers(!localShowLineNumbers)}
        wordWrap={wordWrap}
        onToggleWordWrap={() => setWordWrap(!wordWrap)}
        copied={copied}
        onCopy={() => void handleCopy()}
        onDownload={handleDownload}
      >
        {isFullscreen ? renderCode(true) : null}
        {isFullscreen ? truncationFooter : null}
      </CodeBlockFullscreen>
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
