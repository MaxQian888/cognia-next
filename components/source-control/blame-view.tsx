"use client"

/**
 * BlameView — GitHub-style per-line authorship for a working-tree file. Each
 * source line shows its line number and content; a left gutter carries the
 * commit annotation (shortHash · author), shown once per run of consecutive
 * lines from the same commit and colored per-commit via the shared lane
 * palette. Rendered as plain HTML (no Monaco) so it's deterministic and the
 * authorship — the point of blame — stays fully testable.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import type { CSSProperties } from "react"
import type { BundledLanguage, ThemedToken } from "shiki"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { colorForHash } from "@/lib/git/lane-palette"
import { languageFromPath } from "@/lib/git/language-map"
import { getShikiLanguage } from "@/lib/artifacts/constants"
import { highlightCode } from "@/components/ai-elements/code-block"
import { gitBlame } from "@/lib/git/commands"
import type { GitBlameLine } from "@/types/git"

interface BlameViewProps {
  rootDir: string
  path: string
}

function isUncommitted(hash: string): boolean {
  return /^0+$/.test(hash)
}

/** Render one shiki-tokenized line; dark colors come via the `--shiki-dark` var. */
function HighlightedLine({ tokens }: { tokens: ThemedToken[] }) {
  if (tokens.length === 0) return <span> </span>
  return (
    <>
      {tokens.map((token, i) => (
        <span
          key={i}
          className="dark:!text-[var(--shiki-dark)]"
          style={{ color: token.color, ...token.htmlStyle } as CSSProperties}
        >
          {token.content}
        </span>
      ))}
    </>
  )
}

export function BlameView({ rootDir, path }: BlameViewProps) {
  const t = useTranslations("sourceControl")
  const colors = useThemeColors()
  const [lines, setLines] = useState<GitBlameLine[] | null>(null)
  // Per-line syntax tokens (shiki). Null until/unless highlighting resolves —
  // the view always renders plain content as a fallback.
  const [tokenLines, setTokenLines] = useState<ThemedToken[][] | null>(null)

  // The panel re-keys this component by path, so it mounts fresh per file —
  // no in-effect state reset is needed (which would trip set-state-in-effect).
  useEffect(() => {
    let alive = true
    void gitBlame(rootDir, path).then((l) => {
      if (alive) setLines(l)
    })
    return () => {
      alive = false
    }
  }, [rootDir, path])

  const shikiLang = useMemo(() => getShikiLanguage(languageFromPath(path) ?? undefined), [path])

  useEffect(() => {
    if (!lines || lines.length === 0 || shikiLang === "text") return
    let alive = true
    const code = lines.map((l) => l.content).join("\n")
    // Set tokens only via async paths (the highlight callback, or a microtask
    // for a cache hit) — never synchronously inside the effect body.
    const initial = highlightCode(code, shikiLang as BundledLanguage, (res) => {
      if (alive) setTokenLines(res.tokens)
    })
    if (initial) queueMicrotask(() => alive && setTokenLines(initial.tokens))
    return () => {
      alive = false
    }
  }, [lines, shikiLang])

  if (lines === null) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        data-testid="blame-loading"
      >
        <Spinner className="mr-2 size-4" />
        {t("blame.loading")}
      </div>
    )
  }

  if (lines.length === 0) {
    return (
      <Empty className="h-full border-0" data-testid="blame-empty">
        <EmptyHeader>
          <EmptyDescription>{t("blame.empty")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ScrollArea className="h-full" data-testid="blame-view">
      <div className="min-w-max font-mono text-xs">
        {lines.map((ln, i) => {
          const prev = lines[i - 1]
          const sameAsPrev = prev?.commitHash === ln.commitHash
          const uncommitted = isUncommitted(ln.commitHash)
          const color = uncommitted
            ? "var(--muted-foreground)"
            : colorForHash(colors, ln.commitHash)
          const when = ln.authoredAtMs ? new Date(ln.authoredAtMs).toLocaleDateString() : ""
          return (
            <div
              key={ln.lineNumber}
              className="flex items-stretch hover:bg-accent/50"
              data-testid={`blame-line-${ln.lineNumber}`}
            >
              <div
                className="flex w-44 shrink-0 items-center gap-1.5 overflow-hidden border-l-2 px-2 text-[11px] text-muted-foreground"
                style={{ borderLeftColor: color }}
                title={uncommitted ? undefined : `${ln.summary} · ${when}`}
              >
                {!sameAsPrev &&
                  (uncommitted ? (
                    <span className="italic" data-testid={`blame-uncommitted-${ln.lineNumber}`}>
                      {t("blame.uncommitted")}
                    </span>
                  ) : (
                    <>
                      <span className="font-medium text-foreground">{ln.shortHash}</span>
                      <span className="truncate">{ln.authorName}</span>
                    </>
                  ))}
              </div>
              <div className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground">
                {ln.lineNumber}
              </div>
              <pre className="flex-1 whitespace-pre px-2">
                {tokenLines?.[i] ? <HighlightedLine tokens={tokenLines[i]} /> : ln.content || " "}
              </pre>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
