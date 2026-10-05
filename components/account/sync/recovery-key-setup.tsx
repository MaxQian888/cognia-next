"use client"

/**
 * The sync recovery key, shown once (ADR-0215 §4, protocol §5.1 step 3).
 *
 * Nothing that depends on the key happens until the person proves they kept
 * it: by retyping four characters at random positions, or by downloading the
 * recovery kit and saying they stored it. Used for the first device and for
 * replacing the key.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  confirmsRecoveryKey,
  pickConfirmationPositions,
  recoveryKitContents,
  recoveryKitFileName,
} from "@/lib/account-sync/enrollment/recovery-kit"
import { downloadFile } from "@/lib/files/download"
import { writeClipboardText } from "@/lib/tauri/clipboard"

export interface RecoveryKeySetupProps {
  recoveryKeyText: string
  /** How the person knows their account, printed in the kit. */
  account: string
  busy?: boolean
  onConfirmed: () => void
  onCancel: () => void
  /** Test seam: the positions to ask for. */
  positions?: number[]
}

export function RecoveryKeySetup({
  recoveryKeyText,
  account,
  busy = false,
  onConfirmed,
  onCancel,
  positions: fixedPositions,
}: RecoveryKeySetupProps) {
  const t = useTranslations("accountSync.recoveryKey")
  const [positions] = useState(() => fixedPositions ?? pickConfirmationPositions())
  const [typed, setTyped] = useState<string[]>(() => positions.map(() => ""))
  const [downloaded, setDownloaded] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [copied, setCopied] = useState(false)
  const [wrong, setWrong] = useState(false)

  const typedOk = confirmsRecoveryKey(recoveryKeyText, positions, typed)
  const confirmed = typedOk || (downloaded && acknowledged)

  const download = async () => {
    const createdAt = new Date()
    const outcome = await downloadFile(
      recoveryKitFileName(createdAt),
      recoveryKitContents({
        recoveryKeyText,
        account,
        createdAt,
        text: {
          title: t("kit.title"),
          intro: t("kit.intro"),
          keyLabel: t("kit.keyLabel"),
          accountLabel: t("kit.accountLabel"),
          createdLabel: t("kit.createdLabel"),
          instructions: [t("kit.step1"), t("kit.step2"), t("kit.step3")],
        },
      })
    )
    if (outcome.kind === "downloaded" || outcome.kind === "shared") setDownloaded(true)
  }

  const copy = async () => {
    await writeClipboardText(recoveryKeyText)
    setCopied(true)
  }

  const submit = () => {
    if (!confirmed) {
      setWrong(true)
      return
    }
    onConfirmed()
  }

  return (
    <div className="flex flex-col gap-3" data-testid="recovery-key-setup">
      <div className="flex flex-col gap-1">
        <h5 className="text-sm font-medium">{t("title")}</h5>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      <code
        className="rounded-md border bg-muted/40 px-3 py-2 text-center font-mono text-sm tracking-wider break-all select-all"
        data-testid="recovery-key-text"
      >
        {recoveryKeyText}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy()}
          data-testid="recovery-key-copy"
        >
          {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
          {copied ? t("copied") : t("copy")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void download()}
          data-testid="recovery-key-download"
        >
          <DownloadIcon data-icon="inline-start" />
          {t("download")}
        </Button>
      </div>

      <fieldset className="flex flex-col gap-2 rounded-md border p-3">
        <legend className="px-1 text-xs font-medium">{t("confirmTitle")}</legend>
        <p className="text-xs text-muted-foreground">
          {t("confirmPositions", { positions: positions.map((p) => p + 1).join(", ") })}
        </p>
        <div className="flex gap-2">
          {positions.map((position, index) => (
            <Input
              key={position}
              aria-label={t("characterLabel", { position: position + 1 })}
              className="w-10 text-center font-mono uppercase"
              maxLength={1}
              autoComplete="off"
              spellCheck={false}
              value={typed[index]}
              onChange={(event) => {
                const next = [...typed]
                next[index] = event.target.value.slice(-1)
                setTyped(next)
                setWrong(false)
              }}
              data-testid={`recovery-key-char-${index}`}
            />
          ))}
        </div>
        <div className="flex items-start gap-2">
          <Checkbox
            id="recovery-kit-acknowledged"
            checked={acknowledged}
            disabled={!downloaded}
            onCheckedChange={(value) => setAcknowledged(value === true)}
            data-testid="recovery-key-acknowledge"
          />
          <div className="flex flex-col">
            <Label htmlFor="recovery-kit-acknowledged" className="text-xs font-normal">
              {t("orDownloaded")}
            </Label>
            {!downloaded ? (
              <span className="text-[11px] text-muted-foreground">{t("downloadFirst")}</span>
            ) : null}
          </div>
        </div>
        {wrong ? (
          <p role="alert" className="text-xs text-destructive">
            {t("wrong")}
          </p>
        ) : null}
      </fieldset>

      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={submit}
          data-testid="recovery-key-continue"
        >
          {t("continue")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
          data-testid="recovery-key-cancel"
        >
          {t("cancel")}
        </Button>
      </div>
    </div>
  )
}
