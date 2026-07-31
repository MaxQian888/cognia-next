"use client"

/**
 * Offline manifest validator — lets a plugin author point at a
 * `plugin.json` (or the folder containing it) and see the host's schema
 * verdict without installing anything. Runs the exact same
 * `validatePluginManifest` the manager runs at install + load time, so
 * the verdict here is faithful to what an install would accept.
 *
 * Surfaces errors and warnings grouped by severity, plus a preview of
 * the declared permissions (the dimension authors most often get wrong).
 * Tauri-only — the file picker + manifest read both need the desktop
 * shell; on web the panel renders a disabled hint.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircle2Icon,
  FileJson2Icon,
  FileSearchIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { validatePluginManifest } from "@/lib/plugin/core/validation"
import { previewLocalManifest } from "@/lib/plugin/local/install-from-directory"
import { cn } from "@/lib/utils"
import { CapabilityChips } from "@/components/plugins/_shared/capability-chips"
import type { PluginManifest, PluginPermission } from "@/types/plugin"

interface ValidatorState {
  status: "idle" | "validating" | "done"
  valid: boolean
  errors: string[]
  warnings: string[]
  permissions: PluginPermission[]
  capabilities: string[]
  readError: string | null
}

const INITIAL: ValidatorState = {
  status: "idle",
  valid: false,
  errors: [],
  warnings: [],
  permissions: [],
  capabilities: [],
  readError: null,
}

export function ManifestValidator({ className }: { className?: string }) {
  const t = useTranslations("plugins.devtools.validator")
  const [state, setState] = useState<ValidatorState>(INITIAL)

  const pickAndValidate = useCallback(async () => {
    if (!canUseTauriInvoke()) {
      setState({ ...INITIAL, status: "done", readError: t("tauriRequiredError") })
      return
    }
    try {
      const dialog = await import("@tauri-apps/plugin-dialog")
      const picked = await dialog.open({
        multiple: false,
        directory: false,
        title: t("pickButton"),
        filters: [{ name: "plugin.json", extensions: ["json"] }],
      })
      // Allow picking either a plugin.json file or, if the user cancels
      // the file filter and picks a directory in a later iteration, the
      // native command resolves <dir>/plugin.json itself.
      if (typeof picked !== "string") return
      setState((prev) => ({ ...prev, status: "validating", readError: null }))

      let manifest: PluginManifest
      try {
        manifest = await previewLocalManifest(picked)
      } catch (err) {
        setState({
          ...INITIAL,
          status: "done",
          readError: t("readError", {
            message: err instanceof Error ? err.message : String(err),
          }),
        })
        return
      }

      const result = validatePluginManifest(manifest)
      setState({
        status: "done",
        valid: result.valid,
        errors: result.errors,
        warnings: result.warnings,
        permissions: (manifest.permissions ?? []) as PluginPermission[],
        capabilities: (manifest.capabilities ?? []) as string[],
        readError: null,
      })
    } catch (err) {
      setState({
        ...INITIAL,
        status: "done",
        readError: t("readError", {
          message: err instanceof Error ? err.message : String(err),
        }),
      })
    }
  }, [t])

  return (
    <Card
      className={cn(
        "gap-0 overflow-hidden border-border/70 py-0 shadow-sm transition-[border-color,box-shadow] duration-200 hover:border-foreground/20 hover:shadow-md",
        className
      )}
    >
      <div className="flex h-full flex-col gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
            <FileJson2Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold tracking-tight">{t("title")}</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("description")}</p>
          </div>
        </div>

        <div className="mt-auto">
          <Button
            className="w-full justify-center sm:w-auto"
            size="sm"
            variant="outline"
            onClick={() => void pickAndValidate()}
            disabled={state.status === "validating"}
            data-testid="manifest-validator-pick"
          >
            {state.status === "validating" ? (
              <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden="true" />
            ) : (
              <FileSearchIcon className="mr-2 size-4" aria-hidden="true" />
            )}
            {state.status === "validating" ? t("validating") : t("pickButton")}
          </Button>
        </div>

        {state.readError && (
          <p
            className="text-xs text-destructive"
            role="alert"
            data-testid="manifest-validator-read-error"
          >
            {state.readError}
          </p>
        )}

        {state.status === "done" && !state.readError && (
          <div className="space-y-3 border-t pt-3" data-testid="manifest-validator-result">
            <div className="flex items-center gap-2 text-sm">
              {state.valid ? (
                <>
                  <CheckCircle2Icon className="size-4 text-emerald-600" aria-hidden="true" />
                  <span>{t("valid")}</span>
                </>
              ) : (
                <>
                  <XCircleIcon className="size-4 text-destructive" aria-hidden="true" />
                  <span>{t("invalid", { count: state.errors.length })}</span>
                </>
              )}
            </div>

            {state.errors.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-destructive">{t("errorsHeading")}</p>
                <ul className="space-y-0.5">
                  {state.errors.map((err, i) => (
                    <li key={i} className="text-xs text-destructive font-mono break-all">
                      {err}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {state.warnings.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-amber-600">{t("warningsHeading")}</p>
                <ul className="space-y-0.5">
                  {state.warnings.map((warn, i) => (
                    <li key={i} className="text-xs text-muted-foreground font-mono break-all">
                      {warn}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-1">
              <p className="text-xs font-semibold">{t("permissionsHeading")}</p>
              {state.permissions.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {state.permissions.map((perm) => (
                    <Badge key={perm} variant="outline" className="text-xs font-mono">
                      {perm}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("noPermissions")}</p>
              )}
            </div>

            {state.capabilities.length > 0 && (
              <CapabilityChips capabilities={state.capabilities} limit={6} />
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
