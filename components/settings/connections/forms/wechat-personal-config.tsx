"use client"

/**
 * Personal WeChat (iLink) configuration dialog — a QR-login wizard.
 *
 * iLink has no static credentials: the operator scans a QR code with their
 * phone, and on confirm the gateway returns a `bot_token` + `baseurl` we
 * persist (token → keyring `botToken`, baseurl → `settings`). The dialog
 * uses the official Tencent iLink QR login and explains session renewal.
 */

import { useEffect, useRef, useState } from "react"
import Image from "next/image"
import { QRCodeSVG } from "qrcode.react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { loggers } from "@cognia/logging"
import { LoaderIcon } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultTriggerPolicyFor } from "@/types/connectors/policy"
import { ILINK_DEFAULT_BASE_URL } from "@/lib/connectors/adapters/wechat-personal/protocol"
import {
  requestLoginQr,
  pollLoginStatus,
  resolveIlinkQrRedirect,
} from "@/lib/connectors/adapters/wechat-personal/auth"
import { useAdapterCredentials } from "@/hooks/connectors/use-adapter-credentials"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"
import {
  ConnectorHostNotice,
  useConnectorControlReach,
} from "@/components/connectors/connector-host-notice"

interface WeChatPersonalConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

type LoginStatus =
  | "idle"
  | "loading"
  | "waiting"
  | "scaned"
  | "confirmed"
  | "expired"
  | "error"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect"

const POLL_INTERVAL_MS = 2500

// The bot token is never typed — it only ever comes out of a QR login — so
// there is no field to prefill. What the panel does need is whether one is
// stored, which is the honest answer to "is this bot signed in".
const WECHAT_PERSONAL_DERIVED_CREDENTIALS = ["botToken"] as const

