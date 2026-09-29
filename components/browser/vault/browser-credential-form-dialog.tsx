"use client"

import { EyeIcon, EyeOffIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState, type FormEvent } from "react"
import { toast } from "sonner"

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
import { Textarea } from "@/components/ui/textarea"
import { saveCredential, updateCredential, type CredentialMeta } from "@/lib/browser/passwords"

type SavedCredential = CredentialMeta

/** `https://example.com/login?x` → `https://example.com`; `null` for anything not http(s). */
export function normalizeCredentialOrigin(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (!url.hostname) return null
    return url.origin
  } catch {
    return null
  }
}

type FormErrors = Partial<Record<"origin" | "username" | "password", string>>

function CredentialForm({
  credential,
  onDone,
  onSaved,
}: {
  credential: SavedCredential | null
  onDone: () => void
  onSaved: (saved: SavedCredential) => void
}) {
  const t = useTranslations("browserVault")
  const editing = credential !== null
  const [origin, setOrigin] = useState(credential?.origin ?? "")
  const [username, setUsername] = useState(credential?.username ?? "")
  const [password, setPassword] = useState("")
  const [note, setNote] = useState(credential?.note ?? "")
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<FormErrors>({})
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const nextErrors: FormErrors = {}
    const normalizedOrigin = editing ? credential.origin : normalizeCredentialOrigin(origin)
    if (!normalizedOrigin) nextErrors.origin = t("passwords.form.invalidOrigin")
    if (!username.trim()) nextErrors.username = t("passwords.form.usernameRequired")
    if (!editing && !password) nextErrors.password = t("passwords.form.passwordRequired")
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0 || !normalizedOrigin) return

    setSaving(true)
    try {
      const trimmedNote = note.trim()
      const saved = editing
        ? await updateCredential({
            id: credential.id,
            username: username.trim(),
            ...(password ? { password } : {}),
            note: trimmedNote,
          })
        : await saveCredential({
            origin: normalizedOrigin,
            username: username.trim(),
            password,
            ...(trimmedNote ? { note: trimmedNote } : {}),
          })
      // Drop the typed value from memory as soon as Rust holds it.
      setPassword("")
      onSaved(saved)
      toast.success(editing ? t("passwords.form.updated") : t("passwords.form.saved"))
      onDone()
    } catch {
      toast.error(t("common.failed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <div className="grid gap-1.5">
        <Label htmlFor="browser-credential-origin">{t("passwords.form.origin")}</Label>
        <Input
          id="browser-credential-origin"
          value={origin}
          disabled={editing}
          placeholder={t("passwords.form.originPlaceholder")}
          aria-invalid={errors.origin ? true : undefined}
          aria-describedby={errors.origin ? "browser-credential-origin-error" : undefined}
          onChange={(event) => setOrigin(event.target.value)}
          autoComplete="off"
        />
        {errors.origin && (
          <p id="browser-credential-origin-error" className="text-xs text-destructive">
            {errors.origin}
          </p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="browser-credential-username">{t("passwords.form.username")}</Label>
        <Input
          id="browser-credential-username"
          value={username}
          aria-invalid={errors.username ? true : undefined}
          aria-describedby={errors.username ? "browser-credential-username-error" : undefined}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="off"
        />
        {errors.username && (
          <p id="browser-credential-username-error" className="text-xs text-destructive">
            {errors.username}
          </p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="browser-credential-password">{t("passwords.form.password")}</Label>
        <div className="flex gap-2">
          <Input
            id="browser-credential-password"
            type={showPassword ? "text" : "password"}
            value={password}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={
              errors.password
                ? "browser-credential-password-error"
                : editing
                  ? "browser-credential-password-hint"
                  : undefined
            }
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label={showPassword ? t("passwords.hide") : t("passwords.reveal")}
            onClick={() => setShowPassword((current) => !current)}
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </div>
        {errors.password ? (
          <p id="browser-credential-password-error" className="text-xs text-destructive">
            {errors.password}
          </p>
        ) : editing ? (
          <p id="browser-credential-password-hint" className="text-xs text-muted-foreground">
            {t("passwords.form.editPasswordHint")}
          </p>
        ) : null}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="browser-credential-note">{t("passwords.form.note")}</Label>
        <Textarea
          id="browser-credential-note"
          value={note}
          rows={2}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? t("passwords.form.saving") : t("passwords.form.save")}
        </Button>
      </DialogFooter>
    </form>
  )
}

/**
 * Add or edit one saved credential. Editing keeps the origin fixed (Rust keys
 * the entry by it) and only replaces the password when a new one is typed.
 * The form mounts with the dialog, so each open starts from the credential's
 * current metadata and an empty password field.
 */
export function BrowserCredentialFormDialog({
  open,
  onOpenChange,
  credential,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `null` adds a new credential. */
  credential: SavedCredential | null
  onSaved: (saved: SavedCredential) => void
}) {
  const t = useTranslations("browserVault")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {credential ? t("passwords.form.editTitle") : t("passwords.form.addTitle")}
          </DialogTitle>
          <DialogDescription>{t("passwords.description")}</DialogDescription>
        </DialogHeader>
        <CredentialForm
          key={credential?.id ?? "new"}
          credential={credential}
          onDone={() => onOpenChange(false)}
          onSaved={onSaved}
        />
      </DialogContent>
    </Dialog>
  )
}
