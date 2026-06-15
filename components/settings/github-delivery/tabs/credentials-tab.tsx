"use client"

/**
 * Credentials sub-tab. Walks the user through adding a repo via App or PAT
 * authentication and persists the entry to the github-delivery:repos
 * namespaced Dexie table.
 *
 * Secrets live on the row itself for now (see GhRepoEntry — IndexedDB is
 * origin-isolated). A follow-up patch will mirror them to the OS keyring
 * on desktop and clear them from the row on first activation.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranchIcon, KeyIcon, Loader2Icon, ShieldCheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { getDb } from "@/lib/db/schema"
import type { GhRepoEntry } from "@/lib/github/types"
import type Dexie from "dexie"

type WizardMode = "idle" | "app" | "pat"

const NAMESPACED_REPOS_TABLE = "github-delivery:repos"

const REPO_FULL_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

function getReposTable(): Dexie.Table<GhRepoEntry, string> | null {
  try {
    const db = getDb() as unknown as Dexie
    return db.table<GhRepoEntry, string>(NAMESPACED_REPOS_TABLE)
  } catch {
    return null
  }
}

export function CredentialsTab() {
  const t = useTranslations("settings.githubDelivery")
  const [mode, setMode] = useState<WizardMode>("idle")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // PAT form state.
  const [patRepo, setPatRepo] = useState("")
  const [patToken, setPatToken] = useState("")

  // App form state.
  const [appRepo, setAppRepo] = useState("")
  const [appId, setAppId] = useState("")
  const [appInstallationId, setAppInstallationId] = useState("")
  const [appPrivateKey, setAppPrivateKey] = useState("")

  const resetMessages = () => {
    setError(null)
    setSuccess(null)
  }

  const handlePatSave = async () => {
    resetMessages()
    if (!REPO_FULL_NAME_RE.test(patRepo)) {
      setError(t("credentials.errRepoFormat"))
      return
    }
    if (!patToken.trim()) {
      setError(t("credentials.errPatEmpty"))
      return
    }
    const table = getReposTable()
    if (!table) {
      setError(t("common.pluginDisabled"))
      return
    }
    setBusy(true)
    try {
      const entry: GhRepoEntry = {
        fullName: patRepo.trim(),
        credentialMode: "pat",
        patToken: patToken.trim(),
        pushTarget: { kind: "source-branch", branchPrefix: "cognia/issue-" },
        worktreeMode: "local",
        triggerMode: "webhook",
        createdAt: Date.now(),
      }
      await table.put(entry)
      setSuccess(t("credentials.savedToast", { repo: patRepo.trim() }))
      setPatRepo("")
      setPatToken("")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleAppSave = async () => {
    resetMessages()
    if (!REPO_FULL_NAME_RE.test(appRepo)) {
      setError(t("credentials.errRepoFormat"))
      return
    }
    const appIdN = parseInt(appId, 10)
    const installN = parseInt(appInstallationId, 10)
    if (!appIdN || !installN) {
      setError(t("credentials.errIdsNumeric"))
      return
    }
    if (!appPrivateKey.trim()) {
      setError(t("credentials.errPkEmpty"))
      return
    }
    const table = getReposTable()
    if (!table) {
      setError(t("common.pluginDisabled"))
      return
    }
    setBusy(true)
    try {
      const entry: GhRepoEntry = {
        fullName: appRepo.trim(),
        credentialMode: "app",
        appId: appIdN,
        installationId: installN,
        appPrivateKey: appPrivateKey.trim(),
        pushTarget: { kind: "source-branch", branchPrefix: "cognia/issue-" },
        worktreeMode: "local",
        triggerMode: "webhook",
        createdAt: Date.now(),
      }
      await table.put(entry)
      setSuccess(t("credentials.savedToast", { repo: appRepo.trim() }))
      setAppRepo("")
      setAppId("")
      setAppInstallationId("")
      setAppPrivateKey("")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (mode === "app") {
    return (
      <Card className="p-4 space-y-3" data-testid="credentials-app-wizard">
        <h3 className="text-sm font-semibold">{t("credentials.appTitle")}</h3>
        <Alert>
          <ShieldCheckIcon className="h-4 w-4" />
          <AlertTitle>{t("credentials.appKeyAlertTitle")}</AlertTitle>
          <AlertDescription>{t("credentials.appKeyAlertDesc")}</AlertDescription>
        </Alert>
        <div className="space-y-2">
          <Label htmlFor="app-repo">{t("credentials.repoLabel")}</Label>
          <Input
            id="app-repo"
            data-testid="app-repo-input"
            placeholder="octocat/hello-world"
            value={appRepo}
            onChange={(e) => setAppRepo(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-2">
            <Label htmlFor="app-id">{t("credentials.appIdLabel")}</Label>
            <Input
              id="app-id"
              data-testid="app-id-input"
              placeholder="12345"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="app-install">{t("credentials.installLabel")}</Label>
            <Input
              id="app-install"
              data-testid="app-installation-input"
              placeholder="98765"
              value={appInstallationId}
              onChange={(e) => setAppInstallationId(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="app-pk">{t("credentials.pkLabel")}</Label>
          <Textarea
            id="app-pk"
            data-testid="app-pk-input"
            placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"
            rows={6}
            value={appPrivateKey}
            onChange={(e) => setAppPrivateKey(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && <p className="text-sm text-emerald-600">{success}</p>}
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setMode("idle")} disabled={busy}>
            {t("credentials.back")}
          </Button>
          <Button onClick={handleAppSave} disabled={busy} data-testid="app-save-button">
            {busy && <Loader2Icon className="h-4 w-4 animate-spin mr-1.5" />}
            {t("credentials.save")}
          </Button>
        </div>
      </Card>
    )
  }

  if (mode === "pat") {
    return (
      <Card className="p-4 space-y-3" data-testid="credentials-pat-wizard">
        <h3 className="text-sm font-semibold">{t("credentials.patTitle")}</h3>
        <Alert>
          <KeyIcon className="h-4 w-4" />
          <AlertTitle>{t("credentials.patAlertTitle")}</AlertTitle>
          <AlertDescription>{t("credentials.patAlertDesc")}</AlertDescription>
        </Alert>
        <div className="space-y-2">
          <Label htmlFor="pat-repo">{t("credentials.repoLabel")}</Label>
          <Input
            id="pat-repo"
            data-testid="pat-repo-input"
            placeholder="octocat/hello-world"
            value={patRepo}
            onChange={(e) => setPatRepo(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pat-token">{t("credentials.tokenLabel")}</Label>
          <Input
            id="pat-token"
            data-testid="pat-token-input"
            type="password"
            placeholder="ghp_…"
            value={patToken}
            onChange={(e) => setPatToken(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && <p className="text-sm text-emerald-600">{success}</p>}
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setMode("idle")} disabled={busy}>
            {t("credentials.back")}
          </Button>
          <Button onClick={handlePatSave} disabled={busy} data-testid="pat-save-button">
            {busy && <Loader2Icon className="h-4 w-4 animate-spin mr-1.5" />}
            {t("credentials.save")}
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-3" data-testid="credentials-picker">
      <Card className="p-4 cursor-pointer hover:bg-accent" onClick={() => setMode("app")}>
        <div className="flex items-center gap-3">
          <GitBranchIcon className="h-5 w-5" />
          <div className="flex-1">
            <p className="font-medium text-sm">{t("credentials.pickerAppTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("credentials.pickerAppDesc")}</p>
          </div>
          <Button size="sm">{t("credentials.pickerAppCta")}</Button>
        </div>
      </Card>
      <Card className="p-4 cursor-pointer hover:bg-accent" onClick={() => setMode("pat")}>
        <div className="flex items-center gap-3">
          <KeyIcon className="h-5 w-5" />
          <div className="flex-1">
            <p className="font-medium text-sm">{t("credentials.pickerPatTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("credentials.pickerPatDesc")}</p>
          </div>
          <Button size="sm" variant="outline">
            {t("credentials.pickerPatCta")}
          </Button>
        </div>
      </Card>
    </div>
  )
}
