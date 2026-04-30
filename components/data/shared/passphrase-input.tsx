"use client"

// Passphrase entry with show/hide toggle. Used for both export-time
// encryption and import-time decryption. Mirrors Cognia's UX — the toggle
// flips the input type without remounting so the value persists.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { EyeIcon, EyeOffIcon } from "lucide-react"

interface Props {
  value: string
  onChange: (next: string) => void
  /** When true, render an extra "Confirm" field that must match. */
  withConfirm?: boolean
  /** Optional id for label association. */
  id?: string
  autoFocus?: boolean
  disabled?: boolean
}

export function PassphraseInput({
  value,
  onChange,
  withConfirm = false,
  id = "passphrase",
  autoFocus,
  disabled,
}: Props) {
  const t = useTranslations("settings.data")
  const [reveal, setReveal] = useState(false)
  const [confirm, setConfirm] = useState("")
  const mismatch = withConfirm && confirm !== "" && confirm !== value

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs">
        {t("backup.passphrase")}
      </Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          disabled={disabled}
          autoComplete="new-password"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setReveal((r) => !r)}
          aria-label={reveal ? t("backup.hidePassphrase") : t("backup.showPassphrase")}
          disabled={disabled}
        >
          {reveal ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </Button>
      </div>
      {withConfirm && (
        <>
          <Label htmlFor={`${id}-confirm`} className="text-xs">
            {t("backup.passphraseConfirm")}
          </Label>
          <Input
            id={`${id}-confirm`}
            type={reveal ? "text" : "password"}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={disabled}
            autoComplete="new-password"
            spellCheck={false}
            aria-invalid={mismatch}
          />
          {mismatch && (
            <p className="text-[11px] text-destructive">{t("backup.passphraseMismatch")}</p>
          )}
        </>
      )}
    </div>
  )
}
