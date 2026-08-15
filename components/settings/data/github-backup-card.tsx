"use client"

/**
 * GitHub backup destination card (Settings → Data). Configures the private
 * repository the encrypted snapshots are committed to, the credential source
 * (a stored GitHub auth session or a keyring PAT), verifies the repository is
 * private, and offers a manual "Sync now" that runs the same pipeline the
 * scheduled `backup` executor uses (`lib/data/destinations/sync-now.ts`).
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranchIcon, ShieldCheckIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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
  DEFAULT_GITHUB_BACKUP_PATH,
  backupDestinationSecrets,
  GITHUB_TOKEN_KEY,
  clearGithubBackupToken,
  getBackupDestinationsSettings,
  parseRepoFullName,
  setGithubBackupToken,
  updateBackupDestinationsSettings,
} from "@/lib/data/destinations/config"
import { verifyGithubBackupDestination } from "@/lib/data/destinations/github"
import {
  runRemoteBackupSyncNow,
  type RemoteBackupSyncPhase,
} from "@/lib/data/destinations/sync-now"
import { hasSyncPassphrase, loadPersistedSyncPassphrase } from "@/lib/webdav/passphrase-cache"

export interface GithubAuthSessionOption {
  providerId: "github-pat" | "github-app"
  sessionId: string
  label: string
}

export interface GithubBackupCardProps {
  /** Test seam: auth sessions to offer instead of reading the provider registry. */
  authSessionsForTesting?: GithubAuthSessionOption[]
}

async function loadAuthSessions(): Promise<GithubAuthSessionOption[]> {
  try {
    const { getProvider } = await import("@/lib/plugin/auth/auth-provider-registry")
    const out: GithubAuthSessionOption[] = []
    for (const providerId of ["github-pat", "github-app"] as const) {
      const provider = getProvider(providerId)
      if (!provider) continue
      const sessions = await provider.getSessions(undefined, { silent: true })
      for (const session of sessions) {
        out.push({
          providerId,
          sessionId: session.id,
          label: `${session.account.label} (${providerId})`,
        })
      }
    }
    return out
  } catch {
    return []
  }
}

