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
 * read-only swaps, `updateListener` → `onChange` through a ref, and an
 * external-value sync effect. The value contract is a plain string —
 * identical to `SkillMonacoEditor` / the old `SkillPlainEditor`, so surfaces
 * swap editors by viewport without adapter code.
 *
 * No LSP wiring by design: this editor never calls `mountMonacoWorkbench`,
 * so on web/mobile no LSP affordance can break — absence is structural.
 */

import { useEffect, useMemo, useRef } from "react"
import { EditorState, Compartment } from "@codemirror/state"
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from "@codemirror/view"
import { defaultHighlightStyle, syntaxHighlighting, bracketMatching } from "@codemirror/language"
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands"
import { search, searchKeymap } from "@codemirror/search"
import { cn } from "@/lib/utils"
import { loadLanguageSupport } from "./load-language-support"
import type { EditorLanguage } from "./editor-language"

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
  className?: string
  "aria-label"?: string
  "data-testid"?: string
}

export function LightCodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  lineNumbers: showLineNumbers = true,
  search: enableSearch = true,
  className,
  ...rest
}: LightCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const languageCompartment = useMemo(() => new Compartment(), [])
  const readOnlyCompartment = useMemo(() => new Compartment(), [])

  // Mount the EditorView once. Feature toggles (lineNumbers/search) are
  // mount-time options — surfaces don't flip them live.
  useEffect(() => {
    if (!hostRef.current) return
    const startState = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          ...(enableSearch ? searchKeymap : []),
        ]),
        ...(enableSearch ? [search({ top: true })] : []),
        ...(showLineNumbers
          ? [lineNumbers(), highlightActiveLine(), highlightActiveLineGutter()]
          : []),
        EditorView.lineWrapping,
        languageCompartment.of([]),
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
        // Mobile keyboards: no autocapitalize/autocorrect inside code.
        EditorView.contentAttributes.of({
          autocapitalize: "off",
          autocorrect: "off",
          spellcheck: "false",
        }),
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "13px",
            backgroundColor: "transparent",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          },
          ".cm-content": { padding: "8px 0" },
          ".cm-focused": { outline: "none" },
          ".cm-scroller": { lineHeight: "1.6" },
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
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
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

  // Live read-only toggle.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }, [readOnly, readOnlyCompartment])

  // Sync the doc when `value` changes externally (file switch, undo, revert).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return (
    <div
      ref={hostRef}
      role="textbox"
      aria-multiline="true"
      aria-label={rest["aria-label"]}
      aria-readonly={readOnly || undefined}
      data-testid={rest["data-testid"] ?? "light-code-editor"}
      data-language={language}
      className={cn("h-full min-h-0 overflow-auto font-mono text-sm", className)}
    />
  )
}
