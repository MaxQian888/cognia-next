"use client"

import { useTranslations } from "next-intl"

import type { CatalogProblem } from "@/hooks/sandbox/use-image-catalog"
import { cn } from "@/lib/utils"

/**
 * Codes this page has a sentence for, keyed to `settings.imageCatalog.errors`.
 *
 * The Host's codes are stable and its messages are not localized, so a known
 * code gets the page's own sentence and the Host's words underneath; an
 * unknown one still shows the Host's words rather than nothing.
 */
const PROBLEM_KEYS: Readonly<Record<string, string>> = {
  catalog_entry_duplicate: "catalogEntryDuplicate",
  catalog_entry_invalid: "catalogEntryInvalid",
  catalog_entry_unpinned: "catalogEntryUnpinned",
  catalog_registry_not_allowlisted: "catalogRegistryNotAllowlisted",
  catalog_size_class_unknown: "catalogSizeClassUnknown",
  environment_record_not_found: "environmentRecordNotFound",
  forbidden: "forbidden",
  scope_denied: "forbidden",
  image_reference_invalid: "imageReferenceInvalid",
  sandbox_pool_disabled: "sandboxPoolDisabled",
  tenant_entry_scope: "tenantEntryScope",
  upstream_unavailable: "upstreamUnavailable",
}

/** The `settings.imageCatalog.errors` key for `code`. */
export function catalogProblemKey(code: string): string {
  return PROBLEM_KEYS[code] ?? "unknown"
}

export function CatalogProblemText({
  problem,
  className,
}: {
  problem: CatalogProblem
  className?: string
}) {
  const t = useTranslations("settings.imageCatalog")
  const key = catalogProblemKey(problem.code)
  return (
    <div role="alert" className={cn("space-y-0.5 text-sm text-destructive", className)}>
      <p>{t(`errors.${key}`)}</p>
      {problem.message ? (
        <p className="break-all text-xs text-muted-foreground">
          {t("hostSaid", { message: problem.message })}
        </p>
      ) : null}
    </div>
  )
}
