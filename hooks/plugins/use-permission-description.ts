"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import { PERMISSION_DESCRIPTIONS } from "@/lib/plugin/security/permission-guard"
import type { PluginPermission } from "@/types/plugin"

/** next-intl namespace holding one user-facing sentence per permission id. */
export const PERMISSION_DESCRIPTIONS_NAMESPACE = "plugins.permissions.descriptions"

/**
 * Describe a plugin permission id for the user. `fallback` is used only when
 * the id is unknown to both the locale bundle and `PERMISSION_DESCRIPTIONS`;
 * without it the raw id is returned.
 */
export type DescribePermission = (permission: string, fallback?: string) => string

/**
 * Localized description of a plugin permission for consent, review, and
 * marketplace surfaces.
 *
 * Resolution order:
 * 1. `plugins.permissions.descriptions.<id>` in the active locale;
 * 2. the English `PERMISSION_DESCRIPTIONS` entry, so a permission added to the
 *    guard before its i18n key still reads as a sentence rather than an id;
 * 3. `fallback`, then the raw permission id.
 *
 * `PERMISSION_DESCRIPTIONS` stays the English source of truth for non-React
 * callers (CLI, guard error messages); the parity test in
 * `use-permission-description.test.tsx` keeps the locale bundles in step
 * with it. The returned function is stable for a given locale.
 */
export function usePermissionDescription(): DescribePermission {
  const t = useTranslations(PERMISSION_DESCRIPTIONS_NAMESPACE)
  return useCallback<DescribePermission>(
    (permission, fallback) => {
      // Hand-rolled translator doubles in older component tests omit `has()`;
      // treat that as "no localized entry" rather than crashing the surface.
      if (typeof t.has === "function" && t.has(permission)) return t(permission)
      if (Object.hasOwn(PERMISSION_DESCRIPTIONS, permission)) {
        return PERMISSION_DESCRIPTIONS[permission as PluginPermission]
      }
      return fallback ?? permission
    },
    [t]
  )
}