export function WeChatPersonalConfigDialog({
  open,
  onOpenChange,
  row,
  onCreated,
}: WeChatPersonalConfigDialogProps) {
  const t = useTranslations("settings.connections.wechatPersonal")
  const isNew = row === null
  // QR login paints a login window from the desktop process; a reachable
  // runtime elsewhere cannot show it to you.
  const reach = useConnectorControlReach("desktop-shell")
  const desktop = reach.available

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [saving, setSaving] = useState(false)

  const [qrcode, setQrcode] = useState<string | null>(null)
  const [qrImg, setQrImg] = useState<string | null>(null)
  const [loginStatus, setLoginStatus] = useState<LoginStatus>("idle")
  const [pollBaseUrl, setPollBaseUrl] = useState(ILINK_DEFAULT_BASE_URL)
  const [verifyCode, setVerifyCode] = useState("")
  const [pendingVerifyCode, setPendingVerifyCode] = useState<string | undefined>()
  const [verifyRetry, setVerifyRetry] = useState(false)
  const loginGeneration = useRef(0)
  useEffect(() => {
    if (!open) return
    return () => {
      loginGeneration.current += 1
      setQrcode(null)
      setQrImg(null)
      setLoginStatus("idle")
      setVerifyCode("")
      setPendingVerifyCode(undefined)
    }
  }, [open])
  const credentials = useAdapterCredentials({
    adapterId: row?.id ?? null,
    accounts: [],
    derivedAccounts: WECHAT_PERSONAL_DERIVED_CREDENTIALS,
    enabled: open,
  })
  const [justSignedIn, setJustSignedIn] = useState(false)
  // `!isNew` was the old stand-in and is still the fallback: a host that
  // cannot probe the keyring knows no better than that the row exists.
  const loggedIn = justSignedIn || (credentials.derivedPresence("botToken") ?? !isNew)
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
    setSaving(true)
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
          trigger: defaultTriggerPolicyFor("wechat-personal"),
          defaultMode: "auto",
          mediaModelPolicy: "local_extract_only",
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
      setJustSignedIn(true)
      toast.success(isNew ? t("adapterCreated") : t("adapterUpdated"))
      if (isNew) onCreated?.(adapterId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setLoginStatus("error")
    } finally {
      persistingRef.current = false
      setSaving(false)
    }
  }

  const handleGetQr = async () => {
    if (!desktop) {
      toast.error(t("desktopOnly"))
      return
    }
    const generation = ++loginGeneration.current
    setLoginStatus("loading")
    setQrcode(null)
    setQrImg(null)
    setVerifyCode("")
    setPendingVerifyCode(undefined)
    setVerifyRetry(false)
    setPollBaseUrl(ILINK_DEFAULT_BASE_URL)
    try {
      const qr = await requestLoginQr()
      if (generation !== loginGeneration.current) return
      if (!qr.qrcode || !qr.qrcode_img_content) {
        setLoginStatus("error")
        toast.error(t("qrFailed"))
        return
      }
      setQrcode(qr.qrcode)
      setQrImg(qr.qrcode_img_content)
      setLoginStatus("waiting")
    } catch (err) {
      if (generation !== loginGeneration.current) return
      setLoginStatus("error")
      loggers.app.warn("WeChat QR request failed", { error: err })
      toast.error(t("qrFailed"))
    }
  }

  // Keep the latest persist closure in a ref so the polling effect can call
  // it without re-subscribing on every keystroke (and without missing-dep
  // lint noise).
  const persistRef = useRef(persistOnConfirm)
  useEffect(() => {
    persistRef.current = persistOnConfirm
  })

  // Schedule the next poll only after the previous long-poll has settled.
  useEffect(() => {
    if (!open || !qrcode || (loginStatus !== "waiting" && loginStatus !== "scaned")) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const generation = loginGeneration.current
    const active = () => !cancelled && generation === loginGeneration.current
    const poll = async () => {
      let continuePolling = true
      let failureMessage = t("pollFailed")
      try {
        const res = await pollLoginStatus(qrcode, undefined, pollBaseUrl, pendingVerifyCode)
        if (!active()) return
        switch (res.status) {
          case "wait":
            break
          case "scaned":
            setPendingVerifyCode(undefined)
            setLoginStatus("scaned")
            break
          case "need_verifycode":
            setVerifyRetry(Boolean(pendingVerifyCode))
            setPendingVerifyCode(undefined)
            setVerifyCode("")
            setLoginStatus("need_verifycode")
            continuePolling = false
            break
          case "verify_code_blocked":
          case "binded_redirect":
          case "expired":
            setPendingVerifyCode(undefined)
            setLoginStatus(res.status)
            continuePolling = false
            break
          case "scaned_but_redirect":
            failureMessage = t("redirectFailed")
            if (!res.redirect_host) throw new Error(t("redirectFailed"))
            setPollBaseUrl(resolveIlinkQrRedirect(res.redirect_host))
            setLoginStatus("scaned")
            break
          case "confirmed":
            continuePolling = false
            failureMessage = t("confirmedNoToken")
            if (!res.bot_token) throw new Error(failureMessage)
            setLoginStatus("confirmed")
            await persistRef.current(res.bot_token, res.baseurl, res.account_id)
            break
          default:
            failureMessage = t("unknownLoginStatus")
            throw new Error(failureMessage)
        }
      } catch (error) {
        if (!active()) return
        continuePolling = false
        setLoginStatus("error")
        loggers.app.warn("WeChat QR status failed", { error })
        toast.error(failureMessage)
      }
      if (active() && continuePolling) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    }
    timer = setTimeout(() => void poll(), pendingVerifyCode ? 0 : POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [open, qrcode, loginStatus, pollBaseUrl, pendingVerifyCode, t])

  const handleVerify = () => {
    const code = verifyCode.trim()
    if (!/^\d+$/.test(code)) {
      toast.error(t("verifyCodeRequired"))
      return
    }
    setPendingVerifyCode(code)
    setLoginStatus("waiting")
  }

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
    loading: t("statusLoading"),
    need_verifycode: t("statusVerifyCode"),
    verify_code_blocked: t("statusVerifyBlocked"),
    binded_redirect: t("statusAlreadyBound"),
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

        <div className="rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
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
            disabled={!desktop || saving || loginStatus === "loading"}
          >
            {loggedIn ? t("reLogin") : t("getQrButton")}
          </Button>

          {!desktop ? <ConnectorHostNotice reach={reach} /> : null}

          {qrImg ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t("qrInstructions")}</p>
              {/^https?:\/\//i.test(qrImg) ? (
                <QRCodeSVG
                  value={qrImg}
                  size={176}
                  level="M"
                  marginSize={4}
                  aria-label={t("qrAlt")}
                  className="rounded border bg-white"
                  data-testid="wechat-personal-qr"
                />
              ) : (
                <Image
                  src={qrImg.startsWith("data:image/") ? qrImg : `data:image/png;base64,${qrImg}`}
                  alt={t("qrAlt")}
                  width={176}
                  height={176}
                  unoptimized
                  className="rounded border bg-white p-2"
                  data-testid="wechat-personal-qr"
                />
              )}
            </div>
          ) : null}

          {loginStatus === "need_verifycode" && (
            <div className="w-full space-y-2">
              <Label htmlFor="wx-verify-code">{t("verifyCodeLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {verifyRetry ? t("verifyCodeRetry") : t("verifyCodeHint")}
              </p>
              <Input
                id="wx-verify-code"
                value={verifyCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                onChange={(event) => setVerifyCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    handleVerify()
                  }
                }}
              />
              <Button type="button" size="sm" onClick={handleVerify}>
                {t("verifyCodeSubmit")}
              </Button>
            </div>
          )}

          {loginStatus !== "idle" && (
            <span
              className="flex items-center gap-1.5 text-xs"
              data-testid="wechat-personal-login-status"
            >
              {(loginStatus === "loading" ||
                loginStatus === "waiting" ||
                loginStatus === "scaned") && <LoaderIcon className="h-3.5 w-3.5 animate-spin" />}
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
