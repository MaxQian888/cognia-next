"use client"

/**
 * LightCodeEditor — the shared CodeMirror 6 editor for surfaces where Monaco
 * is too heavy or its virtual-keyboard handling unusable (the Capacitor
 * mobile shell). Replaces the plain `<Textarea>` fallback with syntax
 * highlighting, line numbers, history, and find/replace while staying a
 * fraction of Monaco's size — the CM core is already in the bundle via the
 * workflow expression field; grammars lazy-load per language
 * (`load-language-support.ts`).
 *
 * Integration pattern mirrors `expression-field.tsx` (the in-repo CM6
 * reference): mount-once `EditorView`, `Compartment`s for live language /
 * read-only / diagnostics swaps, `updateListener` → `onChange` through a ref,
 * and an external-value sync effect. The value contract is a plain string —
 * identical to `SkillMonacoEditor` / the old `SkillPlainEditor`, so surfaces
 * swap editors by viewport without adapter code.
 *
 * Checking is **in-browser** (`./diagnostics`): mobile has no sidecar/LSP, so
 * JSON is checked with the native parser and TS/JS with a lazy `@babel/parser`
 * syntax pass. The diagnostics layer also accepts externally-pushed diagnostics
 * (the reserved LSP seam) — see `diagnostics/cm-linter.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { EditorState, Compartment } from "@codemirror/state"
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  type Command,
} from "@codemirror/view"
import {
  defaultHighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  indentUnit,
} from "@codemirror/language"
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands"
import { search, searchKeymap } from "@codemirror/search"
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete"
import {
  lintKeymap,
  nextDiagnostic,
  previousDiagnostic,
  openLintPanel,
  closeLintPanel,
} from "@codemirror/lint"
import { AlertCircle, AlertTriangle, ChevronDown, ChevronUp, ListChecks } from "lucide-react"
import { cn } from "@/lib/utils"
import { loadLanguageSupport } from "./load-language-support"
import type { EditorLanguage } from "./editor-language"
import { editorDiagnostics, getDiagnosticSummary } from "./diagnostics/cm-linter"
import { getDiagnosticsProducer } from "./diagnostics/registry"
import type { DiagnosticSummary } from "./diagnostics/types"
import { collectEditorSnippets } from "@/lib/monaco/snippets"

export interface LightCodeEditorProps {
  value: string
  onChange: (next: string) => void
  /** Drives lazy grammar load + highlighting. */
  language: EditorLanguage
  readOnly?: boolean
  /** Line-number gutter (default true; off for compact embeds). */
  lineNumbers?: boolean
  /** Find/replace panel + Mod-F keymap (default true). */
  search?: boolean
  /** In-browser diagnostics (squiggles + lint gutter + status bar). Default true. */
  diagnostics?: boolean
  /** Auto-close brackets/quotes. Default true. */
  closeBrackets?: boolean
  /** Diagnostics status bar below the editor. Default true (requires `diagnostics`). */
  statusBar?: boolean
  /** Notified whenever the diagnostic counts change. */
  onDiagnosticsChange?: (summary: DiagnosticSummary) => void
  /** Editor font size in px (default 13). Reconfigures live. */
  fontSize?: number
  /** Editor font family (default a monospace stack). Reconfigures live. */
  fontFamily?: string
  /** Line-height multiplier (default 1.6). Reconfigures live. */
  lineHeight?: number
  /** Tab width in spaces (default 2). Reconfigures live. */
  tabSize?: number
  /** Soft-wrap long lines (default true). Reconfigures live. */
  wordWrap?: boolean
  className?: string
  "aria-label"?: string
  "data-testid"?: string
}

const EMPTY_SUMMARY: DiagnosticSummary = { errors: 0, warnings: 0, infos: 0 }

const DEFAULT_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"

/**
 * Build the appearance theme from the editor settings. Extracted so it can be
 * swapped live through a `Compartment` (font size / family / line height are no
 * longer baked in at mount — they follow the Canvas editor settings on mobile).
 */
function appearanceTheme(fontSize: number, fontFamily: string, lineHeight: number) {
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize: `${fontSize}px`,
      backgroundColor: "transparent",
      fontFamily,
    },
    ".cm-content": { padding: "8px 0" },
    ".cm-focused": { outline: "none" },
    ".cm-scroller": { lineHeight: String(lineHeight) },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--muted-foreground, #888)",
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in oklab, currentColor 4%, transparent)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "color-mix(in oklab, currentColor 6%, transparent)",
    },
    // Diagnostics panel follows the app surface instead of CM's defaults.
    ".cm-panel.cm-panel-lint": {
      backgroundColor: "var(--background)",
      color: "var(--foreground)",
      borderTop: "1px solid var(--border)",
    },
    ".cm-panel.cm-panel-lint ul [aria-selected]": {
      backgroundColor: "color-mix(in oklab, currentColor 10%, transparent)",
    },
  })
}

