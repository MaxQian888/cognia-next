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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringSet, connectorsHealth } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultGroupChatPolicy } from "@/types/connectors/policy"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

type ExpectedClient = "napcat" | "lagrange" | "llonebot" | "other"

interface OneBotConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

async function resolveWsEndpoint(adapterId: string): Promise<string> {
  try {
    const health = await connectorsHealth()
    const addr = health.boundAddr ?? "127.0.0.1:8080"
    return `ws://${addr}/ws/onebot/${adapterId}`
  } catch {
    return `ws://127.0.0.1:8080/ws/onebot/${adapterId}`
  }
}

export function OneBotConfigDialog({ open, onOpenChange, row }: OneBotConfigDialogProps) {
  const t = useTranslations("settings.connections.onebot")
  const isNew = row === null
  const settings = (row?.settings ?? {}) as {
    selfBotUin?: string
    expectedClient?: ExpectedClient
  }

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [botUin, setBotUin] = useState(settings.selfBotUin ?? "")
  const [bearerToken, setBearerToken] = useState("")
  const [expectedClient, setExpectedClient] = useState<ExpectedClient>(
    settings.expectedClient ?? "napcat"
  )
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [saving, setSaving] = useState(false)
  const [savedAdapterId, setSavedAdapterId] = useState<string | null>(row?.id ?? null)
  const [wsEndpoint, setWsEndpoint] = useState<string>("")
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<"connected" | "timeout" | null>(null)

  const desktop = isTauri()

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    botUin.trim() !== (settings.selfBotUin ?? "") ||
    bearerToken.length > 0 ||
    expectedClient !== (settings.expectedClient ?? "napcat") ||
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
    if (quietHours && (!quietHours.from || !quietHours.to || !quietHours.tz)) {
      toast.error(t("quietHoursIncomplete"))
      return
    }

    setSaving(true)
    try {
      let adapterId: string

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "onebot",
          displayName: displayName.trim(),
          enabled: true,
          transportMode: "reverse-ws",
          settings: {
            selfBotUin: botUin.trim(),
            expectedClient,
          },
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: bearerToken.trim() ? ["onebotBearer"] : [],
          },
          trigger: defaultGroupChatPolicy(),
          defaultMode: "auto",
          quietHours: quietHours ?? undefined,
          muted,
        })
        adapterId = newRow.id
      } else {
        adapterId = row.id
        await updateAdapterInstance(adapterId, {
          displayName: displayName.trim(),
          settings: {
            selfBotUin: botUin.trim(),
            expectedClient,
          },
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      if (bearerToken.trim()) {
        await connectorsKeyringSet(adapterId, "onebotBearer", bearerToken.trim())
      }

      // Hot-reload the running adapter so the new bearer token is picked
      // up without an app restart.
      if (!isNew) {
        emitCredentialsRotated(adapterId)
      }

      setSavedAdapterId(adapterId)
      setWsEndpoint(await resolveWsEndpoint(adapterId))

      toast.success(isNew ? t("adapterCreatedWithEndpoint") : t("adapterUpdated"))
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
            {t("bearerTokenHelpPrefix")} <code className="text-xs">accessToken</code>{" "}
            {t("bearerTokenHelpSuffix")}
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
    ),
  }

  const deliverySection: FormSection = {
    id: "delivery",
    label: t("sectionDelivery"),
    description: t("sectionDeliveryDesc"),
    defaultOpen: true,
    children:
      savedAdapterId && wsEndpoint ? (
        <div className="space-y-3">
          <Label className="text-xs font-medium">{t("endpointLabel")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("endpointHelpPrefix")} <code className="text-xs">wsReverse</code>{" "}
            {t("endpointHelpSuffix")}
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
              </>
            )}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("endpointNewAdapterHint")}</p>
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? t("titleNew") : t("titleEdit")}</DialogTitle>
        </DialogHeader>

        <AdapterFormSections
          sections={[identitySection, deliverySection, advancedSection]}
          onSubmit={handleSave}
          onCancel={() => onOpenChange(false)}
          submitting={saving}
          dirty={dirty}
          submitLabel={isNew ? t("create") : t("save")}
        />
      </DialogContent>
    </Dialog>
  )
}
