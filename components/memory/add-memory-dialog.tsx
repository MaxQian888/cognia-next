"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import type { MemoryScope, MemoryType } from "@/types/memory/memory"
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
  scope: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
}

export interface AddMemoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Persist the memory. Resolving `false` keeps the dialog open with the draft
   * intact — a PII-blocked or policy-denied add used to close the dialog and
   * drop the text on the floor, because the result was never read.
   */
  onCreate: (input: AddMemoryInput) => Promise<boolean>
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
  const tScopes = useTranslations("memory.scopes")
  const [type, setType] = useState<MemoryType>("semantic")
  const [scope, setScope] = useState<MemoryScope>("global")
  const [text, setText] = useState("")
  const [importance, setImportance] = useState(5)
  const [tags, setTags] = useState("")
  const [characterId, setCharacterId] = useState("")
  const [projectId, setProjectId] = useState("")
  const [agentId, setAgentId] = useState("")
  const [branch, setBranch] = useState("")
  const [pathPattern, setPathPattern] = useState("")

  // Reset the form each time the dialog opens. Done in render (React's
  // "adjust state when a prop changes" pattern) rather than in an effect, so we
  // don't call setState synchronously inside useEffect. Setting prevOpen makes
  // the guard false on the re-render, so it converges after one extra pass.
  const [submitting, setSubmitting] = useState(false)
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setType("semantic")
      setScope("global")
      setText("")
      setImportance(5)
      setTags("")
      setCharacterId("")
      setProjectId("")
      setAgentId("")
      setBranch("")
      setPathPattern("")
      setSubmitting(false)
    }
  }

  const trimmed = text.trim()
  const hasRequiredNamespace =
    (scope !== "character" || characterId.trim().length > 0) &&
    (scope !== "workspace" || projectId.trim().length > 0) &&
    (scope !== "agent" || agentId.trim().length > 0)
  const canSubmit = trimmed.length > 0 && hasRequiredNamespace

  const submit = () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    void onCreate({
      type,
      scope,
      text: trimmed,
      importance,
      tags: parseTags(tags),
      ...(characterId.trim() ? { characterId: characterId.trim() } : {}),
      ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
      ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
      ...(pathPattern.trim() ? { pathPattern: pathPattern.trim() } : {}),
    })
      .then((created) => {
        if (created) onOpenChange(false)
      })
      .finally(() => setSubmitting(false))
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

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-mem-scope">{t("scopeLabel")}</Label>
              <Select value={scope} onValueChange={(value) => setScope(value as MemoryScope)}>
                <SelectTrigger id="add-mem-scope" aria-label={t("scopeLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["global", "workspace", "character", "agent"] as const).map((value) => (
                    <SelectItem key={value} value={value}>
                      {tScopes(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {scope === "workspace" ? (
              <NamespaceInput
                id="add-mem-project"
                label={t("projectIdLabel")}
                value={projectId}
                onChange={setProjectId}
                required
              />
            ) : scope === "character" ? (
              <NamespaceInput
                id="add-mem-character"
                label={t("characterIdLabel")}
                value={characterId}
                onChange={setCharacterId}
                required
              />
            ) : scope === "agent" ? (
              <NamespaceInput
                id="add-mem-agent"
                label={t("agentIdLabel")}
                value={agentId}
                onChange={setAgentId}
                required
              />
            ) : null}
          </div>

          {/*
            Three optional namespace fields in a two-column grid left a ragged
            2 + 1 row whenever the project field was present. The optional
            project id gets its own full-width row instead, so branch and path
            always pair up.
          */}
          {scope !== "global" ? (
            <div className="flex flex-col gap-3">
              {scope !== "workspace" ? (
                <NamespaceInput
                  id="add-mem-project-optional"
                  label={t("projectIdOptionalLabel")}
                  value={projectId}
                  onChange={setProjectId}
                />
              ) : null}
              <div className="grid grid-cols-2 gap-3">
                <NamespaceInput
                  id="add-mem-branch"
                  label={t("branchLabel")}
                  value={branch}
                  onChange={setBranch}
                />
                <NamespaceInput
                  id="add-mem-path"
                  label={t("pathPatternLabel")}
                  value={pathPattern}
                  onChange={setPathPattern}
                />
              </div>
            </div>
          ) : null}

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
          <Button onClick={submit} disabled={!canSubmit || submitting}>
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NamespaceInput({
  id,
  label,
  value,
  onChange,
  required = false,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
      />
    </div>
  )
}
