"use client"

/**
 * The character selector, shared by every payload editor that binds one.
 *
 * It existed only inside `chat-payload-editor.tsx`, so the goal editor asked
 * for a `characterId` through a plain text input: to schedule a goal against a
 * particular persona the user had to know an opaque id and type it correctly,
 * with a silent no-match if they did not. Same field, same store, two
 * completely different chances of getting it right.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { listCharacters } from "@/lib/db/characters"
import type { Character } from "@cognia/agent-config-types"

/** Sentinel for "no character", since Radix cannot hold an empty string value. */
const NONE = "__none__"

export interface CharacterPickerProps {
  value: string | undefined
  onChange: (characterId: string | undefined) => void
  disabled?: boolean
  /** Marks the field required and paints the asterisk. */
  required?: boolean
  /** Validation key from the draft converter, rendered under the control. */
  errorKey?: string
  testId: string
  /** Injectable list for tests, bypassing Dexie. */
  charactersForTesting?: Character[]
}

export function CharacterPicker({
  value,
  onChange,
  disabled,
  required,
  errorKey,
  testId,
  charactersForTesting,
}: CharacterPickerProps) {
  const t = useTranslations("scheduler")
  const [characters, setCharacters] = useState<Character[] | null>(charactersForTesting ?? null)

  useEffect(() => {
    if (charactersForTesting) return
    let cancelled = false
    listCharacters()
      .then((rows) => {
        if (!cancelled) setCharacters(rows)
      })
      .catch(() => {
        // An empty list is the honest render: the control stays visible and
        // disabled-looking rather than vanishing, so "no characters yet" and
        // "this field does not exist" stay distinguishable.
        if (!cancelled) setCharacters([])
      })
    return () => {
      cancelled = true
    }
  }, [charactersForTesting])

  // A stored id the current list does not contain would otherwise render an
  // EMPTY trigger, which reads as "nothing selected" for a task that is in fact
  // bound to a character that has since been renamed away or deleted.
  const known = (characters ?? []).some((c) => c.id === value)
  const orphaned = value !== undefined && characters !== null && !known

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">
        {t("payload.character")} {required && <span className="text-destructive">*</span>}
      </Label>
      <Select
        value={value ?? NONE}
        onValueChange={(next) => onChange(next === NONE ? undefined : next)}
        disabled={disabled}
      >
        <SelectTrigger
          className={cn("h-10", errorKey && "border-destructive")}
          data-testid={`${testId}-character-select`}
        >
          <SelectValue placeholder={t("payload.characterPlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t("payload.characterNone")}</SelectItem>
          {orphaned && (
            <SelectItem value={value} data-testid={`${testId}-character-missing`}>
              {t("payload.characterMissing", { id: value })}
            </SelectItem>
          )}
          {(characters ?? []).map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {errorKey && <p className="text-xs text-destructive">{t(`payload.errors.${errorKey}`)}</p>}
    </div>
  )
}