export function GithubBackupCard({ authSessionsForTesting }: GithubBackupCardProps = {}) {
  const t = useTranslations("settings.data.githubBackup")
  const [enabled, setEnabled] = useState(false)
  const [repo, setRepo] = useState("")
  const [branch, setBranch] = useState("")
  const [path, setPath] = useState(DEFAULT_GITHUB_BACKUP_PATH)
  const [credentialMode, setCredentialMode] = useState<"keyring" | string>("keyring")
  const [sessions, setSessions] = useState<GithubAuthSessionOption[]>([])
  const [token, setToken] = useState("")
  const [tokenSaved, setTokenSaved] = useState(false)
  const [visibility, setVisibility] = useState<"private" | "public" | "unknown">("unknown")
  const [lastSyncAt, setLastSyncAt] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<RemoteBackupSyncPhase | null>(null)
  const [unlocked, setUnlocked] = useState(false)

  useEffect(() => {
    void (async () => {
      const settings = await getBackupDestinationsSettings()
      const cfg = settings.github
      setEnabled(cfg?.enabled ?? false)
      setRepo(cfg?.repo ?? "")
      setBranch(cfg?.branch ?? "")
      setPath(cfg?.path ?? DEFAULT_GITHUB_BACKUP_PATH)
      setCredentialMode(
        cfg?.credential?.kind === "auth-session"
          ? `${cfg.credential.providerId}:${cfg.credential.sessionId}`
          : "keyring"
      )
      setVisibility(cfg?.lastVerifiedVisibility ?? "unknown")
      setLastSyncAt(cfg?.lastSyncAt)
      setSessions(authSessionsForTesting ?? (await loadAuthSessions()))
      setTokenSaved(Boolean(await backupDestinationSecrets().load(GITHUB_TOKEN_KEY)))
      await loadPersistedSyncPassphrase()
      setUnlocked(hasSyncPassphrase())
    })()
  }, [authSessionsForTesting])

  const credentialFromMode = () => {
    if (credentialMode === "keyring") return { kind: "keyring" as const }
    const [providerId, sessionId] = credentialMode.split(":") as [
      "github-pat" | "github-app",
      string,
    ]
    return { kind: "auth-session" as const, providerId, sessionId }
  }

  const onSave = async () => {
    if (!parseRepoFullName(repo)) {
      toast.error(t("repoInvalid"))
      return
    }
    setSaving(true)
    try {
      if (token.trim()) {
        await setGithubBackupToken(token)
        setToken("")
        setTokenSaved(true)
      }
      await updateBackupDestinationsSettings((current) => ({
        ...current,
        github: {
          ...(current.github ?? { enabled: false, repo: "" }),
          enabled,
          repo: repo.trim(),
          branch: branch.trim() || undefined,
          path: path.trim() || DEFAULT_GITHUB_BACKUP_PATH,
          credential: credentialFromMode(),
        },
      }))
      toast.success(t("saved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const onVerify = async () => {
    setBusy(true)
    try {
      const result = await verifyGithubBackupDestination()
      if (result.ok) {
        setVisibility("private")
        toast.success(t("verified", { branch: result.defaultBranch }))
      } else {
        setVisibility(result.code === "public-repo" ? "public" : "unknown")
        toast.error(t("verifyFailed"), { description: result.error })
      }
    } finally {
      setBusy(false)
    }
  }

  const onSyncNow = async () => {
    if (!unlocked) {
      toast.error(t("passphraseRequired"))
      return
    }
    setBusy(true)
    try {
      const result = await runRemoteBackupSyncNow("github", "", { onProgress: setPhase })
      if (result.ok) {
        setLastSyncAt(new Date().toISOString())
        toast.success(t("syncDone"))
      } else {
        toast.error(t("syncFailed"), { description: result.error })
      }
    } finally {
      setBusy(false)
      setPhase(null)
    }
  }

  const onClearToken = async () => {
    await clearGithubBackupToken()
    setTokenSaved(false)
    toast.success(t("tokenCleared"))
  }

  return (
    <Card className="space-y-4 p-4" data-testid="github-backup-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GitBranchIcon className="h-4 w-4" aria-hidden="true" />
          <Label className="text-sm">{t("title")}</Label>
          {visibility === "private" && (
            <Badge
              variant="outline"
              className="text-[10px]"
              data-testid="github-backup-private-badge"
            >
              <ShieldCheckIcon className="mr-1 h-3 w-3" aria-hidden="true" />
              {t("privateVerified")}
            </Badge>
          )}
          {visibility === "public" && (
            <Badge
              variant="destructive"
              className="text-[10px]"
              data-testid="github-backup-public-badge"
            >
              {t("publicRefused")}
            </Badge>
          )}
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("enableLabel")}
          data-testid="github-backup-enabled"
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("description")}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">{t("repoLabel")}</Label>
          <Input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/repository"
            className="h-9 font-mono text-xs"
            data-testid="github-backup-repo"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("branchLabel")}</Label>
          <Input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder={t("branchPlaceholder")}
            className="h-9 font-mono text-xs"
            data-testid="github-backup-branch"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("pathLabel")}</Label>
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={DEFAULT_GITHUB_BACKUP_PATH}
            className="h-9 font-mono text-xs"
            data-testid="github-backup-path"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("credentialLabel")}</Label>
          <Select value={credentialMode} onValueChange={setCredentialMode}>
            <SelectTrigger
              className="h-9"
              data-testid="github-backup-credential"
              aria-label={t("credentialLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="keyring">{t("credentialKeyring")}</SelectItem>
              {sessions.map((session) => (
                <SelectItem
                  key={`${session.providerId}:${session.sessionId}`}
                  value={`${session.providerId}:${session.sessionId}`}
                >
                  {session.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {credentialMode === "keyring" && (
        <div className="space-y-1">
          <Label className="text-xs">{t("tokenLabel")}</Label>
          <div className="flex gap-2">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={tokenSaved ? t("tokenSaved") : "ghp_…"}
              className="h-9 font-mono text-xs"
              data-testid="github-backup-token"
            />
            {tokenSaved && (
              <Button
                variant="outline"
                size="sm"
                onClick={onClearToken}
                data-testid="github-backup-clear-token"
              >
                {t("clearToken")}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t("tokenHelp")}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={saving} data-testid="github-backup-save">
          {t("save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onVerify}
          disabled={busy}
          data-testid="github-backup-verify"
        >
          {t("verify")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onSyncNow}
          disabled={busy || !enabled}
          data-testid="github-backup-sync"
        >
          {phase ? t(`phase.${phase}`) : t("syncNow")}
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="github-backup-last-sync">
          {lastSyncAt
            ? t("lastSync", { time: new Date(lastSyncAt).toLocaleString() })
            : t("neverSynced")}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t("guardrails")}</p>
    </Card>
  )
}
