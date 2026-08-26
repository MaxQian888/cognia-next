"use client"

/**
 * Matrix configuration dialog.
 *
 * Matrix needs a homeserver URL plus a long-lived access token. Operators can
 * paste an existing token (bot accounts created via the admin API) or use the
 * inline "Sign in with password" affordance, which calls
 * `matrixLoginWithPassword` and fills the token field. The token is stored in
 * the OS keyring under `accessToken`; the non-secret homeserver URL lives in
 * the `settings` blob.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CheckCircle2Icon, LoaderIcon, XCircleIcon } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultTriggerPolicyFor } from "@/types/connectors/policy"
import { useAdapterCredentials } from "@/hooks/connectors/use-adapter-credentials"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { CredentialInput } from "./_shared/credential-input"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"
import {
  matrixLoginWithPassword,
  probeMatrixAccessToken,
  type MatrixAccessTokenProbeResult,
} from "@/lib/connectors/adapters/matrix/auth"

interface MatrixConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new adapter id after a successful create, so the parent
   * can auto-select and open the freshly created adapter. */
  onCreated?: (id: string) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

// The access token is operator input — it can be pasted from Element as
// readily as it can be minted by the password login below — so it prefills.
// The refresh token never does: it is login output, it is as sensitive as the
// password that produced it, and a hand-edited one just breaks renewal.
const MATRIX_CREDENTIALS = ["accessToken"] as const
const MATRIX_DERIVED_CREDENTIALS = ["refreshToken"] as const

