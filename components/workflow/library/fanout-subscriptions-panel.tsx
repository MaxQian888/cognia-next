"use client"

/**
 * Workflow fan-out subscriptions panel (im-a2ui-abstract-anchor Phase 7).
 *
 * Operator surface for "every run of workflow X mirrors progress into
 * channel Y". Lists live + disabled rows for a workflow, lets the
 * operator add a row by picking an adapter + pasting a `conversationKey`,
 * toggle `enabled`, and delete. The progress-runner reads these rows at
 * watcher creation; updates are visible on the NEXT run start (not
 * mid-run — explicit by design).
 *
 * `conversationKey` is platform-prefixed (e.g. `lark:lark:ad1:oc_xxx`) —
 * the operator gets this from the inbox conversation header or the
 * connector audit log; we don't try to render a chooser because chat
 * lists aren't always available from inside Settings.
 */

import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { PlusIcon, TrashIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listAdapterInstances } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import {
  createFanoutSubscription,
  deleteFanoutSubscription,
  setSubscriptionEnabled,
} from "@/lib/db/workflow-fanout-subscriptions"
import type { WorkflowFanoutSubscriptionRow } from "@/lib/db/connector-types"

export interface FanoutSubscriptionsPanelProps {
  workflowId: string
}

export function FanoutSubscriptionsPanel({ workflowId }: FanoutSubscriptionsPanelProps) {
  const t = useTranslations("settings.workflow.fanout")
  const [adapters, setAdapters] = useState<AdapterInstanceRow[]>([])
  const [selectedAdapter, setSelectedAdapter] = useState<string>("")
  const [conversationKey, setConversationKey] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void listAdapterInstances().then((rows) => {
      if (cancelled) return
      const live = rows.filter((r) => r.enabled)
      setAdapters(live)
      if (!selectedAdapter && live.length > 0) setSelectedAdapter(live[0].id)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const subscriptions =
    useLiveQuery(
      async () =>
        getDb().workflowFanoutSubscriptions.where("workflowId").equals(workflowId).toArray(),
      [workflowId]
    ) ?? []

  const handleAdd = async () => {
    const adapterId = selectedAdapter.trim()
    const key = conversationKey.trim()
    if (!adapterId || !key) {
      toast.error(t("addMissingFields"))
      return
    }
    setSaving(true)
    try {
      await createFanoutSubscription({
        workflowId,
        adapterId,
        conversationKey: key,
        createdBy: "settings-ui",
      })
      setConversationKey("")
      toast.success(t("addSuccess"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await setSubscriptionEnabled(id, enabled)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteFanoutSubscription(id)
      toast.success(t("removeSuccess"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card data-testid="fanout-subscriptions-panel">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t("help")}</p>

        <div className="space-y-2 rounded-md border p-3">
          <Label className="text-xs font-medium">{t("addSectionLabel")}</Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <Select
              value={selectedAdapter}
              onValueChange={setSelectedAdapter}
              disabled={saving || adapters.length === 0}
            >
              <SelectTrigger data-testid="fanout-adapter-select" aria-label={t("adapterLabel")}>
                <SelectValue placeholder={t("adapterPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {adapters.map((adapter) => (
                  <SelectItem key={adapter.id} value={adapter.id}>
                    {adapter.displayName} ({adapter.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={conversationKey}
              placeholder={t("conversationKeyPlaceholder")}
              onChange={(e) => setConversationKey(e.target.value)}
              disabled={saving}
              aria-label={t("conversationKeyLabel")}
              data-testid="fanout-conversation-key"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleAdd}
              disabled={saving || adapters.length === 0}
              aria-label={t("addButton")}
              data-testid="fanout-add"
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {subscriptions.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-1.5" data-testid="fanout-list">
            {subscriptions.map((sub: WorkflowFanoutSubscriptionRow) => {
              const adapter = adapters.find((a) => a.id === sub.adapterId)
              return (
                <li
                  key={sub.id}
                  className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
                  data-testid={`fanout-item-${sub.id}`}
                >
                  <Switch
                    checked={sub.enabled}
                    onCheckedChange={(v) => handleToggle(sub.id, Boolean(v))}
                    aria-label={t("enabledAria")}
                    data-testid={`fanout-toggle-${sub.id}`}
                  />
                  <span className="font-mono">{adapter?.displayName ?? sub.adapterId}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="flex-1 truncate font-mono">{sub.conversationKey}</span>
                  <button
                    type="button"
                    onClick={() => handleDelete(sub.id)}
                    aria-label={t("removeAria")}
                    className="rounded-sm hover:bg-muted"
                    data-testid={`fanout-remove-${sub.id}`}
                  >
                    <TrashIcon className="h-3 w-3" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
