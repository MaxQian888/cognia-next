"use client"

/**
 * Name + key, the two fields that identify a delivery container.
 *
 * Shared because the container can be created from two places — the projects
 * console and, inline, the create-issue dialog — and the key rules are subtle
 * enough that two copies would drift: the key is DERIVED from the name until
 * the user edits it, it must match `isValidProjectKey`, it must not collide
 * with a key already taken anywhere, and it is IMMUTABLE once written, because
 * every printed identifier (`MERC-2`) embeds it.
 *
 * Derivation happens during render, not in an effect that mirrors the name
 * into state — that would be a `setState` per keystroke and a source of truth
 * in two places at once.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { deriveProjectKey, isValidProjectKey } from "@/lib/issues/identifier"

export interface ProjectIdentityState {
  name: string
  /** The user's own key, once they have typed one. */
  keyInput: string
  keyTouched: boolean
}

export const EMPTY_PROJECT_IDENTITY: ProjectIdentityState = {
  name: "",
  keyInput: "",
  keyTouched: false,
}

export interface ProjectIdentityVerdict {
  /** The key that would actually be written. */
  key: string
  invalid: boolean
  taken: boolean
  /** Enough to create with. */
  valid: boolean
}

/** Pure resolution of the pair, so callers can gate their submit button. */
export function resolveProjectIdentity(
  state: ProjectIdentityState,
  takenKeys: ReadonlySet<string>
): ProjectIdentityVerdict {
  const derived = state.name.trim() ? deriveProjectKey(state.name, takenKeys) : ""
  const key = state.keyTouched ? state.keyInput : derived
  const invalid = key.length > 0 && !isValidProjectKey(key)
  const taken = key.length > 0 && takenKeys.has(key)
  return {
    key,
    invalid,
    taken,
    valid: state.name.trim().length > 0 && key.length > 0 && !invalid && !taken,
  }
}

export interface ProjectIdentityFieldsProps {
  value: ProjectIdentityState
  onChange: (next: ProjectIdentityState) => void
  takenKeys: ReadonlySet<string>
  idPrefix: string
  disabled?: boolean
}

export function ProjectIdentityFields({
  value,
  onChange,
  takenKeys,
  idPrefix,
  disabled,
}: ProjectIdentityFieldsProps) {
  const t = useTranslations("issues")
  const verdict = useMemo(() => resolveProjectIdentity(value, takenKeys), [value, takenKeys])

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-name`}>{t("projects.nameLabel")}</Label>
        <Input
          id={`${idPrefix}-name`}
          value={value.name}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
          placeholder={t("projects.namePlaceholder")}
          data-testid={`${idPrefix}-name`}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-key`}>{t("projects.keyLabel")}</Label>
        <Input
          id={`${idPrefix}-key`}
          value={verdict.key}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...value,
              keyTouched: true,
              keyInput: event.target.value.toUpperCase(),
            })
          }
          maxLength={5}
          className="font-mono uppercase"
          data-testid={`${idPrefix}-key`}
        />
        <p className="text-xs text-muted-foreground">
          {verdict.invalid
            ? t("projects.keyInvalid")
            : verdict.taken
              ? t("projects.keyTaken")
              : // `keyHint` takes an {example}; without it next-intl falls back
                // to printing the key path, which is what this field did.
                t("projects.keyHint", { example: `${verdict.key || "KEY"}-1` })}
        </p>
      </div>
    </>
  )
}
