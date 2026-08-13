"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { FolderOpenIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { Spinner } from "@/components/ui/spinner"
import { pickDirectory } from "@/lib/files/file-bridge"
import { gitClone, runGitUserAction } from "@/lib/git/commands"
import { gitTargetFromRemote } from "@/lib/git/target"
import { asGitError } from "@/types/git"

interface CloneRepositoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloned: (path: string) => void
  remoteWorkspaceId?: string
  available?: boolean
}

export function CloneRepositoryDialog({
  open,
  onOpenChange,
  onCloned,
  remoteWorkspaceId,
  available = true,
}: CloneRepositoryDialogProps) {
  const t = useTranslations("sourceControl")
  const [remoteUrl, setRemoteUrl] = useState("")
  const [destination, setDestination] = useState("")
  const [cloning, setCloning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authRequired, setAuthRequired] = useState(false)

  const close = () => {
    if (cloning) return
    setRemoteUrl("")
    setDestination("")
    setError(null)
    setAuthRequired(false)
    onOpenChange(false)
  }

  const browse = async () => {
    try {
      const picked = await pickDirectory()
      if (picked) setDestination(picked)
    } catch {
      setError(t("clone.browseFailed"))
    }
  }

  const submit = async () => {
    const url = remoteUrl.trim()
    if (!url || !destination.trim() || cloning) return
    setCloning(true)
    setError(null)
    setAuthRequired(false)
    try {
      const target = remoteWorkspaceId
        ? gitTargetFromRemote(remoteWorkspaceId, destination.trim())
        : destination
      const clonedPath = await runGitUserAction("git_clone", () => gitClone(url, target))
      setRemoteUrl("")
      setDestination("")
      onCloned(clonedPath)
      onOpenChange(false)
    } catch (err) {
      const payload = asGitError(err)
      setAuthRequired(payload?.kind === "authRequired")
      setError(payload?.detail ?? payload?.kind ?? t("clone.failed"))
    } finally {
      setCloning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent data-testid="clone-repository-dialog">
        <DialogHeader>
          <DialogTitle>{t("clone.title")}</DialogTitle>
          <DialogDescription>
            {t(remoteWorkspaceId ? "clone.remoteDescription" : "clone.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="clone-url">{t("clone.urlLabel")}</Label>
            <Input
              id="clone-url"
              value={remoteUrl}
              onChange={(event) => setRemoteUrl(event.target.value)}
              placeholder={t("clone.urlPlaceholder")}
              disabled={cloning}
              autoComplete="off"
              data-testid="clone-url"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="clone-destination">{t("clone.destinationLabel")}</Label>
            <div className="flex gap-2">
              <Input
                id="clone-destination"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder={t(
                  remoteWorkspaceId
                    ? "clone.remoteDestinationPlaceholder"
                    : "clone.destinationPlaceholder"
                )}
                disabled={cloning}
                autoComplete="off"
                data-testid="clone-destination"
              />
              {!remoteWorkspaceId && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => void browse()}
                  disabled={cloning}
                  aria-label={t("clone.browse")}
                  data-testid="clone-browse"
                >
                  <FolderOpenIcon className="size-4" />
                </Button>
              )}
            </div>
          </div>
          {error && (
            <div className="grid gap-2" role="alert">
              <p className="text-sm text-destructive">{error}</p>
              {authRequired && (
                <>
                  <p className="text-xs text-muted-foreground">{t("clone.authHelp")}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="justify-self-start"
                    onClick={() => void submit()}
                    disabled={cloning}
                    data-testid="clone-auth-retry"
                  >
                    {t("clone.authRetry")}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={cloning}>
            {t("actions.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!available || !remoteUrl.trim() || !destination.trim() || cloning}
            data-testid="clone-submit"
          >
            {cloning && <Spinner className="size-4" />}
            {cloning ? t("clone.cloning") : t("clone.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
