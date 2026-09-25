"use client"

import { type FormEvent, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { CloudIcon, FlaskConicalIcon, Trash2Icon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RemoteProfileDeleteError, deleteRemoteBrowserProfile } from "@/lib/browser/remote-profiles"
import {
  createBrowserProfile,
  grantBrowserDomain,
  listBrowserDomainGrants,
  listBrowserProfiles,
  revokeBrowserDomain,
  selectBrowserProfile,
  type BrowserProfileRow,
} from "@/lib/db/browser-profiles"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { isTauri } from "@/lib/tauri"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

/** User-side half of the two-key remote-browser rollout gate. */
export function RemoteBrowserCard() {
  const t = useTranslations("mobile.companion.remoteBrowser")
  const enabled = useSettingsStore((state) => state.settings?.remoteBrowserEnabled ?? false)
  const save = useSettingsStore((state) => state.save)
  const workspaceId = useProjectStore((state) => state.activeProjectId)
  const reachable = !isTauri() ? hasWebCompanionTarget() : isRemoteHostActive()
  const profiles = useLiveQuery(
    () => (workspaceId ? listBrowserProfiles(workspaceId) : Promise.resolve([])),
    [workspaceId],
    []
  )
  const grants = useLiveQuery(
    () => (workspaceId ? listBrowserDomainGrants(workspaceId) : Promise.resolve([])),
    [workspaceId],
    []
  )
  const [profileName, setProfileName] = useState("")
  const [domain, setDomain] = useState("")
  const [error, setError] = useState<string | null>(null)
  /** The profile awaiting delete confirmation. */
  const [pendingDelete, setPendingDelete] = useState<BrowserProfileRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const ephemeralSelected = !profiles.some((profile) => profile.selected)

  const createProfile = async (event: FormEvent) => {
    event.preventDefault()
    if (!workspaceId || !profileName.trim()) return
    try {
      setError(null)
      const profile = await createBrowserProfile(workspaceId, profileName)
      await selectBrowserProfile(workspaceId, profile.id)
      setProfileName("")
    } catch {
      setError(t("operationFailed"))
    }
  }

  // Erase the runtime's copy first; a refusal leaves the profile listed, so the
  // user can close the session holding it (or reconnect) and try again.
  const confirmDelete = async () => {
    if (!workspaceId || !pendingDelete) return
    setDeleting(true)
    try {
      setError(null)
      await deleteRemoteBrowserProfile(workspaceId, pendingDelete.id)
      toast.success(t("profiles.deleted", { name: pendingDelete.name }))
      setPendingDelete(null)
    } catch (cause) {
      const reason = cause instanceof RemoteProfileDeleteError ? cause.reason : "failed"
      setError(
        reason === "in-use"
          ? t("profiles.deleteInUse")
          : reason === "unreachable"
            ? t("profiles.deleteUnreachable")
            : t("operationFailed")
      )
      setPendingDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  const addGrant = async (event: FormEvent) => {
    event.preventDefault()
    if (!workspaceId || !domain.trim()) return
    try {
      setError(null)
      await grantBrowserDomain(workspaceId, domain)
      setDomain("")
    } catch {
      setError(t("operationFailed"))
    }
  }

  return (
    <SettingsBlock
      icon={<CloudIcon />}
      title={t("title")}
      description={t("description")}
      badge={
        <Badge variant="outline" className="gap-1">
          <FlaskConicalIcon className="size-3" />
          {t("experimental")}
        </Badge>
      }
      testid="remote-browser-card"
      settingId="companion-remote-browser"
      contentClassName="space-y-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="remote-browser-enabled">{t("enable")}</Label>
          <p className="text-xs text-muted-foreground">{t("gateHint")}</p>
        </div>
        <Switch
          id="remote-browser-enabled"
          checked={enabled}
          onCheckedChange={(checked) => void save({ remoteBrowserEnabled: checked })}
          aria-label={t("toggle")}
          data-testid="remote-browser-toggle"
        />
      </div>
      {enabled && (
        <div className="space-y-5 border-t pt-4">
          {/* Profiles and domain grants apply to remote-chromium sessions.
                Letting someone configure them on a shell that cannot host one
                is the same dead end this card used to be on the desktop. */}
          {!reachable && (
            <p className="text-xs text-muted-foreground" data-testid="remote-browser-unreachable">
              {t("unreachableHint")}
            </p>
          )}
          {!workspaceId && <p className="text-xs text-muted-foreground">{t("workspaceHint")}</p>}
          <section className="space-y-2" aria-labelledby="remote-browser-profiles">
            <div>
              <h4 id="remote-browser-profiles" className="text-sm font-medium">
                {t("profiles.title")}
              </h4>
              <p className="text-xs text-muted-foreground">{t("profiles.description")}</p>
            </div>
            {/* One row per choice, stacked: the old inline buttons had a
                margin on every one but the first and wrapped raggedly. */}
            <div className="flex flex-col gap-1.5" data-testid="remote-browser-profiles">
              <Button
                size="sm"
                variant={ephemeralSelected ? "secondary" : "outline"}
                className="justify-start"
                aria-pressed={ephemeralSelected}
                onClick={() => workspaceId && void selectBrowserProfile(workspaceId, null)}
                disabled={!workspaceId}
              >
                {t("profiles.ephemeral")}
              </Button>
              {profiles.map((profile) => (
                <div key={profile.id} className="flex min-w-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant={profile.selected ? "secondary" : "outline"}
                    className="min-w-0 flex-1 justify-start"
                    aria-pressed={profile.selected === true}
                    onClick={() =>
                      workspaceId && void selectBrowserProfile(workspaceId, profile.id)
                    }
                  >
                    <span className="truncate">{profile.name}</span>
                  </Button>
                  {/* Its data lives on the server, so there is nothing to erase
                      until one is connected. */}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t("profiles.delete", { name: profile.name })}
                    title={reachable ? undefined : t("profiles.deleteUnreachable")}
                    disabled={!workspaceId || !reachable}
                    onClick={() => setPendingDelete(profile)}
                  >
                    <Trash2Icon aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
            <form className="flex gap-2" onSubmit={(event) => void createProfile(event)}>
              <Input
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                placeholder={t("profiles.placeholder")}
                aria-label={t("profiles.name")}
                disabled={!workspaceId}
              />
              <Button type="submit" size="sm" disabled={!workspaceId || !profileName.trim()}>
                {t("profiles.create")}
              </Button>
            </form>
          </section>
          <section className="space-y-2" aria-labelledby="remote-browser-domains">
            <div>
              <h4 id="remote-browser-domains" className="text-sm font-medium">
                {t("domains.title")}
              </h4>
              <p className="text-xs text-muted-foreground">{t("domains.description")}</p>
            </div>
            {grants.map((grant) => (
              <div
                key={grant.id}
                className="flex min-w-0 items-center justify-between gap-2 rounded border px-2 py-1"
              >
                <span className="min-w-0 truncate font-mono text-xs">{grant.domain}</span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("domains.revoke", { domain: grant.domain })}
                  onClick={() => workspaceId && void revokeBrowserDomain(workspaceId, grant.domain)}
                >
                  <XIcon className="size-3" />
                </Button>
              </div>
            ))}
            <form className="flex gap-2" onSubmit={(event) => void addGrant(event)}>
              <Input
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder={t("domains.placeholder")}
                aria-label={t("domains.domain")}
                disabled={!workspaceId}
              />
              <Button type="submit" size="sm" disabled={!workspaceId || !domain.trim()}>
                {t("domains.grant")}
              </Button>
            </form>
          </section>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {t("error", { message: error })}
            </p>
          )}
        </div>
      )}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("profiles.deleteTitle", { name: pendingDelete?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("profiles.deleteDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("profiles.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(event) => {
                // Keep the dialog up until the runtime has answered.
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {t("profiles.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsBlock>
  )
}