export function MatrixConfigDialog({
  open,
  onOpenChange,
  row,
  onCreated,
}: MatrixConfigDialogProps) {
  const t = useTranslations("settings.connections.matrix")
  const isNew = row === null
  const settings = (row?.settings ?? {}) as { homeserver?: string; deviceId?: string }

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [homeserver, setHomeserver] = useState(settings.homeserver ?? "")
  const credentials = useAdapterCredentials({
    adapterId: row?.id ?? null,
    accounts: MATRIX_CREDENTIALS,
    derivedAccounts: MATRIX_DERIVED_CREDENTIALS,
    enabled: open,
  })
  const accessToken = credentials.value("accessToken")
  const setAccessToken = (next: string) => credentials.set("accessToken", next)
  // Never rendered: a refresh token is as sensitive as a password, and the
  // panel has no reason to show one. It only ever travels login -> keyring.
  const [refreshToken, setRefreshToken] = useState("")
  const [deviceId, setDeviceId] = useState(settings.deviceId ?? "")
  const [loginUser, setLoginUser] = useState("")
  const [loginPassword, setLoginPassword] = useState("")
  const [testingToken, setTestingToken] = useState(false)
  const [tokenTestResult, setTokenTestResult] = useState<MatrixAccessTokenProbeResult | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [saving, setSaving] = useState(false)

  const desktop = isTauri()

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    homeserver.trim() !== (settings.homeserver ?? "") ||
    credentials.dirty ||
    muted !== (row?.muted ?? false) ||
    quietHours !== (row?.quietHours ?? null)

  const handlePasswordLogin = async () => {
    if (!homeserver.trim()) {
      toast.error(t("homeserverRequired"))
      return
    }
    if (!loginUser.trim() || !loginPassword) {
      toast.error(t("passwordLogin.credentialsRequired"))
      return
    }
    setLoggingIn(true)
    try {
      const {
        accessToken: token,
        userId,
        deviceId: loginDeviceId,
        refreshToken: loginRefreshToken,
      } = await matrixLoginWithPassword(homeserver.trim(), loginUser.trim(), loginPassword)
      setAccessToken(token)
      setDeviceId(loginDeviceId ?? "")
      // Kept so an expiring access token can be renewed without losing the
      // device — and with it every end-to-end encryption key it holds.
      setRefreshToken(loginRefreshToken ?? "")
      setLoginPassword("")
      toast.success(t("passwordLogin.success", { userId }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLoggingIn(false)
    }
  }

  const handleTestAccessToken = async () => {
    if (!homeserver.trim()) {
      toast.error(t("homeserverRequired"))
      return
    }
    if (!accessToken.trim()) {
      toast.error(t("accessTokenRequired"))
      return
    }

    setTestingToken(true)
    setTokenTestResult(null)
    try {
      const result = await probeMatrixAccessToken(homeserver.trim(), accessToken.trim())
      setTokenTestResult(result)
      if (result.ok) {
        // Only adopt the probed device_id when the homeserver actually returns
        // one — /whoami may omit the spec-optional `device_id` (e.g. appservice
        // tokens). Blanking it here would drop a deviceId already captured at
        // password login, so a fresh adapter would save with no device_id.
        if (result.deviceId) setDeviceId(result.deviceId)
        toast.success(t("testSucceededToast", { userId: result.userId }))
      } else {
        toast.error(t("testFailedToast", { error: result.error }))
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      setTokenTestResult({ ok: false, error })
      toast.error(t("testFailedToast", { error }))
    } finally {
      setTestingToken(false)
    }
  }

  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error(t("displayNameRequired"))
      return
    }
    if (!homeserver.trim()) {
      toast.error(t("homeserverRequired"))
      return
    }
    if (isNew && !accessToken.trim()) {
      toast.error(t("accessTokenRequired"))
      return
    }
    if (quietHours && (!quietHours.from || !quietHours.to || !quietHours.tz)) {
      toast.error(t("quietHoursIncomplete"))
      return
    }

    setSaving(true)
    try {
      const matrixSettings = {
        ...settings,
        homeserver: homeserver.trim(),
        ...(deviceId ? { deviceId } : {}),
      }
      let adapterId: string

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "matrix",
          displayName: displayName.trim(),
          enabled: true,
          transportMode: "longpoll",
          settings: matrixSettings,
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: refreshToken.trim() ? ["accessToken", "refreshToken"] : ["accessToken"],
          },
          trigger: defaultTriggerPolicyFor("matrix"),
          defaultMode: "auto",
          mediaModelPolicy: "local_extract_only",
          quietHours: quietHours ?? undefined,
          muted,
        })
        adapterId = newRow.id
      } else {
        adapterId = row.id
        await updateAdapterInstance(adapterId, {
          displayName: displayName.trim(),
          settings: matrixSettings,
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      await credentials.persist(adapterId)
      if (refreshToken.trim()) {
        await connectorsKeyringSet(adapterId, "refreshToken", refreshToken.trim())
      }

      if (!isNew) emitCredentialsRotated(adapterId)

      toast.success(isNew ? t("adapterCreated") : t("adapterUpdated"))
      if (isNew) onCreated?.(adapterId)
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
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
          <Label htmlFor="mx-display-name">{t("displayNameLabel")}</Label>
          <Input
            id="mx-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("displayNamePlaceholder")}
            disabled={saving}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mx-homeserver">
            {t("homeserverLabel")}
            <span className="ml-1 text-destructive">*</span>
          </Label>
          <p className="text-xs text-muted-foreground">{t("homeserverHelp")}</p>
          <Input
            id="mx-homeserver"
            value={homeserver}
            onChange={(e) => setHomeserver(e.target.value)}
            placeholder={t("homeserverPlaceholder")}
            disabled={saving}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mx-access-token">
            {t("accessTokenLabel")}
            {isNew && <span className="ml-1 text-destructive">*</span>}
          </Label>
          <p className="text-xs text-muted-foreground">{t("accessTokenHelp")}</p>
          <div className="flex gap-2">
            <CredentialInput
              id="mx-access-token"
              value={accessToken}
              onChange={setAccessToken}
              status={credentials.status("accessToken")}
              placeholder={t("accessTokenPlaceholder")}
              disabled={saving}
              className="min-w-0 flex-1"
              onRetry={credentials.retry}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handleTestAccessToken()}
              disabled={saving || testingToken || !desktop}
              aria-label={t("testAccessTokenAria")}
              className="shrink-0"
            >
              {testingToken ? (
                <LoaderIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                t("testButtonLabel")
              )}
            </Button>
          </div>
          {tokenTestResult !== null && (
            <div
              className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
                tokenTestResult.ok
                  ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                  : "bg-destructive/10 text-destructive"
              }`}
              role="status"
              aria-label={tokenTestResult.ok ? t("testSucceededLabel") : t("testFailedLabel")}
            >
              {tokenTestResult.ok ? (
                <CheckCircle2Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <XCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <span className="min-w-0 break-words">
                {tokenTestResult.ok
                  ? t("testSucceededStatus", { userId: tokenTestResult.userId })
                  : tokenTestResult.error}
              </span>
            </div>
          )}
          {!desktop && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t("testRequiresDesktop")}</p>
          )}
        </div>

        {/* Inline password-login affordance — fills the token field above. */}
        <div className="space-y-2 rounded-md border border-dashed p-3">
          <p className="text-xs font-medium">{t("passwordLogin.title")}</p>
          <p className="text-xs text-muted-foreground">{t("passwordLogin.help")}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input
              aria-label={t("passwordLogin.userLabel")}
              value={loginUser}
              onChange={(e) => setLoginUser(e.target.value)}
              placeholder={t("passwordLogin.userPlaceholder")}
              disabled={saving || loggingIn}
              className="h-9 text-sm"
            />
            <Input
              aria-label={t("passwordLogin.passwordLabel")}
              type="password"
              autoComplete="new-password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              placeholder={t("passwordLogin.passwordPlaceholder")}
              disabled={saving || loggingIn}
              className="h-9 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handlePasswordLogin()}
              disabled={saving || loggingIn || !desktop}
              data-testid="matrix-password-login"
            >
              {loggingIn && <LoaderIcon className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("passwordLogin.loginButton")}
            </Button>
            {!desktop && (
              <span className="text-[10px] text-amber-700 dark:text-amber-400">
                {t("passwordLogin.desktopOnly")}
              </span>
            )}
          </div>
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
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isNew ? t("titleNew") : t("titleEdit")}</DialogTitle>
        </DialogHeader>

        <div className="-mx-6 flex-1 overflow-y-auto px-6">
          <AdapterFormSections
            sections={[identitySection, advancedSection]}
            onSubmit={handleSave}
            onCancel={() => onOpenChange(false)}
            submitting={saving}
            // Until the stored credentials are read back the form does not know its
            // own baseline, so it cannot honestly call itself edited.
            dirty={dirty && !credentials.loading}
            submitLabel={isNew ? t("create") : t("save")}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
