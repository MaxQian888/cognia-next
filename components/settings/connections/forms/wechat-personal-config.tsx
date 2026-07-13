"use client"

/**
 * Personal WeChat (iLink) configuration dialog — a QR-login wizard.
 *
 * iLink has no static credentials: the operator scans a QR code with their
 * phone, and on confirm the gateway returns a `bot_token` + `baseurl` we
 * persist (token → keyring `botToken`, baseurl → `settings`). The dialog
 * surfaces the ban-risk + reply-only nature of this unofficial channel.
 */

import { useEffect, useRef, useState } from "react"
import Image from "next/image"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { LoaderIcon } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultGroupChatPolicy } from "@/types/connectors/policy"
import { requestLoginQr, pollLoginStatus } from "@/lib/connectors/adapters/wechat-personal/auth"
import { isTauri } from "@/lib/tauri"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

interface WeChatPersonalConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

type LoginStatus = "idle" | "waiting" | "scaned" | "confirmed" | "expired" | "error"

const POLL_INTERVAL_MS = 2500

export function WeChatPersonalConfigDialog({
  open,
  onOpenChange,
  row,
  onCreated,
}: WeChatPersonalConfigDialogProps) {
  const t = useTranslations("settings.connections.wechatPersonal")
  const isNew = row === null
  const desktop = isTauri()

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [saving, setSaving] = useState(false)

  const [qrcode, setQrcode] = useState<string | null>(null)
  const [qrImg, setQrImg] = useState<string | null>(null)
  const [loginStatus, setLoginStatus] = useState<LoginStatus>("idle")
  const [loggedIn, setLoggedIn] = useState<boolean>(!isNew)
  const persistingRef = useRef(false)

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null) ||
    loginStatus === "confirmed"

  const persistOnConfirm = async (botToken: string, baseUrl?: string, accountId?: string) => {
    if (persistingRef.current) return
    persistingRef.current = true
    try {
      // On re-login, merge into the existing row's settings —
      // `updateAdapterInstance` replaces the whole `settings` object, so a
      // bare `{ baseUrl, accountId }` would wipe any other persisted keys.
      const settings = {
        ...(isNew ? {} : row.settings),
        ...(baseUrl ? { baseUrl } : {}),
        ...(accountId ? { accountId } : {}),
      }
      let adapterId: string
      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "wechat-personal",
          displayName: displayName.trim() || t("displayNamePlaceholder"),
          enabled: true,
          transportMode: "longpoll",
          settings,
          credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
          trigger: defaultGroupChatPolicy(),
          defaultMode: "auto",
          quietHours: quietHours ?? undefined,
          muted,
        })
        adapterId = newRow.id
      } else {
        adapterId = row.id
        await updateAdapterInstance(adapterId, {
          settings,
          muted,
          quietHours: quietHours ?? undefined,
        })
      }
      await connectorsKeyringSet(adapterId, "botToken", botToken)
      if (!isNew) emitCredentialsRotated(adapterId)
      setLoggedIn(true)
      toast.success(isNew ? t("adapterCreated") : t("adapterUpdated"))
      if (isNew) onCreated?.(adapterId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setLoginStatus("error")
    } finally {
      persistingRef.current = false
    }
  }

  const handleGetQr = async () => {
    if (!desktop) {
      toast.error(t("desktopOnly"))
      return
    }
    setLoginStatus("idle")
    setQrImg(null)
    try {
      const qr = await requestLoginQr()
      if (!qr.qrcode) {
        setLoginStatus("error")
        toast.error(t("qrFailed"))
        return
      }
      setQrcode(qr.qrcode)
      setQrImg(qr.qrcode_img_content ?? null)
      setLoginStatus("waiting")
    } catch (err) {
      setLoginStatus("error")
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  // Keep the latest persist closure in a ref so the polling effect can call
  // it without re-subscribing on every keystroke (and without missing-dep
  // lint noise).
  const persistRef = useRef(persistOnConfirm)
  useEffect(() => {
    persistRef.current = persistOnConfirm
  })

  // Poll the scan status while a QR code is outstanding. State updates land in
  // the tick callback (not the effect body), complying with
  // react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!qrcode || (loginStatus !== "waiting" && loginStatus !== "scaned")) return
    let cancelled = false
    const timer = setInterval(() => {
      void pollLoginStatus(qrcode).then((res) => {
        if (cancelled) return
        if (res.status === "scaned") setLoginStatus("scaned")
        else if (res.status === "confirmed") {
          if (res.bot_token) {
            setLoginStatus("confirmed")
            void persistRef.current(res.bot_token, res.baseurl, res.account_id)
          } else {
            // The gateway confirmed the scan but returned no bot_token —
            // nothing can be persisted, and a silent "confirmed" would let
            // handleSave close the dialog without creating anything.
            setLoginStatus("error")
            toast.error(t("confirmedNoToken"))
          }
        } else if (res.status === "expired") setLoginStatus("expired")
      })
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [qrcode, loginStatus, t])

  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error(t("displayNameRequired"))
      return
    }
    if (isNew && loginStatus !== "confirmed") {
      toast.error(t("loginRequired"))
      return
    }
    if (quietHours && (!quietHours.from || !quietHours.to || !quietHours.tz)) {
      toast.error(t("quietHoursIncomplete"))
      return
    }
    // On a fresh login the adapter row was already created in persistOnConfirm.
    setSaving(true)
    try {
      if (!isNew) {
        await updateAdapterInstance(row.id, {
          displayName: displayName.trim(),
          muted,
          quietHours: quietHours ?? undefined,
        })
        emitCredentialsRotated(row.id)
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const statusLabel: Record<LoginStatus, string> = {
    idle: "",
    waiting: t("statusWaiting"),
    scaned: t("statusScaned"),
    confirmed: t("statusConfirmed"),
    expired: t("statusExpired"),
    error: t("statusError"),
  }

  const loginSection: FormSection = {
    id: "login",
    label: t("sectionLogin"),
    description: t("sectionLoginDesc"),
    defaultOpen: true,
    children: (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="wx-display-name">{t("displayNameLabel")}</Label>
          <Input
            id="wx-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("displayNamePlaceholder")}
            disabled={saving}
          />
        </div>

        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {t("banRiskNote")}
        </div>

        {loggedIn && loginStatus !== "confirmed" ? (
          <p className="text-xs text-muted-foreground">{t("loggedInHint")}</p>
        ) : null}

        <div className="flex flex-col items-start gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleGetQr()}
            disabled={!desktop || saving}
          >
            {loggedIn ? t("reLogin") : t("getQrButton")}
          </Button>

          {!desktop ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t("desktopOnly")}</p>
          ) : null}

          {qrImg ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t("qrInstructions")}</p>
              <Image
                src={`data:image/png;base64,${qrImg}`}
                alt={t("qrAlt")}
                width={176}
                height={176}
                unoptimized
                className="rounded border bg-white p-2"
                data-testid="wechat-personal-qr"
              />
            </div>
          ) : null}

          {loginStatus !== "idle" && (
            <span
              className="flex items-center gap-1.5 text-xs"
              data-testid="wechat-personal-login-status"
            >
              {(loginStatus === "waiting" || loginStatus === "scaned") && (
                <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
              )}
              {statusLabel[loginStatus]}
            </span>
          )}
        </div>

        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t("replyOnlyNote")}
        </p>
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
            sections={[loginSection, advancedSection]}
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
