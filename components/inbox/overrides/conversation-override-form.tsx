"use client"

/**
 * Shared editor for `ConversationOverrideRow` fields (im-refactored-crayon).
 *
 * Mounted at two call sites:
 *   1. Settings → Connections → Conversations tab "Edit" button
 *   2. Inbox → conversation header gear icon
 *
 * Both paths use the same form so per-channel behaviour stays consistent
 * regardless of where the operator opened it.
 *
 * Save persists via `upsertByConversationKey` (creates a row if none
 * exists yet; bumps `updatedAt` otherwise). Delete-Override removes the
 * row entirely so the channel falls back to its adapter defaults.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { InfoIcon, ShieldAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { upsertByConversationKey } from "@/lib/db/conversation-overrides"
import { getDb } from "@/lib/db/schema"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ConnectorMode } from "@/types/connectors/policy"

const MODES: ReadonlyArray<{ value: ConnectorMode | "unset"; key: string }> = [
  { value: "unset", key: "unset" },
  { value: "auto", key: "auto" },
  { value: "manual", key: "manual" },
  { value: "draft", key: "draft" },
]

export interface ConversationOverrideFormProps {
  /** Bus-level adapter id (the middle segment of `conversationKey`). */
  adapterId: string
  /** `${platform}:${adapterId}:${chatId}`. */
  conversationKey: string
  /** Existing row, if any; null = creating a new override. */
  initialRow?: ConversationOverrideRow | null
  /** Inbox-bound conversations carry a fresh ChatSession; required to
   * upsert. Settings callers can derive it from the conversationKey. */
  sessionId: string
  /** Called after a successful Save / Delete. */
  onDone?: () => void
  /** Called when Cancel is clicked. */
  onCancel?: () => void
}

export function ConversationOverrideForm(props: ConversationOverrideFormProps) {
  const { adapterId, conversationKey, initialRow, sessionId, onDone, onCancel } = props
  const t = useTranslations("inbox.conversationOverride")

  const [mode, setMode] = useState<ConnectorMode | "unset">(
    (initialRow?.mode as ConnectorMode | undefined) ?? "unset"
  )
  const [characterId, setCharacterId] = useState(initialRow?.characterId ?? "")
  const [allowComputerUse, setAllowComputerUse] = useState(initialRow?.allowComputerUse ?? false)
  const [providerOverride, setProviderOverride] = useState(initialRow?.providerOverride ?? "")
  const [modelOverride, setModelOverride] = useState(initialRow?.modelOverride ?? "")
  const [pinned, setPinned] = useState(initialRow?.pinned ?? false)
  const [archived, setArchived] = useState(initialRow?.archived ?? false)
  const [saving, setSaving] = useState(false)

  // Resetting on initialRow changes is handled at the call site via a `key`
  // prop on this component (see ConversationOverrideDialog) — that triggers
  // a fresh mount with the new initial values and avoids the
  // react-hooks/set-state-in-effect anti-pattern.

  const onSave = async () => {
    setSaving(true)
    try {
      await upsertByConversationKey({
        conversationKey,
        sessionId,
        mode: mode === "unset" ? undefined : mode,
        characterId: characterId.trim() || undefined,
        allowComputerUse: allowComputerUse ? true : undefined,
        providerOverride: providerOverride.trim() || undefined,
        modelOverride: modelOverride.trim() || undefined,
        pinned: pinned ? true : undefined,
        archived: archived ? true : undefined,
        trigger: initialRow?.trigger,
      })
      onDone?.()
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async () => {
    if (!initialRow) {
      onCancel?.()
      return
    }
    await getDb().conversationOverrides.delete(initialRow.id)
    onDone?.()
  }

  // Suppress lint warning about adapterId being unused — it's part of
  // the public prop contract for parent components that mount the form
  // by adapter scope, and the audit log on the bus side keys on this.
  void adapterId

  return (
    <div className="space-y-5">
      <div className="rounded-md bg-muted/30 px-3 py-2 text-xs font-mono text-muted-foreground">
        {conversationKey}
      </div>

      <div className="space-y-2">
        <Label htmlFor="conv-override-mode">{t("fields.mode")}</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as ConnectorMode | "unset")}>
          <SelectTrigger id="conv-override-mode" data-testid="conv-override-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {t(`fields.modeOptions.${m.key}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="conv-override-character">{t("fields.character")}</Label>
        <Input
          id="conv-override-character"
          value={characterId}
          placeholder={t("fields.characterPlaceholder")}
          onChange={(e) => setCharacterId(e.target.value)}
          data-testid="conv-override-character"
        />
      </div>

      <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex items-start gap-2">
          <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="conv-override-cu" className="cursor-pointer">
                {t("fields.allowComputerUse")}
              </Label>
              <Switch
                id="conv-override-cu"
                checked={allowComputerUse}
                onCheckedChange={setAllowComputerUse}
                data-testid="conv-override-cu"
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("fields.allowComputerUseWarning")}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="conv-override-provider">{t("fields.providerOverride")}</Label>
          <Input
            id="conv-override-provider"
            value={providerOverride}
            placeholder={t("fields.providerOverridePlaceholder")}
            onChange={(e) => setProviderOverride(e.target.value)}
            data-testid="conv-override-provider"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="conv-override-model">{t("fields.modelOverride")}</Label>
          <Input
            id="conv-override-model"
            value={modelOverride}
            placeholder={t("fields.modelOverridePlaceholder")}
            onChange={(e) => setModelOverride(e.target.value)}
            data-testid="conv-override-model"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <Label htmlFor="conv-override-pinned" className="cursor-pointer">
            {t("fields.pinned")}
          </Label>
          <Switch
            id="conv-override-pinned"
            checked={pinned}
            onCheckedChange={setPinned}
            data-testid="conv-override-pinned"
          />
        </div>
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <Label htmlFor="conv-override-archived" className="cursor-pointer">
            {t("fields.archived")}
          </Label>
          <Switch
            id="conv-override-archived"
            checked={archived}
            onCheckedChange={setArchived}
            data-testid="conv-override-archived"
          />
        </div>
      </div>

      <div
        className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/40 px-3 py-2 text-xs text-muted-foreground dark:border-amber-800 dark:bg-amber-950/20"
        data-testid="conv-override-quiet-hours-notice"
      >
        <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t("fields.advancedJsonHelp")}</span>
      </div>

      <div className="flex items-center justify-between gap-2 pt-2">
        <div>
          {initialRow && (
            <Button
              variant="destructive"
              size="sm"
              onClick={onDelete}
              data-testid="conv-override-delete"
            >
              {t("deleteOverride")}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onCancel} data-testid="conv-override-cancel">
            {t("reset")}
          </Button>
          <Button onClick={onSave} disabled={saving} data-testid="conv-override-save">
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </div>
    </div>
  )
}
