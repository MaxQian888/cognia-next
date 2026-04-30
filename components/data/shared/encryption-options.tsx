"use client"

// Radio group + nested passphrase field that lets the user pick how a backup
// is encrypted on disk. Three modes:
//   • plaintext  — JSON with manifest.integrity.checksum, no encryption
//   • auto-key   — encrypted with the device-stored auto-key (no passphrase UI)
//   • passphrase — encrypted with a user-typed passphrase (PBKDF2-AES-GCM)

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { PassphraseInput } from "./passphrase-input"

export type EncryptionMode = "plaintext" | "auto-key" | "passphrase"

interface Props {
  mode: EncryptionMode
  onModeChange: (next: EncryptionMode) => void
  passphrase: string
  onPassphraseChange: (next: string) => void
  disabled?: boolean
}

export function EncryptionOptions({
  mode,
  onModeChange,
  passphrase,
  onPassphraseChange,
  disabled,
}: Props) {
  const t = useTranslations("settings.data")
  return (
    <div className="space-y-3">
      <Label className="text-xs">{t("backup.encryptionLabel")}</Label>
      <RadioGroup
        value={mode}
        onValueChange={(v) => onModeChange(v as EncryptionMode)}
        disabled={disabled}
      >
        <RadioOption
          value="plaintext"
          title={t("backup.encryption.plaintext.title")}
          body={t("backup.encryption.plaintext.body")}
        />
        <RadioOption
          value="auto-key"
          title={t("backup.encryption.autoKey.title")}
          body={t("backup.encryption.autoKey.body")}
        />
        <RadioOption
          value="passphrase"
          title={t("backup.encryption.passphrase.title")}
          body={t("backup.encryption.passphrase.body")}
        />
      </RadioGroup>

      {mode === "passphrase" && (
        <PassphraseInput
          value={passphrase}
          onChange={onPassphraseChange}
          withConfirm
          disabled={disabled}
        />
      )}
    </div>
  )
}

function RadioOption({ value, title, body }: { value: string; title: string; body: string }) {
  const id = `enc-mode-${value}`
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2 text-sm">
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span>
        <span className="font-medium">{title}</span>
        <span className="block text-[11px] text-muted-foreground">{body}</span>
      </span>
    </label>
  )
}
