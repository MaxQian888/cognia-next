"use client"

import { useState } from "react"
import { Play, Square } from "lucide-react"
import { Button } from "@cognia/plugin-ui"
import { Checkbox } from "@cognia/plugin-ui"
import { Input } from "@cognia/plugin-ui"
import { Label } from "@cognia/plugin-ui"
import type { ScanOptions } from "../types"
import { usePluginT } from "../use-plugin-t"

interface Props {
  scanning: boolean
  /** Preflight passed (Docker + strix present). */
  canScan: boolean
  defaultTarget?: string
  defaultModel?: string
  onStart: (opts: ScanOptions) => void
  onCancel: () => void
}

export function ScanForm({
  scanning,
  canScan,
  defaultTarget,
  defaultModel,
  onStart,
  onCancel,
}: Props) {
  const t = usePluginT()
  const [target, setTarget] = useState(defaultTarget ?? "")
  const [model, setModel] = useState(defaultModel ?? "")
  const [apiKey, setApiKey] = useState("")
  const [authorized, setAuthorized] = useState(false)

  const targetValid = target.trim().length > 0
  const startDisabled = !canScan || !targetValid || !authorized || scanning

  const submit = () => {
    if (startDisabled) return
    onStart({
      target: target.trim(),
      model: model.trim() || undefined,
      apiKey: apiKey.trim() || undefined,
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="strix-target">{t("form.targetLabel")}</Label>
        <Input
          id="strix-target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={t("form.targetPlaceholder")}
          disabled={scanning}
          data-testid="strix-target"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="strix-model">{t("form.modelLabel")}</Label>
        <Input
          id="strix-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={t("form.modelPlaceholder")}
          disabled={scanning}
          data-testid="strix-model"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="strix-apikey">{t("form.apiKeyLabel")}</Label>
        <Input
          id="strix-apikey"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t("form.apiKeyPlaceholder")}
          disabled={scanning}
          data-testid="strix-apikey"
        />
      </div>

      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
        <p className="text-xs text-amber-700 dark:text-amber-400">{t("form.authWarning")}</p>
        <label className="mt-2 flex items-start gap-2 text-sm">
          <Checkbox
            checked={authorized}
            onCheckedChange={(v) => setAuthorized(v === true)}
            disabled={scanning}
            data-testid="strix-authorized"
          />
          <span>{t("form.authLabel")}</span>
        </label>
      </div>

      {scanning ? (
        <Button variant="destructive" onClick={onCancel} data-testid="strix-cancel">
          <Square className="size-4" />
          {t("form.cancel")}
        </Button>
      ) : (
        <Button onClick={submit} disabled={startDisabled} data-testid="strix-start">
          <Play className="size-4" />
          {t("form.start")}
        </Button>
      )}

      {!targetValid && <p className="text-xs text-muted-foreground">{t("form.targetRequired")}</p>}
    </div>
  )
}
