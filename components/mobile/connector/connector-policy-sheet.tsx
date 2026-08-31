"use client"

/**
 * Mobile bot-policy editor.
 *
 * Edits ONE BOT, not one conversation — every control here changes how the
 * adapter behaves in every chat it is in. The strings used to say
 * "conversation", which made muting a bot everywhere look like silencing a
 * single thread.
 *
 * The optimistic Dexie write and the relayed `adapter_update_policy` are
 * derived from the SAME wire payload (`adapterPolicyMirrorPatch`), so the local
 * mirror cannot claim a policy the host is not running. Before the request
 * schema grew the fields below, this sheet rendered the composition axes and
 * the A2UI switch, sent them, and had the whole request rejected by
 * `additionalProperties: false` — the phone said "saved" and nothing moved.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { adapterPolicyMirrorPatch } from "@/lib/connectors/adapter-policy-relay"
import {
  fromTriggerPolicyDraft,
  toTriggerPolicyDraft,
  type TriggerPolicyDraft,
} from "@/lib/connectors/trigger-policy-draft"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow, ImHostCapabilityId } from "@/lib/db/connector-types"
import {
  ConversationBehaviorEditor,
  type ConversationBehaviorValue,
} from "@/components/settings/connections/forms/conversation-behavior-editor"
import { TriggerPolicyEditor } from "@/components/settings/connections/forms/trigger-policy-editor"

/**
 * A projection of the row, not a hand-copied one.
 *
 * `Pick` rather than a free-standing interface so the caller can pass the whole
 * `AdapterInstanceRow` and no field can be forgotten on the way in. It was an
 * interface, the list copied five fields into it, and the three activation
 * controls the sheet already rendered were therefore always seeded empty.
 */
export type ConnectorPolicy = Pick<AdapterInstanceRow, "id" | "displayName" | "defaultMode"> &
  Partial<
    Pick<
      AdapterInstanceRow,
      | "muted"
      | "quietHours"
      | "defaultAutonomy"
      | "defaultEngagement"
      | "defaultAuthority"
      | "inboundActivationPolicy"
      | "activeRunDispatchMode"
      | "activationTtlMs"
      | "a2uiEnabled"
      | "hostCapabilityCeiling"
      | "trigger"
      // Only `delegate` reads these: background work has no carrier without a
      // team or workflow, so without them the editor showed that preset as
      // permanently unavailable even on a bot that had one bound.
      | "defaultTeamId"
      | "defaultWorkflowId"
    >
  >

export interface ConnectorPolicySheetProps {
  open: boolean
  policy: ConnectorPolicy | null
  onOpenChange: (next: boolean) => void
}

const HOST_CAPABILITIES: readonly ImHostCapabilityId[] = [
  "computer_use",
  "ocr",
  "goal_driving",
  "schedule_tools",
]

interface PolicyDraft {
  behavior: ConversationBehaviorValue
  muted: boolean
  from: string
  to: string
  capabilities: ImHostCapabilityId[]
  trigger: TriggerPolicyDraft
}

function draftFrom(policy: ConnectorPolicy | null): PolicyDraft {
  return {
    behavior: {
      mode: policy?.defaultMode ?? "auto",
      autonomy: policy?.defaultAutonomy,
      engagement: policy?.defaultEngagement,
      authority: policy?.defaultAuthority,
      inboundActivationPolicy: policy?.inboundActivationPolicy,
      activeRunDispatchMode: policy?.activeRunDispatchMode,
      activationTtlHours: policy?.activationTtlMs
        ? String(policy.activationTtlMs / 3_600_000)
        : "",
      a2ui: policy?.a2uiEnabled,
    },
    muted: policy?.muted ?? false,
    from: policy?.quietHours?.from ?? "",
    to: policy?.quietHours?.to ?? "",
    // An absent ceiling means "no clamp", which is every capability allowed.
    capabilities: policy?.hostCapabilityCeiling ?? [...HOST_CAPABILITIES],
    trigger: toTriggerPolicyDraft(policy?.trigger),
  }
}

