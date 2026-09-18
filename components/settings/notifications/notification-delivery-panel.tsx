"use client"

// V2 delivery management (the external-notification control surface). Lists
// the durable targets and subscriptions the policy engine routes through, and
// lets the operator register Feishu webhook endpoints and bind them to a
// scope/source/run with a minimum level and a disclosure ceiling. Reads and
// writes go through lib/notifications/api.ts — the same path the planner
// consults — so a target or subscription added here is immediately eligible
// for governed delivery. The in-app center is always on and is not a target.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { BellIcon, PlusIcon, TrashIcon, WebhookIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
  listNotificationTargets,
  upsertNotificationTarget,
  deleteNotificationTarget,
  listNotificationSubscriptions,
  upsertNotificationSubscription,
  deleteNotificationSubscription,
} from "@/lib/notifications/api"
import { resolveNotificationScope } from "@/lib/notifications/scope"
import {
  NOTIFICATION_LEVELS,
  NOTIFICATION_SOURCES,
  type NotificationLevel,
} from "@/types/notifications"
import { notificationScopeKey, type NotificationScope } from "@/types/notifications/scope"
import { DEFAULT_DISCLOSURE_PROFILES, type NotificationTarget } from "@/types/notifications/target"
import type { NotificationSubscription } from "@/types/notifications/subscription"

type BindingKind = NotificationSubscription["binding"]["kind"]

function bindingLabel(
  binding: NotificationSubscription["binding"],
  t: (key: string) => string
): string {
  switch (binding.kind) {
    case "scope":
      return t("bindingScope")
    case "source":
      return `${t("bindingSource")}: ${binding.source}`
    case "run":
      return `${t("bindingRun")}: ${binding.runId}`
  }
}

