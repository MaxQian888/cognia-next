"use client"

/**
 * What an unattended run may do without a person, one row per permission
 * class (ADR-0224 A7).
 *
 * Shared by the two places an unattended run is configured: a Bot
 * installation (`policyGrant.permissionProfile`) and a scheduled task's
 * payload (`permissionProfile`). Each row offers only the levels its class
 * accepts, most permissive first, and the most permissive one IS the host's
 * ceiling, so a person can lower a class but never raise it past what the
 * host allows.
 *
 * A class left at the ceiling is written as absent rather than spelled out.
 * Absent is "no opinion", which is what the ceiling fold expects from a layer
 * that did not narrow anything: a Bot's installation layer that wrote
 * `outbound: "ask"` would read, in the policy's provenance, as the user having
 * set something they never touched.
 */

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DEFAULT_PERMISSION_PROFILE,
  PERMISSION_CLASSES,
  PERMISSION_CLASS_LEVELS,
  type PermissionClass,
  type PermissionClassLevel,
  type UnattendedPermissionProfileV1,
} from "@cognia/agent-config-types/unattended-permission"

/** `profile` with `cls` set to `level`; the ceiling level is written as absent. */
export function setPermissionClassLevel(
  profile: UnattendedPermissionProfileV1 | undefined,
  cls: PermissionClass,
  level: PermissionClassLevel
): UnattendedPermissionProfileV1 {
  const next: Partial<Record<PermissionClass, PermissionClassLevel>> = { ...profile }
  if (level === DEFAULT_PERMISSION_PROFILE[cls]) delete next[cls]
  else next[cls] = level
  return next as UnattendedPermissionProfileV1
}

/** Whether two profiles mean the same thing (absent and the ceiling are equal). */
export function samePermissionProfile(
  a: UnattendedPermissionProfileV1 | undefined,
  b: UnattendedPermissionProfileV1 | undefined
): boolean {
  return PERMISSION_CLASSES.every(
    (cls) =>
      (a?.[cls] ?? DEFAULT_PERMISSION_PROFILE[cls]) ===
      (b?.[cls] ?? DEFAULT_PERMISSION_PROFILE[cls])
  )
}

export interface UnattendedPermissionProfileFieldsProps {
  value: UnattendedPermissionProfileV1 | undefined
  onChange: (next: UnattendedPermissionProfileV1) => void
  /** Prefix for the trigger ids, unique on the page. */
  idPrefix: string
  disabled?: boolean
  testId?: string
}

export function UnattendedPermissionProfileFields({
  value,
  onChange,
  idPrefix,
  disabled,
  testId = "unattended-permission-profile",
}: UnattendedPermissionProfileFieldsProps) {
  const t = useTranslations("unattendedPermissions")

  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {PERMISSION_CLASSES.map((cls) => {
        const id = `${idPrefix}-${cls}`
        const current = value?.[cls] ?? DEFAULT_PERMISSION_PROFILE[cls]
        return (
          <div key={cls} className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor={id}>{t(`class.${cls}.label`)}</Label>
              <p className="text-xs text-muted-foreground">{t(`class.${cls}.hint`)}</p>
            </div>
            <Select
              value={current}
              onValueChange={(level) =>
                onChange(setPermissionClassLevel(value, cls, level as PermissionClassLevel))
              }
              disabled={disabled}
            >
              <SelectTrigger id={id} className="w-48 shrink-0" data-testid={`${testId}-${cls}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_CLASS_LEVELS[cls].map((level) => (
                  <SelectItem key={level} value={level}>
                    {t(`level.${level}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )
      })}
    </div>
  )
}
