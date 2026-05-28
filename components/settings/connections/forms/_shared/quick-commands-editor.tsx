"use client"

/**
 * Cross-adapter quick-commands editor.
 *
 * Lifted from `lark-quick-commands-editor.tsx` (which now wraps this) so
 * WeCom can reuse the exact same UX. The component is purely controlled
 * — the parent dialog owns the list and persists it on Save.
 *
 * `helpText` is platform-specific (Lark says "configure in dev console";
 * WeCom says "no persistent menu, we approximate with template_card") and
 * is passed in by the parent so the shared keys stay generic. Everything
 * else (labels, placeholders, aria text) lives under
 * `settings.connections.quickCommands.*`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, XIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { IMQuickCommand, IMQuickCommandActionType } from "@/lib/connectors/quick-commands"

export interface QuickCommandsEditorProps {
  value: IMQuickCommand[]
  onChange: (next: IMQuickCommand[]) => void
  /** Platform-specific help paragraph — caller passes the localized text. */
  helpText: string
  disabled?: boolean
  /** Test id prefix so multiple instances (Lark/WeCom tabs) don't collide. */
  testIdPrefix?: string
}

export function QuickCommandsEditor({
  value,
  onChange,
  helpText,
  disabled,
  testIdPrefix = "qc",
}: QuickCommandsEditorProps) {
  const t = useTranslations("settings.connections.quickCommands")
  const [triggerKey, setTriggerKey] = useState("")
  const [label, setLabel] = useState("")
  const [actionType, setActionType] = useState<IMQuickCommandActionType>("prompt")
  const [actionValue, setActionValue] = useState("")

  const handleAdd = () => {
    const key = triggerKey.trim()
    const val = actionValue.trim()
    if (!key || !val) return
    if (value.some((c) => c.triggerKey === key)) return
    onChange([
      ...value,
      {
        triggerKey: key,
        ...(label.trim() ? { label: label.trim() } : {}),
        action: { type: actionType, value: val },
      },
    ])
    setTriggerKey("")
    setLabel("")
    setActionValue("")
    setActionType("prompt")
  }

  const handleRemove = (key: string) => onChange(value.filter((c) => c.triggerKey !== key))

  return (
    <Card data-testid={`${testIdPrefix}-editor`}>
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{helpText}</p>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input
            value={triggerKey}
            placeholder={t("triggerKeyPlaceholder")}
            disabled={disabled}
            onChange={(e) => setTriggerKey(e.target.value)}
            aria-label={t("triggerKeyLabel")}
            data-testid={`${testIdPrefix}-trigger-key`}
          />
          <Input
            value={label}
            placeholder={t("labelPlaceholder")}
            disabled={disabled}
            onChange={(e) => setLabel(e.target.value)}
            aria-label={t("labelLabel")}
            data-testid={`${testIdPrefix}-label`}
          />
          <Select
            value={actionType}
            onValueChange={(v) => setActionType(v as IMQuickCommandActionType)}
            disabled={disabled}
          >
            <SelectTrigger
              className="w-full sm:w-[130px]"
              aria-label={t("actionTypeLabel")}
              data-testid={`${testIdPrefix}-action-type`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="prompt" data-testid={`${testIdPrefix}-action-prompt`}>
                {t("actionTypePrompt")}
              </SelectItem>
              <SelectItem value="slash" data-testid={`${testIdPrefix}-action-slash`}>
                {t("actionTypeSlash")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-2">
          <Input
            value={actionValue}
            placeholder={t("valuePlaceholder")}
            disabled={disabled}
            onChange={(e) => setActionValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                handleAdd()
              }
            }}
            aria-label={t("valueLabel")}
            data-testid={`${testIdPrefix}-value`}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleAdd}
            disabled={disabled}
            aria-label={t("addAria")}
            data-testid={`${testIdPrefix}-add`}
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </Button>
        </div>

        {value.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-1.5" data-testid={`${testIdPrefix}-list`}>
            {value.map((c) => (
              <li
                key={c.triggerKey}
                className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
                data-testid={`${testIdPrefix}-item-${c.triggerKey}`}
              >
                <span className="font-mono">{c.triggerKey}</span>
                <span className="text-muted-foreground">→</span>
                <span className="rounded bg-muted px-1">{c.action.type}</span>
                <span className="flex-1 truncate">{c.action.value}</span>
                <button
                  type="button"
                  onClick={() => handleRemove(c.triggerKey)}
                  disabled={disabled}
                  aria-label={t("removeAria", { key: c.triggerKey })}
                  className="rounded-sm hover:bg-muted"
                  data-testid={`${testIdPrefix}-remove-${c.triggerKey}`}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
