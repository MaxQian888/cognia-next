"use client"

import { useState } from "react"
import { Plus, X, Eye, EyeOff, Repeat } from "lucide-react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { SearchApiKeyRotationStrategy } from "@cognia/web-search/types"
import { useSecretReveal } from "@/hooks/use-secret-reveal"

const STRATEGIES: { value: SearchApiKeyRotationStrategy; labelKey: string }[] = [
  { value: "round-robin", labelKey: "strategyRoundRobin" },
  { value: "random", labelKey: "strategyRandom" },
  { value: "least-used", labelKey: "strategyLeastUsed" },
]

export interface ApiKeyPoolInputProps {
  /** Extra (backup) keys — combined with the primary key to form the rotation pool. */
  keys: string[]
  onChange: (keys: string[]) => void
  rotationEnabled: boolean
  onRotationEnabledChange: (enabled: boolean) => void
  strategy: SearchApiKeyRotationStrategy
  onStrategyChange: (strategy: SearchApiKeyRotationStrategy) => void
  placeholder?: string
  /** Prefixes the generated input ids so multiple pools on a page stay unique. */
  idPrefix?: string
}

/**
 * Manages a provider's backup API-key pool plus its rotation controls (toggle +
 * strategy). Controlled — the parent owns persistence. Mirrors the AI-provider
 * rotation vocabulary so users see one consistent model across Settings.
 */
export function ApiKeyPoolInput({
  keys,
  onChange,
  rotationEnabled,
  onRotationEnabledChange,
  strategy,
  onStrategyChange,
  placeholder,
  idPrefix = "backup-key",
}: ApiKeyPoolInputProps) {
  const t = useTranslations("searchSettings")
  const [draft, setDraft] = useState("")
  const [reveal, setReveal] = useState(false)
  // Settings → Security → "Require biometrics to reveal secrets".
  const revealSecret = useSecretReveal()

  const addKey = () => {
    const value = draft.trim()
    if (!value || keys.includes(value)) {
      setDraft("")
      return
    }
    onChange([...keys, value])
    setDraft("")
  }
  const removeKey = (index: number) => onChange(keys.filter((_, i) => i !== index))
  const updateKey = (index: number, value: string) =>
    onChange(keys.map((k, i) => (i === index ? value : k)))

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <Label className="flex items-center gap-1.5 text-xs font-medium">
            <Repeat className="h-3.5 w-3.5" />
            {t("rotateKeys")}
          </Label>
          <p className="text-[10px] text-muted-foreground">{t("rotateKeysDesc")}</p>
        </div>
        <Switch
          checked={rotationEnabled}
          onCheckedChange={onRotationEnabledChange}
          aria-label={t("rotateKeys")}
        />
      </div>

      {rotationEnabled && (
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[11px] text-muted-foreground">{t("rotationStrategy")}</Label>
          <Select
            value={strategy}
            onValueChange={(v) => onStrategyChange(v as SearchApiKeyRotationStrategy)}
          >
            <SelectTrigger className="h-7 w-40 text-xs" aria-label={t("rotationStrategy")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STRATEGIES.map((s) => (
                <SelectItem key={s.value} value={s.value} className="text-xs">
                  {t(s.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-muted-foreground">{t("backupKeys")}</Label>
          {keys.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => (reveal ? setReveal(false) : void revealSecret(() => setReveal(true)))}
              aria-label={reveal ? t("hideKeys") : t("showKeys")}
            >
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
          )}
        </div>

        {keys.map((key, index) => (
          <div key={index} className="flex gap-1.5">
            <Input
              id={`${idPrefix}-${index}`}
              type={reveal ? "text" : "password"}
              value={key}
              placeholder={placeholder}
              onChange={(e) => updateKey(index, e.target.value)}
              className="h-8 flex-1 text-sm"
              autoComplete="new-password"
              data-lpignore="true"
              data-form-type="other"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => removeKey(index)}
              aria-label={t("removeKey")}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}

        <div className="flex gap-1.5">
          <Input
            type={reveal ? "text" : "password"}
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addKey()
              }
            }}
            className="h-8 flex-1 text-sm"
            autoComplete="new-password"
            data-lpignore="true"
            data-form-type="other"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1 text-xs"
            onClick={addKey}
            disabled={!draft.trim()}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("addBackupKey")}
          </Button>
        </div>

        {keys.length > 0 && (
          <p className="text-[10px] text-muted-foreground">
            {t("keyPoolSize", { count: keys.length + 1 })}
          </p>
        )}
      </div>
    </div>
  )
}
