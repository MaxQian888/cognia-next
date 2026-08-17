"use client"

// The pre-install gate.
//
// Shaped after `plugin-pre-install-dialog.tsx` on purpose — the same stage
// vocabulary, so a user who has installed a Cognia plugin recognises this — but
// it is a separate implementation, because none of the underlying facts are
// shared: Pi packages have no manifest, no permission set and no signature.
//
// What it must show before the user commits, because afterwards none of it is
// cheap to undo:
//
//   - the exact command, or the exact file, that Cognia is about to touch;
//   - that a settings-edit is *weaker* than the CLI path, not merely different
//     (it records intent but downloads nothing);
//   - what this package adds to the always-on context budget;
//   - whether it collides with something already installed — Pi will never say;
//   - that a project-scope write lands in a version-controlled file.

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, TerminalIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { piBudgetDelta } from "@/lib/pi-packages/budget"
import { matchPiCatalog, piOverlapsForCandidate } from "@/lib/pi-packages/conflicts"
import { piPackageIdentity } from "@/lib/pi-packages/identity"
import type { PiMutationPlan } from "@/lib/pi-packages/mutate"
import type { PiPackageScope, PiPackageSource } from "@/lib/pi-packages/types"
import { piPackageShortName } from "./pi-context-budget"

export interface PiInstallRequest {
  spec: string
  scope: PiPackageScope
}

export interface PiInstallDialogProps {
  request: PiInstallRequest | null
  /** Everything currently resolved, for the delta and overlap checks. */
  installed: readonly PiPackageSource[]
  plan: PiMutationPlan | null
  /** Absolute path of the project settings file, when a workspace is open. */
  projectPath: string | null
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function PiInstallDialog({
  request,
  installed,
  plan,
  projectPath,
  busy,
  onConfirm,
  onCancel,
}: PiInstallDialogProps) {
  const t = useTranslations("plugins.agentPackages")

  if (!request) return null

  const name = piPackageShortName(request.spec)
  const delta = piBudgetDelta(request.spec, installed)
  const overlaps = piOverlapsForCandidate(request.spec, installed)
  const catalogEntry = matchPiCatalog([request.spec]).known.find(
    (entry) => piPackageIdentity(entry.spec) === piPackageIdentity(request.spec)
  )
  const discouraged = catalogEntry?.tier === "avoid"

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg" data-testid="pi-install-dialog">
        <DialogHeader>
          <DialogTitle>{t("install.title", { name })}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{request.spec}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Label className="text-muted-foreground text-xs">{t("install.scopeLabel")}</Label>
            <Badge variant="outline">{t(`scope.${request.scope}`)}</Badge>
          </div>

          {plan?.strategy === "pi-cli" && plan.command && (
            <div>
              <Label className="text-muted-foreground text-xs">{t("install.commandLabel")}</Label>
              <pre className="bg-muted mt-1 flex items-center gap-2 overflow-x-auto rounded-md p-2 font-mono text-xs">
                <TerminalIcon className="size-3.5 shrink-0" />
                <code>{plan.command}</code>
              </pre>
            </div>
          )}

          {plan?.strategy === "settings-edit" && (
            <Alert data-testid="pi-install-degraded">
              <AlertTriangleIcon className="size-4" />
              <AlertDescription>
                <span className="font-medium">{t("cli.missingTitle")}</span> {t("cli.missingBody")}
              </AlertDescription>
            </Alert>
          )}

          <div>
            <Label className="text-muted-foreground text-xs">{t("budget.title")}</Label>
            <p className="mt-1 text-xs">
              {delta.staticTokens === 0 && delta.toolCount === 0
                ? t("budget.deltaNone")
                : t("budget.delta", { tokens: delta.staticTokens, tools: delta.toolCount })}
              {delta.spawnsContexts ? ` ${t("budget.deltaSpawns")}` : ""}
            </p>
          </div>

          {overlaps.length > 0 && (
            <Alert variant="destructive" data-testid="pi-install-overlap">
              <AlertTriangleIcon className="size-4" />
              <AlertDescription className="space-y-1">
                <span className="font-medium">{t("install.overlapWarning")}</span>
                <ul className="space-y-0.5">
                  {overlaps.map((conflict) => (
                    <li key={conflict.group}>
                      {t("overlaps.conflict", {
                        count: conflict.entries.length,
                        group: t(`overlaps.group.${conflict.group}`),
                      })}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {discouraged && catalogEntry && (
            <Alert variant="destructive" data-testid="pi-install-avoid">
              <AlertTriangleIcon className="size-4" />
              <AlertDescription>
                <span className="font-medium">{t("install.avoidWarning")}</span>{" "}
                {t(`catalog.${catalogEntry.id}.risk`)}
              </AlertDescription>
            </Alert>
          )}

          {request.scope === "project" && projectPath && (
            <Alert data-testid="pi-install-project-warning">
              <AlertTriangleIcon className="size-4" />
              <AlertDescription>
                <span className="font-medium">{t("scope.confirmProjectTitle")}</span>{" "}
                {t("scope.confirmProjectBody", { path: projectPath })}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            {t("install.cancel")}
          </Button>
          <Button
            type="button"
            variant={discouraged || overlaps.length > 0 ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={busy}
            data-testid="pi-install-confirm"
          >
            {busy ? t("actions.installing") : t("install.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
