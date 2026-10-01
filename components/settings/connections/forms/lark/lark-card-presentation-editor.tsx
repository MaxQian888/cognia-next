"use client"

import { useId } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DEFAULT_LARK_CARD_PRESENTATION,
  LARK_CARD_THEMES,
  LARK_CARD_TEXT_SIZES,
  validateLarkCardPresentation,
  type LarkCardPresentation,
} from "@/lib/connectors/adapters/lark/card-presentation"

const CHOICES = {
  theme: LARK_CARD_THEMES,
  density: ["comfortable", "compact"],
  width: ["default", "compact", "fill"],
  processMode: ["auto", "card"],
  history: ["auto", "expanded", "collapsed"],
  desktopTextSize: LARK_CARD_TEXT_SIZES,
  mobileTextSize: LARK_CARD_TEXT_SIZES,
} as const

export function LarkCardPresentationEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: LarkCardPresentation
  onChange: (value: LarkCardPresentation) => void
  disabled?: boolean
}) {
  const t = useTranslations("settings.connections.lark.cardPresentation")
  const id = useId()
  const validationError = validateLarkCardPresentation(value)
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t("help")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {(Object.keys(CHOICES) as Array<keyof typeof CHOICES>).map((key) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`${id}-${key}`}>{t(key)}</Label>
            <Select
              value={value[key]}
              onValueChange={(next) => onChange({ ...value, [key]: next })}
              disabled={disabled}
            >
              <SelectTrigger id={`${id}-${key}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHOICES[key].map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(`options.${key}.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
        <div className="space-y-2">
          <Label htmlFor={`${id}-title`}>{t("title")}</Label>
          <Input
            id={`${id}-title`}
            value={value.title}
            maxLength={60}
            onChange={(event) => onChange({ ...value, title: event.target.value })}
            placeholder={t("titlePlaceholder")}
            disabled={disabled}
          />
        </div>
        {(
          ["subtitle", "headerIconKey", "headerTags", "panelColorLight", "panelColorDark"] as const
        ).map((key) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`${id}-${key}`}>{t(key)}</Label>
            <Input
              id={`${id}-${key}`}
              value={value[key]}
              maxLength={
                key === "subtitle"
                  ? 120
                  : key === "headerIconKey"
                    ? 254
                    : key === "headerTags"
                      ? 64
                      : 7
              }
              placeholder={t(`${key}Placeholder`)}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            />
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["showElapsed", "showProgress", "showArtifacts", "showQuote", "showFooter"] as const).map(
          (key) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <Label htmlFor={`${id}-${key}`}>{t(key)}</Label>
              <Switch
                id={`${id}-${key}`}
                checked={value[key]}
                onCheckedChange={(next) => onChange({ ...value, [key]: next })}
                disabled={disabled}
              />
            </div>
          )
        )}
      </div>
      <div className="space-y-3 rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`${id}-resultTemplateEnabled`}>{t("resultTemplateEnabled")}</Label>
          <Switch
            id={`${id}-resultTemplateEnabled`}
            checked={value.resultTemplateEnabled}
            disabled={disabled}
            onCheckedChange={(next) => onChange({ ...value, resultTemplateEnabled: next })}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("resultTemplateHelp")}</p>
        {value.resultTemplateEnabled && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["resultTemplateId", "resultTemplateVersion"] as const).map((key) => (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`${id}-${key}`}>{t(key)}</Label>
                  <Input
                    id={`${id}-${key}`}
                    value={value[key]}
                    maxLength={100}
                    disabled={disabled}
                    onChange={(event) => onChange({ ...value, [key]: event.target.value })}
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground break-words">
              {t("resultTemplateVariables")}
            </p>
          </>
        )}
      </div>
      {validationError && (
        <p role="alert" className="text-xs text-destructive">
          {t(validationError)}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => onChange({ ...DEFAULT_LARK_CARD_PRESENTATION })}
      >
        {t("reset")}
      </Button>
    </div>
  )
}
