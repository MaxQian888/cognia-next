"use client"

/**
 * Pick the namespace a memory belongs to: a workspace by name, a character or
 * agent by name — not by typing an opaque id, which is all the add dialog used
 * to offer. An "Other ID…" entry keeps the escape hatch for a namespace that
 * has no row here (an external agent, a workspace deleted while its memories
 * survive), and an id already set that matches nothing is shown as itself
 * rather than silently dropped.
 */

import { useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useClientLiveQuery } from "@/hooks/data"
import { listCharacters } from "@/lib/db/characters"
import type { Character } from "@cognia/agent-config-types"
import { useProjectStore } from "@/stores/project/project-store"

const OTHER = "__other__"
const NONE = "__none__"

export type MemoryNamespaceKind = "workspace" | "character" | "agent"

export interface MemoryNamespacePickerProps {
  kind: MemoryNamespaceKind
  label: string
  value: string
  onChange: (value: string) => void
  /** Offer "None" (an optional narrowing layer, e.g. a workspace on a character row). */
  allowNone?: boolean
  testId?: string
}

/** Named options for a namespace kind: workspaces, or characters (which agents are). */
export function useMemoryNamespaceOptions(
  kind: MemoryNamespaceKind
): readonly { id: string; name: string }[] {
  const projects = useProjectStore((state) => state.projects)
  // Straight from Dexie rather than the chat data adapter: the console and its
  // dialogs mount outside the chat tree, and a paired device's characters are
  // in its synced mirror like everything else here.
  const characters = useClientLiveQuery<Character[]>(() => listCharacters(), [], [])
  return useMemo(() => {
    if (kind === "workspace") return projects.map((p) => ({ id: p.id, name: p.name }))
    return (characters ?? []).map((c) => ({ id: c.id, name: c.name }))
  }, [kind, projects, characters])
}

export function MemoryNamespacePicker({
  kind,
  label,
  value,
  onChange,
  allowNone = false,
  testId,
}: MemoryNamespacePickerProps) {
  const t = useTranslations("memory.namespace")
  const id = useId()
  const options = useMemoryNamespaceOptions(kind)
  const known = options.some((option) => option.id === value)
  // An id nobody here names is shown as itself in the list; typing a new one
  // is what the free-text field is for.
  const [custom, setCustom] = useState(false)
  const selectValue = custom ? OTHER : value ? value : allowNone ? NONE : ""

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={selectValue}
        onValueChange={(next) => {
          if (next === OTHER) {
            setCustom(true)
            onChange("")
            return
          }
          setCustom(false)
          onChange(next === NONE ? "" : next)
        }}
      >
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue placeholder={t("choose")} />
        </SelectTrigger>
        <SelectContent>
          {allowNone ? <SelectItem value={NONE}>{t("none")}</SelectItem> : null}
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name || option.id}
            </SelectItem>
          ))}
          {value && !known && !custom ? (
            <SelectItem value={value}>{t("unknownId", { id: value })}</SelectItem>
          ) : null}
          {options.length > 0 || allowNone ? <SelectSeparator /> : null}
          <SelectItem value={OTHER}>{t("otherId")}</SelectItem>
        </SelectContent>
      </Select>
      {custom ? (
        <Input
          aria-label={t("customIdLabel", { label })}
          placeholder={t("customIdPlaceholder")}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoFocus
        />
      ) : null}
    </div>
  )
}
