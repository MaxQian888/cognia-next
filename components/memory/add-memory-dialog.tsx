"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import type { MemoryType } from "@/types/memory/memory"
import { MEMORY_TYPES } from "@/types/memory/memory"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export interface AddMemoryInput {
  type: MemoryType
  text: string
  importance: number
  tags: string[]
}

export interface AddMemoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: AddMemoryInput) => void | Promise<void>
}

function parseTags(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(",")) {
    const trimmed = part.trim()
    if (trimmed) seen.add(trimmed)
  }
  return [...seen]
}

/**
 * Manually add a memory from the `/memory` panel — the deliberate-capture path
 * that previously only existed as the `/remember` slash command. Created rows
 * carry `explicit` provenance (so they are allowed to be `procedural`) and land
 * in global scope, matching `/remember`.
 */
export function AddMemoryDialog({ open, onOpenChange, onCreate }: AddMemoryDialogProps) {
  const t = useTranslations("memory.add")
  const tTypes = useTranslations("memory.types")
  const [type, setType] = useState<MemoryType>("semantic")
  const [text, setText] = useState("")
  const [importance, setImportance] = useState(5)
  const [tags, setTags] = useState("")

  // Reset the form each time the dialog opens. Done in render (React's
  // "adjust state when a prop changes" pattern) rather than in an effect, so we
  // don't call setState synchronously inside useEffect. Setting prevOpen makes
  // the guard false on the re-render, so it converges after one extra pass.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setType("semantic")
      setText("")
      setImportance(5)
      setTags("")
    }
  }

  const trimmed = text.trim()
  const canSubmit = trimmed.length > 0

  const submit = () => {
    if (!canSubmit) return
    void onCreate({ type, text: trimmed, importance, tags: parseTags(tags) })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-mem-text">{t("textLabel")}</Label>
            <Textarea
              id="add-mem-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("textPlaceholder")}
              rows={3}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-mem-type">{t("typeLabel")}</Label>
              <Select value={type} onValueChange={(v) => setType(v as MemoryType)}>
                <SelectTrigger id="add-mem-type" aria-label={t("typeLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_TYPES.map((mt) => (
                    <SelectItem key={mt} value={mt}>
                      {tTypes(mt)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label>{t("importanceLabel")}</Label>
                <span className="tabular-nums text-sm font-medium">{importance}</span>
              </div>
              <Slider
                aria-label={t("importanceLabel")}
                min={1}
                max={10}
                step={1}
                value={[importance]}
                onValueChange={(v) => setImportance(v[0] ?? 5)}
                className="mt-2.5"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-mem-tags">{t("tagsLabel")}</Label>
            <Input
              id="add-mem-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t("tagsPlaceholder")}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
