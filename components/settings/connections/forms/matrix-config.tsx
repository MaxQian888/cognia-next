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
import { LoaderIcon } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultGroupChatPolicy } from "@/types/connectors/policy"
import { AdapterFormSections, type FormSection } from "./_shared/adapter-form-sections"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"
import { matrixLoginWithPassword } from "@/lib/connectors/adapters/matrix/auth"

interface MatrixConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

export function MatrixConfigDialog({ open, onOpenChange, row }: MatrixConfigDialogProps) {
  const t = useTranslations("settings.connections.matrix")
  const isNew = row === null
  const settings = (row?.settings ?? {}) as { homeserver?: string }

  const [displayName, setDisplayName] = useState(row?.displayName ?? t("displayNamePlaceholder"))
  const [homeserver, setHomeserver] = useState(settings.homeserver ?? "")
  const [accessToken, setAccessToken] = useState("")
  const [loginUser, setLoginUser] = useState("")
  const [loginPassword, setLoginPassword] = useState("")
  const [loggingIn, setLoggingIn] = useState(false)
  const [muted, setMuted] = useState<boolean>(row?.muted ?? false)
  const [quietHours, setQuietHours] = useState<QuietHoursValue | null>(row?.quietHours ?? null)
  const [saving, setSaving] = useState(false)

  const desktop = isTauri()

  const dirty =
    isNew ||
    displayName.trim() !== row?.displayName ||
    homeserver.trim() !== (settings.homeserver ?? "") ||
    accessToken.length > 0 ||
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
      const { accessToken: token, userId } = await matrixLoginWithPassword(
        homeserver.trim(),
        loginUser.trim(),
        loginPassword
      )
      setAccessToken(token)
      setLoginPassword("")
      toast.success(t("passwordLogin.success", { userId }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLoggingIn(false)
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
      const matrixSettings = { homeserver: homeserver.trim() }
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
            accounts: ["accessToken"],
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
          settings: matrixSettings,
          muted,
          quietHours: quietHours ?? undefined,
        })
      }

      if (accessToken.trim()) {
        await connectorsKeyringSet(adapterId, "accessToken", accessToken.trim())
      }

      if (!isNew) emitCredentialsRotated(adapterId)

      toast.success(isNew ? t("adapterCreated") : t("adapterUpdated"))
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
          <Input
            id="mx-access-token"
            type="password"
            autoComplete="new-password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder={isNew ? t("accessTokenPlaceholder") : t("credentialUnchangedPlaceholder")}
            disabled={saving}
          />
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
            dirty={dirty}
            submitLabel={isNew ? t("create") : t("save")}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
