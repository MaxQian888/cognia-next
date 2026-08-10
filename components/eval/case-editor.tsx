"use client"

/**
 * Editor for a single {@link EvalCase}. Controlled form covering the input,
 * capability/split/tags, and the reference (expected) fields. `expectedToolArgs`
 * is edited as JSON with a parse guard that blocks save on invalid JSON.
 * Emits an `AddCaseInput`-shaped patch via `onSave`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, Loader2Icon, PaperclipIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { EvalCase, EvalInputPart, EvalReference } from "@/types/eval/eval"
import type { EvalAssetClearance } from "@/lib/ai/eval/assets"

type EvalAssetPart = Extract<EvalInputPart, { type: "asset" }>

export interface CaseEditorValue {
  input: string
  capability?: string
  split?: string
  tags?: string[]
  notes?: string
  reference?: EvalReference
  contentParts?: EvalInputPart[]
  source: EvalCase["source"]
}

export interface CaseEditorProps {
  initial?: Partial<EvalCase>
  onSave: (value: CaseEditorValue) => void
  onCancel: () => void
  onAttach?: (file: File, clearance?: EvalAssetClearance) => Promise<EvalAssetPart>
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

export function CaseEditor({ initial, onSave, onCancel, onAttach }: CaseEditorProps) {
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
  const [contentParts, setContentParts] = useState<EvalInputPart[]>(initial?.contentParts ?? [])
  const [clearanceMode, setClearanceMode] = useState<"local-only" | "manual">("local-only")
  const [reviewerId, setReviewerId] = useState("")
  const [uploading, setUploading] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)

  const attachFiles = async (files: FileList | null) => {
    if (!files?.length || !onAttach) return
    setUploading(true)
    setAttachmentError(null)
    try {
      const clearance: EvalAssetClearance | undefined =
        clearanceMode === "manual" ? { method: "manual", actorId: reviewerId } : undefined
      const uploaded: EvalAssetPart[] = []
      for (const file of Array.from(files)) uploaded.push(await onAttach(file, clearance))
      setContentParts((current) => [...current, ...uploaded])
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }

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
      ...(contentParts.length ? { contentParts } : {}),
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

      <Collapsible className="group/collapsible rounded-md border p-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="h-auto w-full justify-between px-0 py-1 text-sm">
            {t("case.reference")}
            <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent forceMount className="mt-2 flex flex-col gap-2">
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
        </CollapsibleContent>
      </Collapsible>

      <Collapsible className="group/collapsible rounded-md border p-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="h-auto w-full justify-between px-0 py-1 text-sm">
            {t("case.attachments")}
            <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent forceMount className="mt-2 flex flex-col gap-2">
          {contentParts.some((part) => part.type === "asset") ? (
            <ul className="space-y-1">
              {contentParts.map((part, index) =>
                part.type === "asset" ? (
                  <li
                    key={`${part.assetId}:${index}`}
                    className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm"
                  >
                    <PaperclipIcon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{part.name ?? part.assetId}</span>
                    <span className="text-xs text-muted-foreground">
                      {t(`case.privacy.${part.privacy}`)}
                    </span>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("case.removeAttachment", {
                        name: part.name ?? part.assetId,
                      })}
                      onClick={() =>
                        setContentParts((current) =>
                          current.filter((_, currentIndex) => currentIndex !== index)
                        )
                      }
                    >
                      <XIcon />
                    </Button>
                  </li>
                ) : null
              )}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t("case.attachmentsEmpty")}</p>
          )}
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("case.attachmentPrivacy")}</span>
            <NativeSelect
              aria-label={t("case.attachmentPrivacy")}
              wrapperClassName="w-full"
              value={clearanceMode}
              onChange={(event) => setClearanceMode(event.target.value as "local-only" | "manual")}
            >
              <NativeSelectOption value="local-only">
                {t("case.privacy.local-only")}
              </NativeSelectOption>
              <NativeSelectOption value="manual">{t("case.privacy.manual")}</NativeSelectOption>
            </NativeSelect>
          </label>
          {clearanceMode === "manual" ? (
            <Input
              aria-label={t("case.reviewerId")}
              placeholder={t("case.reviewerId")}
              value={reviewerId}
              onChange={(event) => setReviewerId(event.target.value)}
            />
          ) : null}
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("case.pickAttachments")}</span>
            <Input
              type="file"
              multiple
              disabled={
                !onAttach || uploading || (clearanceMode === "manual" && !reviewerId.trim())
              }
              aria-label={t("case.pickAttachments")}
              onChange={(event) => {
                void attachFiles(event.target.files)
                event.target.value = ""
              }}
            />
          </label>
          {uploading ? (
            <p className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
              <Loader2Icon className="size-3 animate-spin" />
              {t("case.attachmentUploading")}
            </p>
          ) : null}
          {attachmentError ? (
            <p className="text-xs text-destructive" role="alert">
              {t("case.attachmentFailed", { error: attachmentError })}
            </p>
          ) : null}
        </CollapsibleContent>
      </Collapsible>

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
        <Button size="sm" onClick={handleSave} disabled={!input.trim() || uploading}>
          {t("case.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("case.cancel")}
        </Button>
      </div>
    </div>
  )
}
