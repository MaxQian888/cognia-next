"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ShieldAlertIcon } from "lucide-react"
import { trustWorkspace } from "@/lib/db/trusted-workspaces"
import { loggers } from "@cognia/logging"

interface Props {
  /**
   * Absolute path to the workspace whose `.claude/settings.json` carries
   * hooks (or other side-effecting config). When `null`, the dialog stays
   * closed.
   */
  workspacePath: string | null
  /**
   * What's about to run if the user trusts. Free-form list shown in the body
   * — e.g. `["UserPromptSubmit hook (command)", "PreToolUse hook on Bash"]`.
   * Lets the user see what's at stake before clicking Trust.
   */
  pendingActions: string[]
  /**
   * Called after the user picks a decision. The handler decides what happens
   * next (re-run the gated action on `trusted=true`; surface a toast or just
   * cancel on `false`). Caller is responsible for closing the dialog by
   * setting `workspacePath` back to `null`.
   */
  onResolved: (trusted: boolean) => void
}

/**
 * First-time-trust prompt for projects that ship hooks or auto-running
 * skills via `.claude/settings.json` or `.claude/commands/`. Mirrors the
 * VS Code workspace-trust pattern: persisted per absolute path; revocable.
 */
export function WorkspaceTrustDialog({ workspacePath, pendingActions, onResolved }: Props) {
  const t = useTranslations("chat.workspaceTrust")
  const [busy, setBusy] = useState(false)
  const open = !!workspacePath

  async function handleTrust() {
    if (!workspacePath) return
    setBusy(true)
    try {
      await trustWorkspace(workspacePath)
      onResolved(true)
    } catch (err) {
      loggers.chat.error("trustWorkspace failed", err, { workspacePath })
      throw err
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="max-w-xl max-w-[calc(100vw-2rem)] sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-amber-500" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {workspacePath && (
          <div className="space-y-3 text-sm">
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("workspaceLabel")}
              </div>
              <div className="break-all font-mono text-xs">{workspacePath}</div>
            </div>
            {pendingActions.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("aboutToRunLabel")}
                </div>
                <ul className="list-disc pl-5 text-sm">
                  {pendingActions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t("revokeHint")}</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onResolved(false)}>
            {t("dontRun")}
          </Button>
          <Button disabled={busy} onClick={handleTrust}>
            {busy ? t("saving") : t("trust")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
