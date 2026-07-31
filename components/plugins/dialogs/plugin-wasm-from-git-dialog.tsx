"use client"

/**
 * "Install WASM plugin from Git" dialog.
 *
 * Wires the previously-dormant `installFromGit` path into the UI: the user
 * provides a repo URL (+ optional branch/tag/commit), we drive the Rust
 * `plugin_wasm_install_from_git` command (shallow clone → `cargo component
 * build` → copy `.wasm` + manifest), then surface the WASM capability grant
 * sheet — identical post-install consent to the signed-URL WASM path.
 *
 * A missing toolchain (git / cargo-component) surfaces as a
 * `GitToolchainMissingError`, which we render with install-help text rather
 * than a raw error string.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertCircleIcon, GitBranchIcon, Loader2Icon, WrenchIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import {
  installFromGit,
  GitToolchainMissingError,
  type GitInstallResult,
} from "@/lib/plugin/package/git-installer"
import { shortFingerprint } from "@/lib/plugin/security/signature"
import { useWasmCapabilityGrant } from "@/hooks/plugins/use-wasm-capability-grant"

export interface PluginWasmFromGitDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInstalled?: (result: GitInstallResult) => void
}

type Stage = "input" | "installing" | "error" | "toolchain-missing"

export function PluginWasmFromGitDialog({
  open,
  onOpenChange,
  onInstalled,
}: PluginWasmFromGitDialogProps) {
  const t = useTranslations("plugins.wasmGitInstall")
  const grant = useWasmCapabilityGrant()
  const [repoUrl, setRepoUrl] = useState("")
  const [branch, setBranch] = useState("")
  const [stage, setStage] = useState<Stage>("input")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const reset = useCallback(() => {
    setRepoUrl("")
    setBranch("")
    setStage("input")
    setErrorMessage(null)
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset()
      onOpenChange(next)
    },
    [onOpenChange, reset]
  )

  const handleInstall = useCallback(async () => {
    const trimmedUrl = repoUrl.trim()
    if (!trimmedUrl) {
      setErrorMessage(t("emptyError"))
      setStage("error")
      return
    }
    setErrorMessage(null)
    setStage("installing")
    try {
      const result = await installFromGit({
        repoUrl: trimmedUrl,
        branch: branch.trim() || undefined,
      })
      // Same post-install consent as every other WASM install path.
      await grant.requestGrant({
        manifest: result.manifest,
        authorFingerprint: result.authorFingerprint
          ? shortFingerprint(result.authorFingerprint)
          : undefined,
      })
      onInstalled?.(result)
      handleOpenChange(false)
    } catch (error) {
      if (error instanceof GitToolchainMissingError) {
        setErrorMessage(error.message)
        setStage("toolchain-missing")
        return
      }
      setErrorMessage(error instanceof Error ? error.message : String(error))
      setStage("error")
    }
  }, [repoUrl, branch, grant, onInstalled, handleOpenChange, t])

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="w-[95vw] sm:max-w-md" data-testid="wasm-from-git-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitBranchIcon className="size-4" />
              {t("title")}
            </DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          {stage !== "installing" && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="wasm-git-url">{t("repoUrlLabel")}</Label>
                <Input
                  id="wasm-git-url"
                  type="url"
                  placeholder={t("repoUrlPlaceholder")}
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="wasm-git-branch">{t("branchLabel")}</Label>
                <Input
                  id="wasm-git-branch"
                  type="text"
                  placeholder={t("branchPlaceholder")}
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </div>
              {stage === "toolchain-missing" && (
                <div
                  className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm"
                  role="alert"
                >
                  <WrenchIcon className="size-4 text-amber-600 mt-0.5" aria-hidden />
                  <div className="space-y-1">
                    <p className="font-medium">{t("toolchainMissingTitle")}</p>
                    <p className="text-xs text-muted-foreground">{t("toolchainMissingHint")}</p>
                  </div>
                </div>
              )}
              {stage === "error" && errorMessage && (
                <div
                  className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
                  role="alert"
                >
                  <AlertCircleIcon className="size-4 text-destructive mt-0.5" aria-hidden />
                  <span>{errorMessage}</span>
                </div>
              )}
            </div>
          )}

          {stage === "installing" && (
            <div className="flex items-center justify-center py-8">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-hidden />
              <span className="ml-2 text-sm">{t("installing")}</span>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={stage === "installing"}
            >
              {t("cancel")}
            </Button>
            <Button onClick={() => void handleInstall()} disabled={stage === "installing"}>
              {stage === "installing" ? (
                <Loader2Icon className="size-3.5 mr-1.5 animate-spin" aria-hidden />
              ) : null}
              {t("install")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {grant.sheet}
    </>
  )
}