function lineNumberExtension(on: boolean) {
  return on ? [lineNumbers(), highlightActiveLine(), highlightActiveLineGutter()] : []
}

export function LightCodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  lineNumbers: showLineNumbers = true,
  search: enableSearch = true,
  diagnostics: enableDiagnostics = true,
  closeBrackets: enableCloseBrackets = true,
  statusBar: showStatusBar = true,
  onDiagnosticsChange,
  fontSize = 13,
  fontFamily = DEFAULT_FONT_FAMILY,
  lineHeight = 1.6,
  tabSize = 2,
  wordWrap = true,
  className,
  ...rest
}: LightCodeEditorProps) {
  const t = useTranslations("editor.diagnostics")
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  const languageRef = useRef(language)
  useEffect(() => {
    languageRef.current = language
  }, [language])
  const onDiagnosticsChangeRef = useRef(onDiagnosticsChange)
  useEffect(() => {
    onDiagnosticsChangeRef.current = onDiagnosticsChange
  }, [onDiagnosticsChange])

  const [summary, setSummary] = useState<DiagnosticSummary>(EMPTY_SUMMARY)
  const lastSummaryRef = useRef<DiagnosticSummary>(EMPTY_SUMMARY)
  const [panelOpen, setPanelOpen] = useState(false)

  const languageCompartment = useMemo(() => new Compartment(), [])
  const readOnlyCompartment = useMemo(() => new Compartment(), [])
  const lintCompartment = useMemo(() => new Compartment(), [])
  // Settings-driven compartments — reconfigured live so font/tab/wrap/line-number
  // changes apply without remounting the editor.
  const appearanceCompartment = useMemo(() => new Compartment(), [])
  const lineNumberCompartment = useMemo(() => new Compartment(), [])
  const wrapCompartment = useMemo(() => new Compartment(), [])
  const tabCompartment = useMemo(() => new Compartment(), [])

  // Diagnostics only mount for languages with an in-browser producer — no empty
  // lint gutter on plaintext/markdown/etc. (The external LSP seam is a future
  // broadening of this gate.)
  const diagnosticsActive = enableDiagnostics && getDiagnosticsProducer(language) !== null

  const snippetCompletionSource = useCallback(
    (context: CompletionContext): CompletionResult | null => {
      const word = context.matchBefore(/[\w.-]*/)
      if (!context.explicit && (!word || word.from === word.to)) return null
      const snippets = collectEditorSnippets(languageRef.current)
      if (snippets.length === 0) return null
      return {
        from: word?.from ?? context.pos,
        options: snippets.map((snippet) =>
          snippetCompletion(snippet.insertText, {
            label: snippet.label,
            type: "snippet",
            detail: snippet.detail,
            info: snippet.documentation,
          })
        ),
        validFor: /[\w.-]*$/,
      }
    },
    []
  )

  // Mount the EditorView once. `search`/`closeBrackets` are mount-time; the
  // appearance/line-number/wrap/tab settings ride Compartments and reconfigure
  // live via the effects below.
  useEffect(() => {
    if (!hostRef.current) return
    const startState = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        bracketMatching(),
        ...(enableCloseBrackets ? [closeBrackets()] : []),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          ...(enableSearch ? searchKeymap : []),
          ...(enableDiagnostics ? lintKeymap : []),
        ]),
        ...(enableSearch ? [search({ top: true })] : []),
        autocompletion({
          override: [snippetCompletionSource],
          activateOnTyping: true,
          // Show local snippets quickly even if another async source is added
          // later (CodeMirror's default is 100 ms).
          updateSyncTime: 50,
        }),
        lineNumberCompartment.of(lineNumberExtension(showLineNumbers)),
        wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
        tabCompartment.of([EditorState.tabSize.of(tabSize), indentUnit.of(" ".repeat(tabSize))]),
        languageCompartment.of([]),
        lintCompartment.of([]),
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
        // Mobile keyboards: no autocapitalize/autocorrect inside code.
        EditorView.contentAttributes.of({
          autocapitalize: "off",
          autocorrect: "off",
          spellcheck: "false",
        }),
        appearanceCompartment.of(appearanceTheme(fontSize, fontFamily, lineHeight)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
          }
          if (enableDiagnostics) {
            const next = getDiagnosticSummary(update.state)
            const prev = lastSummaryRef.current
            if (
              next.errors !== prev.errors ||
              next.warnings !== prev.warnings ||
              next.infos !== prev.infos
            ) {
              lastSummaryRef.current = next
              setSummary(next)
              onDiagnosticsChangeRef.current?.(next)
            }
          }
        }),
      ],
    })
    const view = new EditorView({ state: startState, parent: hostRef.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Lazy grammar load + hot-swap through the compartment (no remount).
  useEffect(() => {
    let cancelled = false
    void loadLanguageSupport(language).then((extension) => {
      const view = viewRef.current
      if (cancelled || !view) return
      view.dispatch({ effects: languageCompartment.reconfigure(extension ?? []) })
    })
    return () => {
      cancelled = true
    }
  }, [language, languageCompartment])

  // Swap the diagnostics extension when the language (or the toggle) changes.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: lintCompartment.reconfigure(
        diagnosticsActive ? editorDiagnostics({ language }) : []
      ),
    })
  }, [language, diagnosticsActive, lintCompartment])

  // Live read-only toggle.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }, [readOnly, readOnlyCompartment])

  // Live appearance (font size / family / line height) from the editor settings.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: appearanceCompartment.reconfigure(appearanceTheme(fontSize, fontFamily, lineHeight)),
    })
  }, [fontSize, fontFamily, lineHeight, appearanceCompartment])

  // Live line-number gutter.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: lineNumberCompartment.reconfigure(lineNumberExtension(showLineNumbers)),
    })
  }, [showLineNumbers, lineNumberCompartment])

  // Live soft-wrap toggle.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    })
  }, [wordWrap, wrapCompartment])

  // Live tab width (display + indent unit).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: tabCompartment.reconfigure([
        EditorState.tabSize.of(tabSize),
        indentUnit.of(" ".repeat(tabSize)),
      ]),
    })
  }, [tabSize, tabCompartment])

  // Sync the doc when `value` changes externally (file switch, undo, revert).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  const runCommand = useCallback((cmd: Command) => {
    const view = viewRef.current
    if (!view) return
    cmd(view)
    view.focus()
  }, [])

  const togglePanel = useCallback(() => {
    const view = viewRef.current
    if (!view) return
    if (panelOpen) closeLintPanel(view)
    else openLintPanel(view)
    setPanelOpen((open) => !open)
    view.focus()
  }, [panelOpen])

  const total = summary.errors + summary.warnings + summary.infos
  const renderStatusBar = diagnosticsActive && showStatusBar

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div
        ref={hostRef}
        role="textbox"
        aria-multiline="true"
        aria-label={rest["aria-label"]}
        aria-readonly={readOnly || undefined}
        data-testid={rest["data-testid"] ?? "light-code-editor"}
        data-language={language}
        className="min-h-0 flex-1 overflow-auto font-mono text-sm"
      />
      {renderStatusBar ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="light-code-editor-status"
          className="flex items-center gap-2 border-t px-2 py-1 text-xs text-muted-foreground"
        >
          {total === 0 ? (
            <span>{t("noProblems")}</span>
          ) : (
            <>
              {summary.errors > 0 ? (
                <span className="flex items-center gap-1 text-destructive" aria-label={t("errors")}>
                  <AlertCircle className="size-3.5" aria-hidden="true" />
                  {summary.errors}
                </span>
              ) : null}
              {summary.warnings > 0 ? (
                <span className="flex items-center gap-1 text-amber-500" aria-label={t("warnings")}>
                  <AlertTriangle className="size-3.5" aria-hidden="true" />
                  {summary.warnings}
                </span>
              ) : null}
            </>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              aria-label={t("previousProblem")}
              onClick={() => runCommand(previousDiagnostic)}
              className="rounded p-0.5 hover:bg-muted disabled:opacity-40"
              disabled={total === 0}
            >
              <ChevronUp className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t("nextProblem")}
              onClick={() => runCommand(nextDiagnostic)}
              className="rounded p-0.5 hover:bg-muted disabled:opacity-40"
              disabled={total === 0}
            >
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t("toggleProblems")}
              aria-pressed={panelOpen}
              onClick={togglePanel}
              className={cn(
                "rounded p-0.5 hover:bg-muted",
                panelOpen && "bg-muted text-foreground"
              )}
            >
              <ListChecks className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
