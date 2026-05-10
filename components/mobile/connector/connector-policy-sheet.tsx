"use client"

/**
 * Mobile connector policy editor (Wave 2.8).
 *
 * Sheet exposing the three policy fields most useful to flip from a
 * phone — manual mode, quiet hours window, mute. Optimistic Dexie write
 * via `getDb().adapterInstances.update`, then enqueues the
 * `adapter_update_policy` RPC so the desktop runner respects the new
 * window on next inbound.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"
import type { ConnectorMode } from "@/types/connectors/policy"

export interface ConnectorPolicy {
  id: string
  displayName: string
  defaultMode?: ConnectorMode
  muted?: boolean
  quietHours?: { from: string; to: string; tz: string }
}

export interface ConnectorPolicySheetProps {
  open: boolean
  policy: ConnectorPolicy | null
  onOpenChange: (next: boolean) => void
}

export function ConnectorPolicySheet({ open, policy, onOpenChange }: ConnectorPolicySheetProps) {
  const t = useTranslations("mobile.connectorPolicy")
  const [defaultMode, setDefaultMode] = useState<ConnectorMode>(policy?.defaultMode ?? "auto")
  const [muted, setMuted] = useState(policy?.muted ?? false)
  const [from, setFrom] = useState(policy?.quietHours?.from ?? "")
  const [to, setTo] = useState(policy?.quietHours?.to ?? "")
  const [busy, setBusy] = useState(false)

  // Adjust local form state when the sheet opens for a different
  // adapter — React's "Adjusting State Based on Props" pattern,
  // implemented via a tracked key rather than useEffect.
  const currentKey = open ? (policy?.id ?? null) : null
  const [lastKey, setLastKey] = useState<string | null>(currentKey)
  if (currentKey !== lastKey) {
    setLastKey(currentKey)
    if (open && policy) {
      setDefaultMode(policy.defaultMode ?? "auto")
      setMuted(policy.muted ?? false)
      setFrom(policy.quietHours?.from ?? "")
      setTo(policy.quietHours?.to ?? "")
    }
  }

  if (!policy) return null

  const onSave = async () => {
    if (busy) return
    setBusy(true)
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      const hasQuiet = from.length > 0 && to.length > 0
      // Dexie's `UpdateSpec<AdapterInstanceRow>` rejects `null` on a
      // non-nullable field, so we either include `quietHours` with the
      // full triple or omit the key entirely. The desktop bridge clears
      // the existing window when the outbound payload sends an explicit
      // `quietHours: null`.
      await getDb().adapterInstances.update(
        policy.id,
        hasQuiet
          ? { defaultMode, muted, quietHours: { from, to, tz }, updatedAt: Date.now() }
          : { defaultMode, muted, updatedAt: Date.now() }
      )
      if (!hasQuiet) {
        // Drop any existing quiet-hours window locally — see comment above.
        await getDb()
          .adapterInstances.where("id")
          .equals(policy.id)
          .modify((row) => {
            delete row.quietHours
          })
      }
      await enqueue({
        command: "adapter_update_policy",
        payload: {
          id: policy.id,
          defaultMode,
          muted,
          quietHours: hasQuiet ? { from, to, tz } : null,
        },
        label: t("queueLabel", { name: policy.displayName }),
      })
      toast.success(t("saved"))
      onOpenChange(false)
    } catch (err) {
      toast.error(t("saveFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" data-testid="connector-policy-sheet">
        <SheetHeader>
          <SheetTitle>{t("title", { name: policy.displayName })}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 pb-4 pt-2">
          <Label className="flex flex-col gap-1 text-xs font-medium">
            <span>{t("defaultMode")}</span>
            <Select value={defaultMode} onValueChange={(v) => setDefaultMode(v as ConnectorMode)}>
              <SelectTrigger data-testid="policy-default-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("modeAuto")}</SelectItem>
                <SelectItem value="manual">{t("modeManual")}</SelectItem>
                <SelectItem value="draft">{t("modeDraft")}</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">{t("defaultModeHelp")}</span>
          </Label>
          <Toggle
            label={t("muted")}
            help={t("mutedHelp")}
            checked={muted}
            onChange={setMuted}
            testid="policy-muted"
          />

          <div className="space-y-2">
            <Label className="text-xs font-medium">{t("quietHours")}</Label>
            <p className="text-xs text-muted-foreground">{t("quietHoursHelp")}</p>
            <div className="grid grid-cols-2 gap-2">
              <Label className="flex flex-col gap-1 text-xs">
                <span>{t("from")}</span>
                <Input
                  type="time"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  data-testid="policy-quiet-from"
                />
              </Label>
              <Label className="flex flex-col gap-1 text-xs">
                <span>{t("to")}</span>
                <Input
                  type="time"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  data-testid="policy-quiet-to"
                />
              </Label>
            </div>
          </div>
        </div>

        <SheetFooter className="px-4 pb-6">
          <Button onClick={() => void onSave()} disabled={busy} data-testid="policy-save">
            {busy ? t("saving") : t("save")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function Toggle({
  label,
  help,
  checked,
  onChange,
  testid,
}: {
  label: string
  help: string
  checked: boolean
  onChange: (next: boolean) => void
  testid: string
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-1">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} data-testid={testid} />
    </div>
  )
}
