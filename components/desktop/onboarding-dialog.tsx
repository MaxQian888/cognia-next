"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { listCharacters } from "@/lib/db/characters"
import { loggers } from "@/lib/logger"
import type { Character } from "@/lib/claude/types"
import { useSettingsStore } from "@/stores/settings"
import { useClientLiveQuery } from "@/hooks/data"
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import { AvatarBadge } from "./avatar-badge"

const log = loggers.ui

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPickCharacter: (character: Character) => void
}

/**
 * First-run wizard. Shown only when the API key is unset (the shell decides).
 *
 * Step 1 collects the API key (pushes to Rust + Dexie via `setApiKey`).
 * Step 2 lets the user pick a built-in character to chat with right now.
 *
 * The user can dismiss at any time; the wizard re-appears on next launch
 * until the API key is set.
 */
export function OnboardingDialog({ open, onOpenChange, onPickCharacter }: Props) {
  const t = useTranslations("desktop.onboarding")
  const setApiKey = useSettingsStore((s) => s.setApiKey)
  const settings = useSettingsStore((s) => s.settings)
  const characters = useClientLiveQuery<Character[]>(() => listCharacters(), [], [])

  const [step, setStep] = useState<1 | 2>(settings?.apiKey ? 2 : 1)
  const [keyInput, setKeyInput] = useState("")
  const [saving, setSaving] = useState(false)

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim()
    if (!trimmed) {
      log.warn("onboarding api key blank")
      toast.error(t("toastNeedKey"))
      return
    }
    setSaving(true)
    try {
      await setApiKey(trimmed)
      log.info("onboarding api key saved", { length: trimmed.length })
      setStep(2)
    } catch (err) {
      log.error("onboarding api key save failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleSkip = () => {
    log.info("onboarding skip", { step })
    onOpenChange(false)
  }
  const handleDone = () => {
    log.info("onboarding done")
    onOpenChange(false)
  }
  const handleBack = () => {
    log.info("onboarding back-to-step1")
    setStep(1)
  }
  const handlePick = (c: Character) => {
    log.info("onboarding pick character", { characterId: c.id })
    onPickCharacter(c)
    onOpenChange(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{step === 1 ? t("step1Title") : t("step2Title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {step === 1 ? t("step1Description") : t("step2Description")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {step === 1 ? (
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="onboarding-key" className="text-xs">
                {t("apiKeyLabel")}
              </Label>
              <Input
                id="onboarding-key"
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={t("apiKeyPlaceholder")}
                className="font-mono text-xs"
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                {t("apiKeyHintPrefix")}
                <code className="rounded bg-muted px-1">{t("apiKeyHintHost")}</code>
                {t("apiKeyHintSuffix")}
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={handleSkip}>
                {t("skip")}
              </Button>
              <Button size="sm" onClick={() => void handleSaveKey()} disabled={saving}>
                {saving ? t("saving") : t("continue")}
                <ArrowRightIcon className="ml-1 size-3.5" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-2">
              {(characters ?? []).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => handlePick(c)}
                  className="flex items-start gap-2 rounded-md border p-2 text-left text-sm transition-colors hover:bg-accent"
                >
                  <AvatarBadge subject={c} size={32} textClassName="text-sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{c.name}</p>
                    {c.description && (
                      <p className="line-clamp-2 text-[11px] text-muted-foreground">
                        {c.description}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
            <div className="flex justify-between gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBack}
                disabled={Boolean(settings?.apiKey)}
              >
                <ArrowLeftIcon className="mr-1 size-3.5" />
                {t("back")}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDone}>
                <CheckIcon className="mr-1 size-3.5" />
                {t("done")}
              </Button>
            </div>
          </div>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
