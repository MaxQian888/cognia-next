"use client"

/**
 * Lark bot-menu (快捷指令) → action mapping editor.
 *
 * Controlled component: the parent `LarkConfigDialog` owns the list and
 * persists it into `settings.quickCommands` on Save (so it survives the
 * form's `nextSettings` overwrite, unlike the self-managed whitelist editor).
 *
 * Each row maps a Feishu bot-menu `event_key` (configured in the developer
 * console — Feishu has no OpenAPI to create menus) to an action the assistant
 * turn runs: a free-text prompt or a slash-command line.
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
import type {
  LarkQuickCommand,
  LarkQuickCommandActionType,
} from "@/lib/connectors/adapters/lark/quick-commands"

export interface LarkQuickCommandsEditorProps {
  value: LarkQuickCommand[]
  onChange: (next: LarkQuickCommand[]) => void
  disabled?: boolean
}

export function LarkQuickCommandsEditor({
  value,
  onChange,
  disabled,
}: LarkQuickCommandsEditorProps) {
  const t = useTranslations("settings.connections.lark.quickCommands")
  const [eventKey, setEventKey] = useState("")
  const [label, setLabel] = useState("")
  const [actionType, setActionType] = useState<LarkQuickCommandActionType>("prompt")
  const [actionValue, setActionValue] = useState("")

  const handleAdd = () => {
    const key = eventKey.trim()
    const val = actionValue.trim()
    if (!key || !val) return
    if (value.some((c) => c.eventKey === key)) return
    onChange([
      ...value,
      {
        eventKey: key,
        ...(label.trim() ? { label: label.trim() } : {}),
        action: { type: actionType, value: val },
      },
    ])
    setEventKey("")
    setLabel("")
    setActionValue("")
    setActionType("prompt")
  }

  const handleRemove = (key: string) => onChange(value.filter((c) => c.eventKey !== key))

  return (
    <Card data-testid="lark-quick-commands-editor">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("help")}</p>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input
            value={eventKey}
            placeholder={t("eventKeyPlaceholder")}
            disabled={disabled}
            onChange={(e) => setEventKey(e.target.value)}
            aria-label={t("eventKeyLabel")}
            data-testid="lqc-event-key"
          />
          <Input
            value={label}
            placeholder={t("labelPlaceholder")}
            disabled={disabled}
            onChange={(e) => setLabel(e.target.value)}
            aria-label={t("labelLabel")}
            data-testid="lqc-label"
          />
          <Select
            value={actionType}
            onValueChange={(v) => setActionType(v as LarkQuickCommandActionType)}
            disabled={disabled}
          >
            <SelectTrigger
              className="w-full sm:w-[130px]"
              aria-label={t("actionTypeLabel")}
              data-testid="lqc-action-type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="prompt" data-testid="lqc-action-prompt">
                {t("actionTypePrompt")}
              </SelectItem>
              <SelectItem value="slash" data-testid="lqc-action-slash">
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
            data-testid="lqc-value"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleAdd}
            disabled={disabled}
            aria-label={t("addAria")}
            data-testid="lqc-add"
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </Button>
        </div>

        {value.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-1.5" data-testid="lqc-list">
            {value.map((c) => (
              <li
                key={c.eventKey}
                className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
                data-testid={`lqc-item-${c.eventKey}`}
              >
                <span className="font-mono">{c.eventKey}</span>
                <span className="text-muted-foreground">→</span>
                <span className="rounded bg-muted px-1">{c.action.type}</span>
                <span className="flex-1 truncate">{c.action.value}</span>
                <button
                  type="button"
                  onClick={() => handleRemove(c.eventKey)}
                  disabled={disabled}
                  aria-label={t("removeAria", { key: c.eventKey })}
                  className="rounded-sm hover:bg-muted"
                  data-testid={`lqc-remove-${c.eventKey}`}
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