export function NotificationDeliveryPanel() {
  const t = useTranslations("settings.notifications.delivery")
  const tSources = useTranslations("notificationCenter.sources")
  const tLevels = useTranslations("notificationCenter.levels")

  const [scope, setScope] = useState<NotificationScope | null>(null)
  const [targets, setTargets] = useState<NotificationTarget[]>([])
  const [subscriptions, setSubscriptions] = useState<NotificationSubscription[]>([])
  const [busy, setBusy] = useState(false)

  const [showTargetForm, setShowTargetForm] = useState(false)
  const [tLabel, setTLabel] = useState("")
  const [tEndpoint, setTEndpoint] = useState("")
  const [tSigning, setTSigning] = useState("")
  const [tRegion, setTRegion] = useState<"feishu" | "lark">("feishu")
  const [tDisclosure, setTDisclosure] = useState("internal")

  const [showSubForm, setShowSubForm] = useState(false)
  const [sKind, setSKind] = useState<BindingKind>("scope")
  const [sSource, setSSource] = useState(NOTIFICATION_SOURCES[0])
  const [sRunId, setSRunId] = useState("")
  const [sMinLevel, setSMinLevel] = useState<NotificationLevel>("info")
  const [sDisclosure, setSDisclosure] = useState("internal")
  const [sTargets, setSTargets] = useState<ReadonlySet<string>>(new Set())

  const scopeKey = useMemo(() => (scope ? notificationScopeKey(scope) : null), [scope])

  const reload = useCallback(async (key: string) => {
    const [tg, sub] = await Promise.all([
      listNotificationTargets(key),
      listNotificationSubscriptions(key),
    ])
    setTargets(tg)
    setSubscriptions(sub)
  }, [])

  useEffect(() => {
    let cancelled = false
    void resolveNotificationScope().then((s) => {
      if (cancelled) return
      setScope(s)
      void reload(notificationScopeKey(s))
    })
    return () => {
      cancelled = true
    }
  }, [reload])

  const mutate = async (op: () => Promise<unknown>) => {
    if (!scopeKey) return
    setBusy(true)
    try {
      await op()
      await reload(scopeKey)
    } finally {
      setBusy(false)
    }
  }

  const toggleTarget = (target: NotificationTarget, enabled: boolean) =>
    mutate(() =>
      upsertNotificationTarget({
        id: target.id,
        scope: target.scope,
        label: target.label,
        address: target.address,
        enabled,
        consent: target.consent,
        disclosureProfileId: target.disclosureProfileId,
        locale: target.locale,
        timezone: target.timezone,
        expectedVersion: target.version,
      })
    )

  const addTarget = () =>
    mutate(async () => {
      if (!scope || !tLabel.trim() || !tEndpoint.trim()) return
      const now = Date.now()
      const accountId = scope.accountId
      await upsertNotificationTarget({
        scope,
        label: tLabel.trim(),
        address: {
          kind: "feishu-webhook",
          endpointSecretRef: tEndpoint.trim(),
          ...(tSigning.trim() ? { signingSecretRef: tSigning.trim() } : {}),
          region: tRegion,
        },
        enabled: true,
        consent: {
          mode: "proactive",
          grantRef: "settings:notifications",
          grantedBy: accountId,
          grantedAt: now,
        },
        disclosureProfileId: tDisclosure,
        locale: typeof navigator !== "undefined" ? navigator.language : "en",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
      })
      setTLabel("")
      setTEndpoint("")
      setTSigning("")
      setShowTargetForm(false)
    })

  const toggleSubscription = (sub: NotificationSubscription, enabled: boolean) =>
    mutate(() =>
      upsertNotificationSubscription({
        id: sub.id,
        scope: sub.scope,
        principalId: sub.principalId,
        binding: sub.binding,
        targetIds: sub.targetIds,
        maxDisclosureProfileId: sub.maxDisclosureProfileId,
        minLevel: sub.minLevel,
        enabled,
        createdBy: sub.createdBy,
        expectedVersion: sub.version,
      })
    )

  const addSubscription = () =>
    mutate(async () => {
      if (!scope || sTargets.size === 0) return
      if (sKind === "run" && !sRunId.trim()) return
      const binding: NotificationSubscription["binding"] =
        sKind === "scope"
          ? { kind: "scope" }
          : sKind === "source"
            ? { kind: "source", source: sSource }
            : { kind: "run", runId: sRunId.trim() }
      await upsertNotificationSubscription({
        scope,
        principalId: scope.accountId,
        binding,
        targetIds: [...sTargets],
        maxDisclosureProfileId: sDisclosure,
        minLevel: sMinLevel,
        enabled: true,
        createdBy: scope.accountId,
      })
      setSTargets(new Set())
      setSRunId("")
      setShowSubForm(false)
    })

  const toggleSubTarget = (id: string, on: boolean) => {
    setSTargets((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const disclosureName = (id: string) =>
    DEFAULT_DISCLOSURE_PROFILES.some((p) => p.id === id) ? t(`disclosure.${id}`) : id

  return (
    <div className="space-y-6" data-testid="notification-delivery-panel">
      {/* ── Delivery targets ─────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label className="text-sm">{t("targetsLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("targetsHint")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowTargetForm((v) => !v)}
            data-testid="add-target-toggle"
          >
            <PlusIcon className="mr-1 size-4" />
            {t("addTarget")}
          </Button>
        </div>

        {showTargetForm && (
          <div className="space-y-3 rounded-md border p-3" data-testid="target-form">
            <div className="space-y-1">
              <Label htmlFor="tgt-label" className="text-xs">
                {t("targetNameLabel")}
              </Label>
              <Input
                id="tgt-label"
                value={tLabel}
                onChange={(e) => setTLabel(e.target.value)}
                placeholder={t("targetNamePlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tgt-endpoint" className="text-xs">
                {t("endpointSecretRefLabel")}
              </Label>
              <Input
                id="tgt-endpoint"
                value={tEndpoint}
                onChange={(e) => setTEndpoint(e.target.value)}
                placeholder={t("endpointSecretRefPlaceholder")}
              />
              <p className="text-[11px] text-muted-foreground">{t("endpointSecretRefHint")}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="tgt-signing" className="text-xs">
                {t("signingSecretRefLabel")}
              </Label>
              <Input
                id="tgt-signing"
                value={tSigning}
                onChange={(e) => setTSigning(e.target.value)}
                placeholder={t("signingSecretRefPlaceholder")}
              />
            </div>
            <div className="flex items-center gap-3">
              <div className="space-y-1">
                <Label htmlFor="tgt-region" className="text-xs">
                  {t("regionLabel")}
                </Label>
                <Select value={tRegion} onValueChange={(v) => setTRegion(v as "feishu" | "lark")}>
                  <SelectTrigger id="tgt-region" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="feishu">
                      {/* i18n-exempt: brand name, identical in every language */}Feishu
                    </SelectItem>
                    <SelectItem value="lark">
                      {/* i18n-exempt: brand name, identical in every language */}Lark
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="tgt-disclosure" className="text-xs">
                  {t("disclosureLabel")}
                </Label>
                <Select value={tDisclosure} onValueChange={setTDisclosure}>
                  <SelectTrigger id="tgt-disclosure" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEFAULT_DISCLOSURE_PROFILES.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {t(`disclosure.${p.id}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowTargetForm(false)}>
                {t("cancel")}
              </Button>
              <Button
                size="sm"
                disabled={busy || !tLabel.trim() || !tEndpoint.trim()}
                onClick={() => void addTarget()}
                data-testid="save-target"
              >
                {t("saveTarget")}
              </Button>
            </div>
          </div>
        )}

        {targets.length === 0 && !showTargetForm ? (
          <p className="text-xs text-muted-foreground" data-testid="no-targets">
            {t("noTargets")}
          </p>
        ) : (
          <div className="space-y-1.5">
            {targets.map((target) => (
              <div
                key={target.id}
                className="flex items-center justify-between rounded-md border p-2.5"
                data-testid="target-row"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                    {target.address.kind === "feishu-webhook" ? (
                      <WebhookIcon className="size-3.5" />
                    ) : (
                      <BellIcon className="size-3.5" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{target.label}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {t(`kind.${target.address.kind}`)} ·{" "}
                      {disclosureName(target.disclosureProfileId)}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Switch
                    checked={target.enabled}
                    onCheckedChange={(on) => void toggleTarget(target, on)}
                    aria-label={t("toggleTarget")}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={t("deleteTarget")}
                    onClick={() => void mutate(() => deleteNotificationTarget(target.id))}
                  >
                    <TrashIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Subscriptions ────────────────────────────────────────────── */}
      <div className="space-y-2 border-t pt-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label className="text-sm">{t("subscriptionsLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("subscriptionsHint")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSubForm((v) => !v)}
            disabled={targets.length === 0}
            data-testid="add-subscription-toggle"
          >
            <PlusIcon className="mr-1 size-4" />
            {t("addSubscription")}
          </Button>
        </div>

        {showSubForm && (
          <div className="space-y-3 rounded-md border p-3" data-testid="subscription-form">
            <div className="flex items-center gap-3">
              <div className="space-y-1">
                <Label htmlFor="sub-kind" className="text-xs">
                  {t("bindingLabel")}
                </Label>
                <Select value={sKind} onValueChange={(v) => setSKind(v as BindingKind)}>
                  <SelectTrigger id="sub-kind" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="scope">{t("bindingScope")}</SelectItem>
                    <SelectItem value="source">{t("bindingSource")}</SelectItem>
                    <SelectItem value="run">{t("bindingRun")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {sKind === "source" && (
                <div className="space-y-1">
                  <Label htmlFor="sub-source" className="text-xs">
                    {t("sourceLabel")}
                  </Label>
                  <Select value={sSource} onValueChange={(v) => setSSource(v as typeof sSource)}>
                    <SelectTrigger id="sub-source" className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {NOTIFICATION_SOURCES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {tSources(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {sKind === "run" && (
                <div className="flex-1 space-y-1">
                  <Label htmlFor="sub-run" className="text-xs">
                    {t("runIdLabel")}
                  </Label>
                  <Input
                    id="sub-run"
                    value={sRunId}
                    onChange={(e) => setSRunId(e.target.value)}
                    placeholder={t("runIdPlaceholder")}
                  />
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <div className="space-y-1">
                <Label htmlFor="sub-level" className="text-xs">
                  {t("minLevelLabel")}
                </Label>
                <Select
                  value={sMinLevel}
                  onValueChange={(v) => setSMinLevel(v as NotificationLevel)}
                >
                  <SelectTrigger id="sub-level" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {NOTIFICATION_LEVELS.map((lv) => (
                      <SelectItem key={lv} value={lv}>
                        {tLevels(lv)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="sub-disclosure" className="text-xs">
                  {t("disclosureLabel")}
                </Label>
                <Select value={sDisclosure} onValueChange={setSDisclosure}>
                  <SelectTrigger id="sub-disclosure" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEFAULT_DISCLOSURE_PROFILES.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {t(`disclosure.${p.id}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t("pickTargetsLabel")}</Label>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {targets.map((target) => (
                  <label
                    key={target.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm"
                  >
                    <Checkbox
                      checked={sTargets.has(target.id)}
                      onCheckedChange={(on) => toggleSubTarget(target.id, on === true)}
                    />
                    <span className="truncate">{target.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowSubForm(false)}>
                {t("cancel")}
              </Button>
              <Button
                size="sm"
                disabled={busy || sTargets.size === 0 || (sKind === "run" && !sRunId.trim())}
                onClick={() => void addSubscription()}
                data-testid="save-subscription"
              >
                {t("saveSubscription")}
              </Button>
            </div>
          </div>
        )}

        {subscriptions.length === 0 && !showSubForm ? (
          <p className="text-xs text-muted-foreground" data-testid="no-subscriptions">
            {t("noSubscriptions")}
          </p>
        ) : (
          <div className="space-y-1.5">
            {subscriptions.map((sub) => (
              <div
                key={sub.id}
                className="flex items-center justify-between rounded-md border p-2.5"
                data-testid="subscription-row"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{bindingLabel(sub.binding, t)}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {t("subMeta", {
                      count: sub.targetIds.length,
                      level: tLevels(sub.minLevel),
                    })}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Switch
                    checked={sub.enabled}
                    onCheckedChange={(on) => void toggleSubscription(sub, on)}
                    aria-label={t("toggleSubscription")}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={t("deleteSubscription")}
                    onClick={() => void mutate(() => deleteNotificationSubscription(sub.id))}
                  >
                    <TrashIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
