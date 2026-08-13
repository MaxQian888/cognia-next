"use client"

/**
 * OneBot adapter configuration dialog.
 *
 * Migrated to the shared `AdapterFormSections` shell. OneBot uses a
 * reverse-WebSocket connection — the QQ client (NapCat / Lagrange /
 * LLOneBot) connects TO cognia-next, so the Delivery section surfaces the
 * exact `ws://` URL the operator must paste into the client's `wsReverse`
 * config plus a Verify-connection probe. Advanced holds the cross-cutting
 * Quiet-Hours + Mute controls.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, LoaderIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
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
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import {
  connectorsKeyringSet,
  connectorsKeyringDelete,
  connectorsHealth,
  connectorsOnebotProbe,
} from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { CONNECTORS_SERVER_PORT } from "@/lib/connectors/server-transport"
import { defaultGroupChatPolicy } from "@/types/connectors/policy"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

type ExpectedClient = "napcat" | "lagrange" | "llonebot" | "other"
type OneBotTransportMode = "reverse-ws" | "forward-ws"

interface OneBotConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

async function resolveWsEndpoint(adapterId: string): Promise<string> {
  try {
    const health = await connectorsHealth()
    const addr = health.boundAddr ?? `127.0.0.1:${CONNECTORS_SERVER_PORT}`
    return `ws://${addr}/ws/onebot/${adapterId}`
  } catch {
    return `ws://127.0.0.1:${CONNECTORS_SERVER_PORT}/ws/onebot/${adapterId}`
  }
}

export function OneBotConfigDialog({
  open,
  onOpenChange,
  row,
  onCreated,
}: OneBotConfigDialogProps) {
  const t = useTranslations("settings.connections.onebot")
  const isNew = row === null
  const settings = (row?.settings ?? {}) as {
    selfBotUin?: string
    expectedClient?: ExpectedClient
    forwardWsUrl?: string
  }

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [botUin, setBotUin] = useState(settings.selfBotUin ?? "")
  const [bearerToken, setBearerToken] = useState("")
  const [expectedClient, setExpectedClient] = useState<ExpectedClient>(
    settings.expectedClient ?? "napcat"
  )
  const [transportMode, setTransportMode] = useState<OneBotTransportMode>(
    row?.transportMode === "forward-ws" ? "forward-ws" : "reverse-ws"
  )
  const [forwardWsUrl, setForwardWsUrl] = useState(settings.forwardWsUrl ?? "")
  const accounts = row?.credentialsRef?.accounts ?? []
  const hasBearerAccount = accounts.includes("onebotBearer")
  // Inbound reverse-WS is fail-closed: with no bearer the server rejects every
  // connection unless the operator explicitly opts into unauthenticated mode
  // (a trusted localhost NapCat/Lagrange with no access token). Mirrors the
  // `onebotAllowUnauthenticated` keyring entry the Rust ws_server reads.
  const [allowUnauth, setAllowUnauth] = useState<boolean>(
    accounts.includes("onebotAllowUnauthenticated")
  )
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [saving, setSaving] = useState(false)
  const [savedAdapterId, setSavedAdapterId] = useState<string | null>(row?.id ?? null)
  const [wsEndpoint, setWsEndpoint] = useState<string>("")
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<"connected" | "timeout" | null>(null)
  const [probing, setProbing] = useState(false)
  const [liveStatus, setLiveStatus] = useState<{ connected: boolean; since?: number } | null>(null)

  const desktop = isTauri()

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    botUin.trim() !== (settings.selfBotUin ?? "") ||
    bearerToken.length > 0 ||
    expectedClient !== (settings.expectedClient ?? "napcat") ||
    transportMode !== (row?.transportMode === "forward-ws" ? "forward-ws" : "reverse-ws") ||
    forwardWsUrl.trim() !== (settings.forwardWsUrl ?? "") ||
    allowUnauth !== accounts.includes("onebotAllowUnauthenticated") ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

  // Resolve the endpoint on first mount when editing an existing row so the
  // operator sees the URL without first hitting Save. The setState lands in
  // the .then() callback (not the synchronous effect body) so this complies
  // with react-hooks/set-state-in-effect. A cancellation flag drops late
  // results if the dialog unmounts mid-flight.
  useEffect(() => {
    if (!savedAdapterId || wsEndpoint) return
    let cancelled = false
    void resolveWsEndpoint(savedAdapterId).then((url) => {
      if (!cancelled) setWsEndpoint(url)
    })
    return () => {
      cancelled = true
    }
  }, [savedAdapterId, wsEndpoint])

  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error(t("displayNameRequired"))
      return
    }
    if (!botUin.trim()) {
      toast.error(t("botUinRequired"))
      return
    }
    if (transportMode === "forward-ws" && !forwardWsUrl.trim()) {
      toast.error(t("forwardUrlRequired"))
      return
    }
    if (quietHours && (!quietHours.from || !quietHours.to || !quietHours.tz)) {
      toast.error(t("quietHoursIncomplete"))
      return
    }

    setSaving(true)
    try {
      let adapterId: string

      const onebotSettings = {
        selfBotUin: botUin.trim(),
        expectedClient,
        ...(transportMode === "forward-ws" ? { forwardWsUrl: forwardWsUrl.trim() } : {}),
      }

      // A bearer always takes precedence over the unauthenticated opt-in, and
      // the opt-in only applies to inbound reverse-WS.
      const willHaveBearer = bearerToken.trim().length > 0 || hasBearerAccount
      const wantUnauth = transportMode === "reverse-ws" && allowUnauth && !willHaveBearer

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "onebot",
          displayName: displayName.trim(),
          enabled: true,
          transportMode,
          settings: onebotSettings,
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: [
              ...(bearerToken.trim() ? ["onebotBearer"] : []),
              ...(wantUnauth ? ["onebotAllowUnauthenticated"] : []),
            ],
          },
          trigger: defaultGroupChatPolicy(),
          defaultMode: "auto",
          ...(transportMode === "reverse-ws" ? { deliveryReadiness: "unknown" as const } : {}),
          quietHours: quietHours ?? undefined,
          muted,
        })
        adapterId = newRow.id
      } else {
        adapterId = row.id
        await updateAdapterInstance(adapterId, {
          displayName: displayName.trim(),
          transportMode,
          settings: onebotSettings,
          muted,
          quietHours: quietHours ?? undefined,
          ...(transportMode === "reverse-ws" ? { deliveryReadiness: "unknown" as const } : {}),
        })
      }

      if (bearerToken.trim()) {
        await connectorsKeyringSet(adapterId, "onebotBearer", bearerToken.trim())
      }

      // Reconcile the unauthenticated opt-in flag in the keyring (the Rust
      // ws_server reads it on every connection). Set when explicitly enabled
      // with no bearer; otherwise ensure it's cleared so a stale flag can't
      // keep the listener fail-open.
      if (wantUnauth) {
        await connectorsKeyringSet(adapterId, "onebotAllowUnauthenticated", "true")
      } else {
        await connectorsKeyringDelete(adapterId, "onebotAllowUnauthenticated")
      }

      // Hot-reload the running adapter so the new bearer token is picked
      // up without an app restart.
      if (!isNew) {
        emitCredentialsRotated(adapterId)
      }

      setSavedAdapterId(adapterId)
      setWsEndpoint(await resolveWsEndpoint(adapterId))

      toast.success(isNew ? t("adapterCreatedWithEndpoint") : t("adapterUpdated"))
      if (isNew) onCreated?.(adapterId)
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleVerify = async () => {
    if (!savedAdapterId) {
      toast.error(t("saveBeforeVerify"))
      return
    }

    setVerifying(true)
    setVerifyResult(null)

    try {
      const { listen } = await import("@tauri-apps/api/event")
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("timeout"))
        }, 10_000)

        listen<void>(`connectors://onebot/${savedAdapterId}/open`, () => {
          clearTimeout(timer)
          resolve()
        }).then((unlisten) => {
          setTimeout(unlisten, 10_500)
        })
      })
      setVerifyResult("connected")
      toast.success(t("verifyConnectedToast"))
    } catch {
      setVerifyResult("timeout")
      toast.error(t("verifyTimeoutToast"))
    } finally {
      setVerifying(false)
    }
  }

  // Live-status probe: unlike "Verify connection" (which waits for a fresh
  // `open` event and so times out for an already-connected stable client),
  // this reads the server's live-client registry and reports the current
  // state immediately.
  const handleProbe = async () => {
    if (!savedAdapterId) {
      toast.error(t("saveBeforeVerify"))
      return
    }
    setProbing(true)
    try {
      const clients = await connectorsOnebotProbe()
      const mine = clients.find((c) => c.adapterId === savedAdapterId)
      setLiveStatus(mine ? { connected: true, since: mine.connectedAtMs } : { connected: false })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setProbing(false)
    }
  }

  const handleCopyEndpoint = async () => {
    if (!wsEndpoint) return
    try {
      await navigator.clipboard.writeText(wsEndpoint)
      toast.success(t("endpointCopied"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const identitySection: FormSection = {
    id: "identity",
    label: t("sectionIdentity"),
    description: t("sectionIdentityDesc"),
    defaultOpen: true,
    children: (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ob-display-name">{t("displayNameLabel")}</Label>
          <Input
            id="ob-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("displayNamePlaceholder")}
            disabled={saving}
          />
        </div>

        {/* Credentials grid — 1 col on narrow, 2 cols ≥ sm. `items-start`
            keeps each cell's height independent so help-text length differences
            don't misalign the columns. */}
        <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 sm:items-start">
          <div className="space-y-1.5">
            <Label htmlFor="ob-uin">
              {t("botUinLabel")}
              <span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">{t("botUinHelp")}</p>
            <Input
              id="ob-uin"
              value={botUin}
              onChange={(e) => setBotUin(e.target.value)}
              placeholder={t("botUinPlaceholder")}
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ob-bearer">{t("bearerTokenLabel")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("bearerTokenHelpPrefix")}{" "}
              {/* i18n-exempt: literal OneBot client configuration key */}
              <code className="text-xs">accessToken</code> {t("bearerTokenHelpSuffix")}
            </p>
            <Input
              id="ob-bearer"
              type="password"
              autoComplete="new-password"
              value={bearerToken}
              onChange={(e) => setBearerToken(e.target.value)}
              placeholder={t("bearerTokenPlaceholder")}
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ob-client">{t("expectedClientLabel")}</Label>
            <Select
              value={expectedClient}
              onValueChange={(v) => setExpectedClient(v as ExpectedClient)}
              disabled={saving}
            >
              <SelectTrigger id="ob-client">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="napcat">{t("expectedClientNapcat")}</SelectItem>
                <SelectItem value="lagrange">{t("expectedClientLagrange")}</SelectItem>
                <SelectItem value="llonebot">{t("expectedClientLlonebot")}</SelectItem>
                <SelectItem value="other">{t("expectedClientOther")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("expectedClientHelp")}</p>
          </div>
        </div>

        {transportMode === "reverse-ws" && (
          <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 p-3">
            <div className="space-y-0.5">
              <Label htmlFor="ob-allow-unauth" className="text-sm">
                {t("allowUnauthLabel")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("allowUnauthHelp")}</p>
            </div>
            <Switch
              id="ob-allow-unauth"
              checked={allowUnauth}
              onCheckedChange={setAllowUnauth}
              disabled={saving || bearerToken.trim().length > 0 || hasBearerAccount}
              aria-label={t("allowUnauthLabel")}
            />
          </div>
        )}
      </div>
    ),
  }

  const transportSelector = (
    <div className="space-y-1.5">
      <Label htmlFor="ob-transport">{t("transportModeLabel")}</Label>
      <Select
        value={transportMode}
        onValueChange={(v) => setTransportMode(v as OneBotTransportMode)}
        disabled={saving}
      >
        <SelectTrigger id="ob-transport">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="reverse-ws">{t("transportReverse")}</SelectItem>
          <SelectItem value="forward-ws">{t("transportForward")}</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t("transportModeHelp")}</p>
    </div>
  )

  const forwardWsBlock = (
    <div className="space-y-1.5">
      <Label htmlFor="ob-forward-url">
        {t("forwardUrlLabel")}
        <span className="ml-1 text-destructive">*</span>
      </Label>
      <p className="text-xs text-muted-foreground">{t("forwardUrlHelp")}</p>
      <Input
        id="ob-forward-url"
        value={forwardWsUrl}
        onChange={(e) => setForwardWsUrl(e.target.value)}
        placeholder={t("forwardUrlPlaceholder")}
        disabled={saving}
      />
    </div>
  )

  const reverseWsBlock =
    savedAdapterId && wsEndpoint ? (
      <div className="space-y-3">
        <Label className="text-xs font-medium">{t("endpointLabel")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("endpointHelpPrefix")} {/* i18n-exempt: literal OneBot client configuration key */}
          <code className="text-xs">wsReverse</code> {t("endpointHelpSuffix")}
        </p>
        <div
          className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all"
          aria-label={t("endpointAria")}
          data-testid="onebot-endpoint-display"
        >
          {wsEndpoint}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleCopyEndpoint}
            aria-label={t("endpointCopyAria")}
          >
            {t("endpointCopy")}
          </Button>
          {desktop && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleVerify}
                disabled={verifying}
                aria-label={t("verifyConnectionAria")}
              >
                {verifying ? (
                  <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t("verifyConnectionButton")
                )}
              </Button>
              {verifyResult === "connected" && (
                <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2Icon className="h-3.5 w-3.5" />
                  {t("verifyConnectedBadge")}
                </span>
              )}
              {verifyResult === "timeout" && (
                <span className="flex items-center gap-1 text-xs text-destructive">
                  <XCircleIcon className="h-3.5 w-3.5" />
                  {t("verifyTimeoutBadge")}
                </span>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleProbe}
                disabled={probing}
                aria-label={t("probeStatusAria")}
              >
                {probing ? (
                  <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t("probeStatusButton")
                )}
              </Button>
              {liveStatus?.connected && (
                <span
                  className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"
                  data-testid="onebot-live-connected"
                >
                  <CheckCircle2Icon className="h-3.5 w-3.5" />
                  {liveStatus.since
                    ? t("probeConnectedSince", {
                        time: new Date(liveStatus.since).toLocaleTimeString(),
                      })
                    : t("probeConnected")}
                </span>
              )}
              {liveStatus && !liveStatus.connected && (
                <span
                  className="flex items-center gap-1 text-xs text-muted-foreground"
                  data-testid="onebot-live-disconnected"
                >
                  <XCircleIcon className="h-3.5 w-3.5" />
                  {t("probeNotConnected")}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    ) : (
      <p className="text-xs text-muted-foreground">{t("endpointNewAdapterHint")}</p>
    )

  const deliverySection: FormSection = {
    id: "delivery",
    label: t("sectionDelivery"),
    description: t("sectionDeliveryDesc"),
    defaultOpen: true,
    children: (
      <div className="space-y-4">
        {transportSelector}
        {transportMode === "forward-ws" ? forwardWsBlock : reverseWsBlock}
      </div>
    ),
  }

  const advancedSection: FormSection = {
    id: "advanced",
    label: t("sectionAdvanced"),
    description: t("sectionAdvancedDesc"),
    children: (
      <QuietHoursAndMute
        muted={muted}
        onMutedChange={setMuted}
        quietHours={quietHours}
        onQuietHoursChange={setQuietHours}
        disabled={saving}
      />
    ),
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isNew ? t("titleNew") : t("titleEdit")}</DialogTitle>
        </DialogHeader>

        <div className="-mx-6 flex-1 overflow-y-auto px-6">
          <AdapterFormSections
            sections={[identitySection, deliverySection, advancedSection]}
            onSubmit={handleSave}
            onCancel={() => onOpenChange(false)}
            submitting={saving}
            dirty={dirty}
            submitLabel={isNew ? t("create") : t("save")}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