export function ConnectorPolicySheet({ open, policy, onOpenChange }: ConnectorPolicySheetProps) {
  const t = useTranslations("mobile.connectorPolicy")
  const tPerm = useTranslations("settings.connections.permissionsEditor")
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFrom(policy))
  const [triggerOpen, setTriggerOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  // Adjust local form state when the sheet opens for a different
  // adapter — React's "Adjusting State Based on Props" pattern,
  // implemented via a tracked key rather than useEffect.
  const currentKey = open ? (policy?.id ?? null) : null
  const [lastKey, setLastKey] = useState<string | null>(currentKey)
  if (currentKey !== lastKey) {
    setLastKey(currentKey)
    if (open && policy) {
      setDraft(draftFrom(policy))
      setTriggerOpen(false)
    }
  }

  if (!policy) return null

  const patch = <K extends keyof PolicyDraft>(key: K, next: PolicyDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: next }))

  const toggleCapability = (capability: ImHostCapabilityId, allowed: boolean) =>
    patch(
      "capabilities",
      allowed
        ? HOST_CAPABILITIES.filter(
            (item) => item === capability || draft.capabilities.includes(item)
          )
        : draft.capabilities.filter((item) => item !== capability)
    )

  const onSave = async () => {
    if (busy) return
    setBusy(true)
    try {
      const { behavior } = draft
      const hours = Number(behavior.activationTtlHours)
      const hasQuiet = draft.from.length > 0 && draft.to.length > 0
      const nextTrigger = fromTriggerPolicyDraft(draft.trigger)
      // Compare against the ROUND-TRIPPED seed, so the draft model's own
      // normalisation never reads as an edit. An untouched trigger policy is
      // left out of the payload entirely: this sheet keeps it behind a
      // collapsible, and a relay that always sent one would overwrite the
      // bot's real gating with whatever a not-yet-synced mirror held —
      // a bot that answers nobody.
      const seedTrigger = fromTriggerPolicyDraft(toTriggerPolicyDraft(policy.trigger))
      const triggerChanged = JSON.stringify(nextTrigger) !== JSON.stringify(seedTrigger)

      // `null` is not "off" anywhere in this payload — it is "unpin this", the
      // only way JSON can carry a clear. Every axis is sent on every save
      // because this is a whole-form editor: what the operator sees is the
      // complete state, so what it relays has to be too.
      const payload: Record<string, unknown> = {
        id: policy.id,
        defaultMode: behavior.mode ?? "auto",
        defaultAutonomy: behavior.autonomy ?? null,
        defaultEngagement: behavior.engagement ?? null,
        defaultAuthority: behavior.authority ?? null,
        inboundActivationPolicy: behavior.inboundActivationPolicy ?? null,
        activeRunDispatchMode: behavior.activeRunDispatchMode ?? null,
        activationTtlMs:
          Number.isFinite(hours) && hours > 0 ? Math.round(hours * 3_600_000) : null,
        a2uiEnabled: behavior.a2ui ?? null,
        muted: draft.muted,
        quietHours: hasQuiet
          ? { from: draft.from, to: draft.to, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }
          : null,
        // Allowing everything is the absence of a clamp, not a clamp listing
        // everything — same rule the desktop permissions card writes by.
        hostCapabilityCeiling:
          draft.capabilities.length === HOST_CAPABILITIES.length ? null : draft.capabilities,
      }
      if (triggerChanged) payload.trigger = nextTrigger

      // Derived from the payload, so the mirror shows exactly what the host
      // will hold. A cleared field arrives here as a present `undefined` key,
      // which is what Dexie's `update` removes.
      await getDb().adapterInstances.update(policy.id, {
        ...adapterPolicyMirrorPatch(payload),
        updatedAt: Date.now(),
      })
      await enqueue({
        command: "adapter_update_policy",
        payload,
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

        <div className="flex max-h-[70svh] flex-col gap-4 overflow-y-auto px-4 pb-4 pt-2">
          <ConversationBehaviorEditor
            scope="adapter"
            value={draft.behavior}
            onChange={(next) => patch("behavior", next)}
            targetKind={
              policy.defaultTeamId ? "team" : policy.defaultWorkflowId ? "workflow" : "direct"
            }
          />

          <Toggle
            label={t("muted")}
            help={t("mutedHelp")}
            checked={draft.muted}
            onChange={(next) => patch("muted", next)}
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
                  value={draft.from}
                  onChange={(e) => patch("from", e.target.value)}
                  data-testid="policy-quiet-from"
                />
              </Label>
              <Label className="flex flex-col gap-1 text-xs">
                <span>{t("to")}</span>
                <Input
                  type="time"
                  value={draft.to}
                  onChange={(e) => patch("to", e.target.value)}
                  data-testid="policy-quiet-to"
                />
              </Label>
            </div>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs font-medium">{tPerm("hostCapabilities")}</Label>
              <p className="text-xs text-muted-foreground">{t("capabilitiesHelp")}</p>
            </div>
            {HOST_CAPABILITIES.map((capability) => (
              <div key={capability} className="flex items-center justify-between gap-3">
                <p className="text-sm">{tPerm(`host.${capability}`)}</p>
                <Switch
                  checked={draft.capabilities.includes(capability)}
                  onCheckedChange={(checked) => toggleCapability(capability, checked)}
                  data-testid={`policy-capability-${capability}`}
                />
              </div>
            ))}
          </div>

          {/* Collapsed by default and left out of the payload until touched —
              a dozen controls behind one disclosure, not a wall of them. */}
          <Collapsible open={triggerOpen} onOpenChange={setTriggerOpen}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-between px-0"
                data-testid="policy-trigger-toggle"
              >
                <span className="text-xs font-medium">{t("triggerSection")}</span>
                <ChevronDownIcon
                  className={`size-4 transition-transform ${triggerOpen ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2">
              <p className="text-xs text-muted-foreground">{t("triggerHelp")}</p>
              <TriggerPolicyEditor
                idPrefix="mobile-trigger"
                value={draft.trigger}
                onChange={(next) => patch("trigger", next)}
              />
            </CollapsibleContent>
          </Collapsible>
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
