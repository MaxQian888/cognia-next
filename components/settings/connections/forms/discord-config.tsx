"use client"

/**
 * Discord adapter configuration dialog.
 *
 * Migrated to the shared `AdapterFormSections` shell — Identity / Delivery /
 * Advanced collapsible sections. Discord uses gateway transport in v1; the
 * Delivery section also exposes the optional Ed25519 public key used for
 * Interactions webhook verification, plus the application's slash-command
 * endpoint URL (derived from the running Cloudflared tunnel) so the
 * operator can paste it into the Discord developer portal.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, ExternalLinkIcon, LoaderIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsHttpRequest, connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"
import { useTunnelStatus } from "@/hooks/use-tunnel-status"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

interface GetCurrentUserResult {
  ok: boolean
  username?: string
  id?: string
  error?: string
}

async function testDiscordToken(token: string): Promise<GetCurrentUserResult> {
  try {
    const resp = await connectorsHttpRequest({
      url: "https://discord.com/api/v10/users/@me",
      method: "GET",
      headers: { Authorization: `Bot ${token}` },
      timeoutMs: 8000,
    })
    const parsed = JSON.parse(resp.body) as {
      id?: string
      username?: string
      code?: number
      message?: string
    }
    if (parsed.id && parsed.username) {
      return { ok: true, username: parsed.username, id: parsed.id }
    }
    return { ok: false, error: parsed.message ?? "Unknown error" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

interface DiscordConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

export function DiscordConfigDialog({ open, onOpenChange, row }: DiscordConfigDialogProps) {
  const t = useTranslations("settings.connections.discord")
  const isNew = row === null

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [botToken, setBotToken] = useState("")
  const [publicKey, setPublicKey] = useState("")
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<GetCurrentUserResult | null>(null)
  const [saving, setSaving] = useState(false)

  const desktop = isTauri()
  const tunnel = useTunnelStatus()

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    botToken.length > 0 ||
    publicKey.length > 0 ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

  const handleTest = async () => {
    if (!botToken.trim()) {
      toast.error(t("tokenRequiredForTest"))
      return
    }
    setTesting(true)
    setTestResult(null)
    const result = await testDiscordToken(botToken.trim())
    setTestResult(result)
    setTesting(false)
    if (result.ok) {
      toast.success(t("connectedToast", { username: result.username ?? t("unknownUsername") }))
    } else {
      toast.error(result.error ?? t("connectionFailedToast"))
    }
  }

  const handleCopyInteractionsUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t("interactionsUrlCopied"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error(t("displayNameRequired"))
      return
    }
    if (isNew && !botToken.trim()) {
      toast.error(t("botTokenRequired"))
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
          type: "discord",
          displayName: displayName.trim(),
          enabled: true,
          transportMode: "gateway",
          settings: {},
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: ["botToken"],
          },
          trigger: defaultPrivateChatPolicy(),
          defaultMode: "auto",
          quietHours: quietHours ?? undefined,
          muted,
        })
        adapterId = newRow.id
      } else {
        adapterId = row.id
        await updateAdapterInstance(adapterId, {
          displayName: displayName.trim(),
          transportMode: "gateway",
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      if (botToken.trim()) {
        await connectorsKeyringSet(adapterId, "botToken", botToken.trim())
      }
      // Hot-reload the running adapter so the new bot token is picked up
      // without an app restart.
      if (!isNew) {
        emitCredentialsRotated(adapterId)
      }
      // Phase 1 ships gateway transport only — the Interactions webhook
      // path is not consumed yet. We intentionally do NOT write the
      // public key to keyring to avoid the "ghost credential" foot-gun
      // where the operator thinks the field is active. The input stays
      // mounted (clearly labelled `[Phase 2]`) so credentials can be
      // captured in advance and persisted once webhook mode lands.

      toast.success(isNew ? t("adapterCreated") : t("adapterUpdated"))
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const interactionsPath = isNew ? null : `/webhook/discord/${row?.id ?? ""}/interactions`
  const interactionsUrl =
    tunnel.url && interactionsPath ? `${tunnel.url.replace(/\/$/, "")}${interactionsPath}` : null

  const identitySection: FormSection = {
    id: "identity",
    label: t("sectionIdentity"),
    description: t("sectionIdentityDesc"),
    defaultOpen: true,
    children: (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="dc-display-name">{t("displayNameLabel")}</Label>
          <Input
            id="dc-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("displayNamePlaceholder")}
            disabled={saving}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="dc-bot-token">
            {t("botTokenLabel")}
            <span className="ml-1 text-destructive">*</span>
          </Label>
          <p className="text-xs text-muted-foreground">{t("botTokenHelp")}</p>
          <div className="flex gap-2">
            <Input
              id="dc-bot-token"
              type="password"
              autoComplete="new-password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder={t("botTokenPlaceholder")}
              disabled={saving}
              className="flex-1"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleTest}
              disabled={testing || saving || !desktop}
              aria-label={t("testConnectionAria")}
            >
              {testing ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : t("testButtonLabel")}
            </Button>
          </div>

          {testResult !== null && (
            <div
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${
                testResult.ok
                  ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                  : "bg-destructive/10 text-destructive"
              }`}
              role="status"
              aria-label={
                testResult.ok ? t("connectionSucceededLabel") : t("connectionFailedLabel")
              }
            >
              {testResult.ok ? (
                <CheckCircle2Icon className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <XCircleIcon className="h-3.5 w-3.5 shrink-0" />
              )}
              {testResult.ok
                ? t("connectedAs", {
                    username: testResult.username ?? t("unknownUsername"),
                    id: testResult.id ?? t("unknownId"),
                  })
                : testResult.error}
            </div>
          )}

          {!desktop && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t("testRequiresDesktop")}</p>
          )}
        </div>
      </div>
    ),
  }

  const deliverySection: FormSection = {
    id: "delivery",
    label: t("sectionDelivery"),
    description: t("sectionDeliveryDesc"),
    defaultOpen: true,
    children: (
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t("transportInfoPrefix")} <span className="font-medium">{t("transportInfoValue")}</span>{" "}
          {t("transportInfoSuffix")}
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="dc-public-key" className="flex items-center gap-2">
            {t("publicKeyLabel")}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono uppercase text-muted-foreground">
              {t("publicKeyPhase2Badge")}
            </span>
          </Label>
          <p className="text-xs text-muted-foreground">{t("publicKeyHelp")}</p>
          <p
            className="text-[10px] text-amber-700 dark:text-amber-400"
            data-testid="dc-public-key-phase2-note"
          >
            {t("publicKeyPhase2Note")}
          </p>
          <Input
            id="dc-public-key"
            type="password"
            autoComplete="new-password"
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder={t("publicKeyPlaceholder")}
            disabled={saving}
          />
        </div>

        <div className="space-y-2 rounded border bg-card px-3 py-3">
          <Label className="text-xs font-medium">{t("interactionsUrlLabel")}</Label>
          {interactionsPath === null ? (
            <p className="text-xs text-muted-foreground">{t("interactionsUrlNewAdapterHint")}</p>
          ) : tunnel.loading ? (
            <p className="text-xs text-muted-foreground">{t("interactionsUrlTunnelLoading")}</p>
          ) : tunnel.running && interactionsUrl ? (
            <div className="space-y-2">
              <Input
                readOnly
                value={interactionsUrl}
                className="font-mono text-[11px]"
                aria-label={t("interactionsUrlLabel")}
                data-testid="discord-interactions-url-input"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => handleCopyInteractionsUrl(interactionsUrl)}
                  aria-label={t("interactionsUrlCopyAria")}
                >
                  {t("interactionsUrlCopy")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    typeof window !== "undefined" &&
                    window.open(
                      "https://discord.com/developers/applications",
                      "_blank",
                      "noopener,noreferrer"
                    )
                  }
                >
                  <ExternalLinkIcon className="mr-1 h-3.5 w-3.5" />
                  {t("openConsole")}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">{t("interactionsUrlHelp")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              <p
                className="text-xs text-amber-700 dark:text-amber-400"
                data-testid="discord-interactions-url-tunnel-off"
              >
                {t("interactionsUrlTunnelOffHelp")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (typeof window !== "undefined") {
                    window.location.assign("/settings/companion#tunnel")
                  }
                }}
              >
                {t("openCompanion")}
              </Button>
            </div>
          )}
        </div>
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
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-lg">
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
