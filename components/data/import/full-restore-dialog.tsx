"use client"

// End-to-end import card: file picker, encryption-aware decryption, preview,
// merge-strategy chooser, apply, summary. Composes the import-flow hook
// with the preview/summary atoms.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { UploadIcon, LockIcon } from "lucide-react"
import { useImportFlow } from "@/hooks/data/use-import-flow"
import { PassphraseInput } from "@/components/data/shared/passphrase-input"
import { ImportPreview } from "./import-preview"
import { ImportSummary } from "./import-summary"
import type { ImportMergeStrategy } from "@/lib/data/types"

export function FullRestoreDialog() {
  const t = useTranslations("settings.data")
  const flow = useImportFlow()
  const [strategy, setStrategy] = useState<ImportMergeStrategy>("skip")
  const [includeSessions, setIncludeSessions] = useState(true)
  const [includeApiKey, setIncludeApiKey] = useState(false)
  const [passphrase, setPassphrase] = useState("")

  const busy = flow.state.status === "loading" || flow.state.status === "applying"

  const onApply = () => {
    void flow.applyPreview({ mergeStrategy: strategy, includeSessions, includeApiKey })
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <UploadIcon className="size-4" />
        <Label className="text-sm">{t("importTitle")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("importHint")}</p>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-[11px]">{t("mergeStrategyLabel")}</Label>
          <Select value={strategy} onValueChange={(v) => setStrategy(v as ImportMergeStrategy)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">{t("strategySkip")}</SelectItem>
              <SelectItem value="overwrite">{t("strategyOverwrite")}</SelectItem>
              <SelectItem value="duplicate">{t("strategyDuplicate")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2 pt-5">
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={includeSessions} onCheckedChange={setIncludeSessions} />
            {t("includeSessions")}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={includeApiKey} onCheckedChange={setIncludeApiKey} />
            {t("includeApiKey")}
          </label>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={flow.reset} disabled={busy}>
          {t("reset")}
        </Button>
        <Button size="sm" onClick={() => void flow.pickFile()} disabled={busy}>
          {flow.state.status === "loading" ? t("loading") : t("importButton")}
        </Button>
      </div>

      {flow.state.status === "needsPassphrase" && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
          <div className="flex items-center gap-2">
            <LockIcon className="size-4" />
            <span className="font-medium">{t("backup.encryptedFileDetected")}</span>
          </div>
          <p className="text-muted-foreground">{t("backup.enterPassphrase")}</p>
          {flow.state.lastError && (
            <p className="text-destructive">{t("backup.wrongPassphrase")}</p>
          )}
          <PassphraseInput value={passphrase} onChange={setPassphrase} autoFocus />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => void flow.submitPassphrase(passphrase)}
              disabled={!passphrase || busy}
            >
              {t("backup.unlockButton")}
            </Button>
          </div>
        </div>
      )}

      {flow.state.status === "preview" && (
        <>
          <ImportPreview pkg={flow.state.pkg} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={flow.reset}>
              {t("cancel")}
            </Button>
            <Button size="sm" onClick={onApply} disabled={busy}>
              {flow.state.status === "preview" ? t("apply") : t("applying")}
            </Button>
          </div>
        </>
      )}

      {flow.state.status === "applying" && (
        <p className="text-xs italic text-muted-foreground">{t("applying")}</p>
      )}

      {flow.state.status === "done" && <ImportSummary summary={flow.state.summary} />}

      {flow.state.status === "error" && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {flow.state.message}
        </p>
      )}
    </Card>
  )
}
