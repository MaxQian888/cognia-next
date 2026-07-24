"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { gitIdentity, gitSetIdentity } from "@/lib/git/commands"
import { asGitError } from "@/types/git"

interface GitIdentityDialogProps {
  open: boolean
  repoPath: string
  onOpenChange: (open: boolean) => void
  onSaved: () => void | Promise<void>
}

export function GitIdentityDialog({
  open,
  repoPath,
  onOpenChange,
  onSaved,
}: GitIdentityDialogProps) {
  const t = useTranslations("sourceControl")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [global, setGlobal] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadFailedMessage = t("identity.loadFailed")

  useEffect(() => {
    if (!open) return
    let active = true
    void Promise.resolve()
      .then(() => {
        if (!active) return null
        setLoading(true)
        setError(null)
        return gitIdentity(repoPath)
      })
      .then((identity) => {
        if (!active || !identity) return
        setName(identity.name ?? "")
        setEmail(identity.email ?? "")
      })
      .catch((err) => {
        if (!active) return
        const payload = asGitError(err)
        setError(payload?.detail ?? payload?.kind ?? loadFailedMessage)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, repoPath, loadFailedMessage])

  const save = async () => {
    const trimmedName = name.trim()
    const trimmedEmail = email.trim()
    if (!trimmedName || !trimmedEmail || saving) return
    setSaving(true)
    setError(null)
    try {
      await gitSetIdentity(repoPath, trimmedName, trimmedEmail, global)
      await onSaved()
      onOpenChange(false)
    } catch (err) {
      const payload = asGitError(err)
      setError(payload?.detail ?? payload?.kind ?? t("identity.saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent data-testid="git-identity-dialog">
        <DialogHeader>
          <DialogTitle>{t("identity.title")}</DialogTitle>
          <DialogDescription>{t("identity.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="git-identity-name">{t("identity.nameLabel")}</Label>
            <Input
              id="git-identity-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={loading || saving}
              placeholder={t("identity.namePlaceholder")}
              autoComplete="name"
              data-testid="identity-name"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="git-identity-email">{t("identity.emailLabel")}</Label>
            <Input
              id="git-identity-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={loading || saving}
              placeholder={t("identity.emailPlaceholder")}
              autoComplete="email"
              data-testid="identity-email"
            />
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="git-identity-global"
              checked={global}
              onCheckedChange={(checked) => setGlobal(checked === true)}
              disabled={loading || saving}
              data-testid="identity-global"
            />
            <div className="grid gap-0.5">
              <Label htmlFor="git-identity-global">{t("identity.globalLabel")}</Label>
              <p className="text-xs text-muted-foreground">{t("identity.globalDescription")}</p>
            </div>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("actions.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={loading || saving || !name.trim() || !email.trim()}
            data-testid="identity-save"
          >
            {(loading || saving) && <Spinner className="size-4" />}
            {saving ? t("identity.saving") : t("identity.saveAndRetry")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
