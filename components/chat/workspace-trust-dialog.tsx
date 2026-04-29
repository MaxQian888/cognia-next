"use client"

import { useState } from "react"
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
  const [busy, setBusy] = useState(false)
  const open = !!workspacePath

  async function handleTrust() {
    if (!workspacePath) return
    setBusy(true)
    try {
      await trustWorkspace(workspacePath)
      onResolved(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-amber-500" />
            Trust this workspace?
          </DialogTitle>
          <DialogDescription>
            This project ships configuration that can run commands on your machine. Trust it only if
            you wrote it or recognise the source.
          </DialogDescription>
        </DialogHeader>

        {workspacePath && (
          <div className="space-y-3 text-sm">
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Workspace
              </div>
              <div className="break-all font-mono text-xs">{workspacePath}</div>
            </div>
            {pendingActions.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  About to run
                </div>
                <ul className="list-disc pl-5 text-sm">
                  {pendingActions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              You can revoke this trust later from Settings → Hooks.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onResolved(false)}>
            Don&apos;t run
          </Button>
          <Button disabled={busy} onClick={handleTrust}>
            {busy ? "Saving…" : "Trust workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
