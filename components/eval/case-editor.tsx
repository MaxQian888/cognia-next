"use client"

/**
 * Editor for a single {@link EvalCase}. Controlled form covering the input,
 * capability/split/tags, and the reference (expected) fields. `expectedToolArgs`
 * is edited as JSON with a parse guard that blocks save on invalid JSON.
 * Emits an `AddCaseInput`-shaped patch via `onSave`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { EvalCase, EvalReference } from "@/types/eval/eval"

export interface CaseEditorValue {
  input: string
  capability?: string
  split?: string
  tags?: string[]
  notes?: string
  reference?: EvalReference
  source: EvalCase["source"]
}

export interface CaseEditorProps {
  initial?: Partial<EvalCase>
  onSave: (value: CaseEditorValue) => void
  onCancel: () => void
}

const splitLines = (v: string): string[] =>
  v
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)

const splitCommas = (v: string): string[] =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

export function CaseEditor({ initial, onSave, onCancel }: CaseEditorProps) {
  const t = useTranslations("eval")
  const ref = initial?.reference
  const [input, setInput] = useState(initial?.input ?? "")
  const [capability, setCapability] = useState(initial?.capability ?? "")
  const [split, setSplit] = useState(initial?.split ?? "")
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "))
  const [notes, setNotes] = useState(initial?.notes ?? "")
  const [expectedOutput, setExpectedOutput] = useState(ref?.expectedOutput ?? "")
  const [expectedTools, setExpectedTools] = useState((ref?.expectedTools ?? []).join(", "))
  const [expectedContains, setExpectedContains] = useState((ref?.expectedContains ?? []).join("\n"))
  const [expectedContext, setExpectedContext] = useState((ref?.expectedContext ?? []).join("\n"))
  const [expectedToolArgs, setExpectedToolArgs] = useState(
    ref?.expectedToolArgs ? JSON.stringify(ref.expectedToolArgs, null, 2) : ""
  )
  const [argsError, setArgsError] = useState<string | null>(null)

  const handleSave = () => {
    if (!input.trim()) return
    let parsedArgs: EvalReference["expectedToolArgs"] | undefined
    if (expectedToolArgs.trim()) {
      try {
        parsedArgs = JSON.parse(expectedToolArgs) as EvalReference["expectedToolArgs"]
        setArgsError(null)
      } catch (err) {
        setArgsError(err instanceof Error ? err.message : String(err))
        return
      }
    }
    const reference: EvalReference = {}
    if (expectedOutput.trim()) reference.expectedOutput = expectedOutput
    if (expectedTools.trim()) reference.expectedTools = splitCommas(expectedTools)
    if (expectedContains.trim()) reference.expectedContains = splitLines(expectedContains)
    if (expectedContext.trim()) reference.expectedContext = splitLines(expectedContext)
    if (parsedArgs) reference.expectedToolArgs = parsedArgs

    onSave({
      input,
      source: initial?.source ?? "handwritten",
      ...(capability.trim() ? { capability: capability.trim() } : {}),
      ...(split.trim() ? { split: split.trim() } : {}),
      ...(tags.trim() ? { tags: splitCommas(tags) } : {}),
      ...(notes.trim() ? { notes } : {}),
      ...(Object.keys(reference).length > 0 ? { reference } : {}),
    })
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3" data-testid="case-editor">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t("case.input")}</span>
        <Textarea
          aria-label={t("case.input")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
        />
      </label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Input
          aria-label={t("case.capability")}
          placeholder={t("case.capability")}
          value={capability}
          onChange={(e) => setCapability(e.target.value)}
        />
        <Input
          aria-label={t("case.split")}
          placeholder={t("case.split")}
          value={split}
          onChange={(e) => setSplit(e.target.value)}
        />
        <Input
          aria-label={t("case.tags")}
          placeholder={t("case.tags")}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </div>

      <details className="rounded-md border p-2">
        <summary className="cursor-pointer text-sm font-medium">{t("case.reference")}</summary>
        <div className="mt-2 flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("case.expectedOutput")}</span>
            <Textarea
              aria-label={t("case.expectedOutput")}
              value={expectedOutput}
              onChange={(e) => setExpectedOutput(e.target.value)}
              rows={2}
            />
          </label>
          <Input
            aria-label={t("case.expectedTools")}
            placeholder={t("case.expectedTools")}
            value={expectedTools}
            onChange={(e) => setExpectedTools(e.target.value)}
          />
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("case.expectedContains")}</span>
            <Textarea
              aria-label={t("case.expectedContains")}
              value={expectedContains}
              onChange={(e) => setExpectedContains(e.target.value)}
              rows={2}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("case.expectedContext")}</span>
            <Textarea
              aria-label={t("case.expectedContext")}
              value={expectedContext}
              onChange={(e) => setExpectedContext(e.target.value)}
              rows={2}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("case.expectedToolArgs")}</span>
            <Textarea
              aria-label={t("case.expectedToolArgs")}
              value={expectedToolArgs}
              onChange={(e) => setExpectedToolArgs(e.target.value)}
              rows={3}
              className="font-mono text-xs"
            />
          </label>
          {argsError && (
            <p className="text-destructive text-xs" role="alert">
              {t("case.invalidJson", { error: argsError })}
            </p>
          )}
        </div>
      </details>

      <label className="flex flex-col gap-1 text-sm">
        <span>{t("case.notes")}</span>
        <Textarea
          aria-label={t("case.notes")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
        />
      </label>

      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={!input.trim()}>
          {t("case.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("case.cancel")}
        </Button>
      </div>
    </div>
  )
}
