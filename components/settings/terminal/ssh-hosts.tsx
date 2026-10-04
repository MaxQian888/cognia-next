"use client"

/**
 * Settings → Terminal → SSH hosts: the one editor for saved SSH profiles.
 *
 * Every host used to be drawn as its full form, all open at once, at the bottom
 * of the Terminal card. It is now a list of one-line summaries (who, where,
 * through what, and whether Connect would work) with the form opening under
 * the host being edited. Links from elsewhere (`?sshHost=<id>`) open and scroll
 * to that host, and `?sshHost=new` starts a new one, so "fix this in Settings"
 * lands on the thing to fix.
 *
 * Connecting goes through `useSshConnect`, shared with the dock, the device
 * console and the phone, so all four refuse and explain the same way. What only
 * this surface does is take a secret: a typed password or passphrase is written
 * to the OS keyring under the profile's id before the connection is attempted.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  ChevronRightIcon,
  CopyIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  PlusIcon,
  RadioIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"
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
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSshProbe } from "@/hooks/devices/use-ssh-probe"
import { useSshConnect } from "@/hooks/terminal/use-ssh-connect"
import { sshHostRef } from "@/lib/devices/build-device-rows"
import { deviceConsoleHref } from "@/lib/devices/device-console-href"
import { forgetSshProbe } from "@/lib/devices/ssh-probe-store"
import { isTauri } from "@/lib/tauri"
import { syncTerminalHostProfiles } from "@/lib/terminal/host-profiles"
import { clearSshCredential, saveSshCredential } from "@/lib/terminal/ssh-credentials"
import {
  nextSshHostId,
  validateSshHostProfile,
  type SshAuthMethod,
  type SshHostProfile,
} from "@/lib/terminal/ssh-profiles"
import { NEW_SSH_HOST_LINK, SSH_HOST_PARAM } from "@/lib/terminal/terminal-settings-link"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"

import { SshConfigImportDialog } from "./ssh-config-import-dialog"
import { SshForwardingEditor } from "./ssh-forwarding-editor"
import { sshAddress, SshHostSummary, sshHostIssue } from "./ssh-host-summary"
import { SshTrustedHostKeys } from "./ssh-trusted-host-keys"

type TerminalSettings = NonNullable<
  NonNullable<ReturnType<typeof useSettingsStore.getState>["settings"]>["terminal"]
>

/** Below this many hosts a filter is one more field to read, not a help. */
const FILTER_THRESHOLD = 6

export function SshHosts() {
  const t = useTranslations("settings.terminal.ssh")
  const router = useRouter()
  const searchParams = useSearchParams()
  const settings = useSettingsStore((state) => state.settings)
  const save = useSettingsStore((state) => state.save)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const terminal = useMemo<TerminalSettings>(() => settings?.terminal ?? {}, [settings?.terminal])
  const hosts = useMemo(() => (terminal.sshHosts ?? []) as SshHostProfile[], [terminal.sshHosts])
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [query, setQuery] = useState("")
  const [pendingRemoval, setPendingRemoval] = useState<SshHostProfile | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const sshConnect = useSshConnect()
  const hostSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The keyring lives on the desktop; nowhere else can a secret be written. */
  const canStoreSecrets = isTauri()

  useEffect(
    () => () => {
      if (hostSyncTimer.current) clearTimeout(hostSyncTimer.current)
    },
    []
  )

  const persistHosts = useCallback(
    async (next: SshHostProfile[]): Promise<void> => {
      const nextTerminal = { ...terminal, sshHosts: next }
      await save({ terminal: nextTerminal })
      if (!isTauri()) return
      if (hostSyncTimer.current) clearTimeout(hostSyncTimer.current)
      hostSyncTimer.current = setTimeout(() => {
        hostSyncTimer.current = null
        void syncTerminalHostProfiles(nextTerminal.profiles, {
          enableShellIntegration: nextTerminal.enableShellIntegration,
          forceUtf8: nextTerminal.forceUtf8,
          sandboxed: nextTerminal.sandboxed,
          sshProfiles: next,
        }).catch((error) =>
          toast.error(t("toasts.syncFailed"), {
            description: error instanceof Error ? error.message : String(error),
          })
        )
      }, 200)
    },
    [save, t, terminal]
  )

  function updateHost(id: string, patch: Partial<SshHostProfile>): void {
    void persistHosts(hosts.map((host) => (host.id === id ? { ...host, ...patch } : host)))
  }

  const setOpen = useCallback((id: string, open: boolean) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  /** Bring a host into view once its row has rendered. */
  const reveal = useCallback((id: string) => {
    window.requestAnimationFrame(() => {
      document
        // A JSON string is a valid quoted CSS attribute value for the ids this
        // list mints (`ssh-N`, or whatever an import kept), and unlike
        // `CSS.escape` it exists in every WebView the app ships in.
        .querySelector<HTMLElement>(`[data-ssh-host-id=${JSON.stringify(id)}]`)
        ?.scrollIntoView?.({ behavior: "smooth", block: "nearest" })
    })
  }, [])

  const blankHost = useCallback(
    (id: string): SshHostProfile => ({
      id,
      name: t("newName"),
      host: "",
      port: 22,
      username: "",
      authMethod: "password",
    }),
    [t]
  )

  const addHost = useCallback((): string => {
    const id = nextSshHostId(hosts)
    void persistHosts([...hosts, blankHost(id)])
    // A new host is a form to fill in, so it opens rather than appearing as a
    // collapsed line with a warning on it.
    setOpen(id, true)
    setQuery("")
    reveal(id)
    return id
  }, [blankHost, hosts, persistHosts, reveal, setOpen])

  /**
   * `?sshHost=` opens a host; `?sshHost=new` starts one. Applied once per link,
   * then dropped from the URL: left there, a reload would open the host again
   * and `new` would add a second blank host.
   *
   * What the link changes on screen (which row is open, the filter) is derived
   * during render, the same way the device console latches `?addHost=`. Only
   * the writes to things outside this component (the new host in settings,
   * the URL, the scroll position) happen in effects.
   */
  const linkedHost = settings ? searchParams.get(SSH_HOST_PARAM) : null
  const [appliedLink, setAppliedLink] = useState<string | null>(null)
  const [linkedNewHostId, setLinkedNewHostId] = useState<string | null>(null)
  if (linkedHost !== appliedLink) {
    setAppliedLink(linkedHost)
    if (linkedHost === NEW_SSH_HOST_LINK) {
      const id = nextSshHostId(hosts)
      setLinkedNewHostId(id)
      setExpanded((current) => new Set(current).add(id))
      setQuery("")
    } else if (linkedHost && hosts.some((host) => host.id === linkedHost)) {
      setExpanded((current) => new Set(current).add(linkedHost))
      setQuery("")
    }
  }

  const persistedLinkedHost = useRef<string | null>(null)
  useEffect(() => {
    if (!linkedNewHostId || persistedLinkedHost.current === linkedNewHostId) return
    persistedLinkedHost.current = linkedNewHostId
    void persistHosts([...hosts, blankHost(linkedNewHostId)])
  }, [blankHost, hosts, linkedNewHostId, persistHosts])

  useEffect(() => {
    if (!linkedHost) return
    reveal(linkedHost === NEW_SSH_HOST_LINK ? (linkedNewHostId ?? "") : linkedHost)
    const next = new URLSearchParams(searchParams.toString())
    next.delete(SSH_HOST_PARAM)
    router.replace(`?${next.toString()}`, { scroll: false })
  }, [linkedHost, linkedNewHostId, reveal, router, searchParams])

  function duplicateHost(profile: SshHostProfile): void {
    const id = nextSshHostId(hosts)
    const copy: SshHostProfile = {
      ...profile,
      id,
      name: t("copyName", { name: profile.name.trim() || sshAddress(profile) }),
      // The keyring entry is keyed by the original's id and is not copied: a
      // second profile silently sharing one password is how a rotation on one
      // breaks the other.
      credentialRef: undefined,
      localForwards: profile.localForwards?.map((rule) => ({ ...rule })),
      // A remote forward opens a port on someone else's machine. A copy starts
      // with every one of them off, like a newly added rule (ADR-0082 §9).
      remoteForwards: profile.remoteForwards?.map((rule) => ({ ...rule, enabled: false })),
    }
    void persistHosts([...hosts, copy])
    setOpen(id, true)
    reveal(id)
  }

  async function removeHost(profile: SshHostProfile): Promise<void> {
    setRemovingId(profile.id)
    try {
      if (profile.credentialRef) await clearSshCredential(profile.credentialRef)
      await persistHosts(hosts.filter((host) => host.id !== profile.id))
      // `nextSshHostId` reuses `ssh-N`, so without this the next host added
      // inherits the removed one's cached reachability answer in `/devices`
      // for the probe TTL.
      forgetSshProbe(profile.id)
      setSecrets((current) => {
        const next = { ...current }
        delete next[profile.id]
        return next
      })
      setOpen(profile.id, false)
    } catch (error) {
      toast.error(t("toasts.removeFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRemovingId(null)
      setPendingRemoval(null)
    }
  }

  /**
   * Switching method drops the stored secret with the reference to it. A
   * password left in the keyring after a host moved to an agent is a secret
   * nothing will ever read, and nothing would ever delete either.
   */
  async function changeAuthMethod(profile: SshHostProfile, method: SshAuthMethod): Promise<void> {
    // Drop the typed-but-unsaved secret alongside the reference it would have
    // been stored under; a passphrase left over from key auth means nothing to
    // a password or agent login.
    setSecrets((current) => ({ ...current, [profile.id]: "" }))
    updateHost(profile.id, { authMethod: method, credentialRef: undefined })
    if (profile.credentialRef && canStoreSecrets) {
      await clearSshCredential(profile.credentialRef).catch((error) =>
        toast.error(t("toasts.credentialClearFailed"), {
          description: error instanceof Error ? error.message : String(error),
        })
      )
    }
  }

  async function forgetCredential(profile: SshHostProfile): Promise<void> {
    if (!profile.credentialRef) return
    try {
      await clearSshCredential(profile.credentialRef)
      updateHost(profile.id, { credentialRef: undefined })
      toast.success(t("toasts.credentialCleared"))
    } catch (error) {
      toast.error(t("toasts.credentialClearFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function connect(profile: SshHostProfile): Promise<void> {
    let effective = profile
    let profiles = hosts
    const secret = secrets[profile.id]
    // Agent auth never writes a keyring entry: the agent holds the key. A
    // secret can still linger in state from before the method was switched,
    // so gate on the method rather than on the field being empty.
    if (secret && profile.authMethod !== "agent" && canStoreSecrets) {
      try {
        await saveSshCredential(
          profile.id,
          profile.authMethod === "password" ? { password: secret } : { passphrase: secret }
        )
      } catch (error) {
        toast.error(t("toasts.credentialSaveFailed"), {
          description: error instanceof Error ? error.message : String(error),
        })
        return
      }
      effective = { ...profile, credentialRef: profile.id }
      profiles = hosts.map((host) => (host.id === profile.id ? effective : host))
      await persistHosts(profiles)
      setSecrets((current) => ({ ...current, [profile.id]: "" }))
    }
    // The just-saved credential and any just-typed field are in `profiles`
    // before the settings write has been read back, so the connection uses
    // them rather than the previous copy.
    await sshConnect.connect({
      hostId: effective.id,
      profiles,
      projectId: activeProjectId ?? undefined,
    })
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return hosts
    return hosts.filter((host) =>
      [host.name, host.host, host.username, sshAddress(host)].some((value) =>
        value.toLowerCase().includes(needle)
      )
    )
  }, [hosts, query])

  /** Hosts that reach the one being removed through it. */
  const dependents = pendingRemoval
    ? hosts.filter((host) => host.jumpHostId === pendingRemoval.id)
    : []

  return (
    <section className="space-y-3" data-testid="ssh-hosts">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-prose text-[11px] text-muted-foreground">{t("helper")}</p>
        <div className="flex items-center gap-2">
          <SshConfigImportDialog
            hosts={hosts}
            onImport={async (result) => {
              await persistHosts(result.profiles)
              // A jump host the user declined to import means the profile
              // connects direct — to a different machine than their config
              // described — so it is said out loud rather than left to be
              // noticed later.
              if (result.droppedJumps.length > 0) {
                toast.warning(
                  t("toasts.importJumpsDropped", { names: result.droppedJumps.join(", ") })
                )
              }
              toast.success(
                t("toasts.imported", { created: result.created, replaced: result.replaced })
              )
            }}
          />
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            onClick={addHost}
            data-testid="ssh-hosts-add"
          >
            <PlusIcon className="mr-1 h-3.5 w-3.5" />
            {t("add")}
          </Button>
        </div>
      </div>

      {/*
        `persistHosts` returns early off the desktop: settings are written, the
        Host is never told. That is correct (an SSH profile names a destination
        and a credential, and installing one from a paired device would let it
        drive outbound connections from the Host, ADR-0082), but the editor said
        nothing about it. Everything here stayed editable and none of it took
        effect, which is the worst of the three possible answers.
      */}
      {isTauri() ? null : (
        <p
          className="text-[11px] text-amber-600 dark:text-amber-500"
          data-testid="ssh-hosts-not-synced"
        >
          {t("notSynced")}
        </p>
      )}

      {hosts.length >= FILTER_THRESHOLD ? (
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("filterPlaceholder")}
            aria-label={t("filterPlaceholder")}
            className="h-8 pl-7 text-xs"
            data-testid="ssh-hosts-filter"
          />
        </div>
      ) : null}

      {hosts.length === 0 ? (
        <Empty className="border border-dashed py-8" data-testid="ssh-hosts-empty">
          <EmptyHeader>
            <EmptyTitle className="text-sm">{t("empty")}</EmptyTitle>
            <EmptyDescription className="text-xs">{t("emptyHint")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" size="sm" className="h-7 text-xs" onClick={addHost}>
              <PlusIcon className="mr-1 h-3.5 w-3.5" />
              {t("add")}
            </Button>
          </EmptyContent>
        </Empty>
      ) : filtered.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="ssh-hosts-no-match">
          {t("noMatch", { query: query.trim() })}
        </p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="ssh-hosts-list">
          {filtered.map((profile) => (
            <SshHostRow
              key={profile.id}
              profile={profile}
              hosts={hosts}
              open={expanded.has(profile.id)}
              onOpenChange={(open) => setOpen(profile.id, open)}
              secret={secrets[profile.id] ?? ""}
              onSecretChange={(value) =>
                setSecrets((current) => ({ ...current, [profile.id]: value }))
              }
              canStoreSecrets={canStoreSecrets}
              connecting={sshConnect.pendingHostId === profile.id}
              removing={removingId === profile.id}
              onUpdate={(patch) => updateHost(profile.id, patch)}
              onAuthMethodChange={(method) => void changeAuthMethod(profile, method)}
              onForgetCredential={() => void forgetCredential(profile)}
              onConnect={() => void connect(profile)}
              onDuplicate={() => duplicateHost(profile)}
              onRemove={() => setPendingRemoval(profile)}
            />
          ))}
        </ul>
      )}

      <SshTrustedHostKeys profiles={hosts} />

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && removingId === null) setPendingRemoval(null)
        }}
      >
        <AlertDialogContent data-testid="ssh-host-remove-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("removeConfirm.title", { name: pendingRemoval?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemoval?.credentialRef
                ? t("removeConfirm.bodyWithCredential")
                : t("removeConfirm.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/*
            A host other profiles jump through. Their `jumpHostId` is left
            pointing at nothing on purpose: a broken chain refuses to connect
            and says so, while clearing it would quietly dial those targets
            direct, which is the one failure ADR-0082 §9 designs out.
          */}
          {dependents.length > 0 ? (
            <p
              className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
              data-testid="ssh-host-remove-dependents"
            >
              {t("removeConfirm.dependents", {
                names: dependents.map((host) => host.name.trim() || sshAddress(host)).join(", "),
              })}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removingId !== null}>
              {t("removeConfirm.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Held open until the keyring and settings writes finish, so a
                // failure is reported against the dialog that asked for it.
                event.preventDefault()
                if (pendingRemoval) void removeHost(pendingRemoval)
              }}
              disabled={removingId !== null}
              data-testid="ssh-host-remove-confirm"
            >
              {t("removeConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {sshConnect.dialog}
    </section>
  )
}

interface SshHostRowProps {
  profile: SshHostProfile
  hosts: readonly SshHostProfile[]
  open: boolean
  onOpenChange: (open: boolean) => void
  secret: string
  onSecretChange: (value: string) => void
  canStoreSecrets: boolean
  connecting: boolean
  removing: boolean
  onUpdate: (patch: Partial<SshHostProfile>) => void
  onAuthMethodChange: (method: SshAuthMethod) => void
  onForgetCredential: () => void
  onConnect: () => void
  onDuplicate: () => void
  onRemove: () => void
}

function SshHostRow({
  profile,
  hosts,
  open,
  onOpenChange,
  secret,
  onSecretChange,
  canStoreSecrets,
  connecting,
  removing,
  onUpdate,
  onAuthMethodChange,
  onForgetCredential,
  onConnect,
  onDuplicate,
  onRemove,
}: SshHostRowProps) {
  const t = useTranslations("settings.terminal.ssh")
  const busy = connecting || removing
  const invalidField = validateSshHostProfile(profile)
  const fieldId = `ssh-host-${profile.id}`
  /**
   * Test connection, from the editor, where the host is being set up.
   *
   * It lived only on the device console, which meant a new host's first check
   * was a real session opened from somewhere else. Desktop-only for the reason
   * the console gives: it dials from this machine through `ssh_terminal_spawn`.
   */
  const { state: probeState, probe } = useSshProbe(profile, hosts)

  return (
    <li data-ssh-host-id={profile.id} data-testid={`ssh-host-${profile.id}`}>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex items-center gap-2 px-2.5 py-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={
                open ? t("collapse", { name: profile.name }) : t("expand", { name: profile.name })
              }
              data-testid={`ssh-host-toggle-${profile.id}`}
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-90"
                )}
                aria-hidden
              />
              <SshHostSummary profile={profile} allProfiles={hosts} />
            </button>
          </CollapsibleTrigger>
          <Button
            type="button"
            size="sm"
            // A host Connect would refuse still offers it (the refusal says
            // what to fix and links there), but not as the loudest control.
            variant={sshHostIssue(profile, hosts) ? "outline" : "default"}
            className="h-7 shrink-0 text-xs"
            disabled={busy}
            onClick={onConnect}
            data-testid={`ssh-host-connect-${profile.id}`}
          >
            <KeyRoundIcon className="mr-1 h-3.5 w-3.5" />
            {connecting ? t("connecting") : t("connect")}
          </Button>
        </div>

        <CollapsibleContent className="space-y-2 border-t bg-muted/20 px-2.5 py-2.5">
          {/*
            Labelled, not placeholder-only: once a field holds a value its
            placeholder is gone, and "10.0.4.21" next to "deploy" does not say
            which box is the host and which the user.
          */}
          <div className="grid grid-cols-2 gap-2">
            <SshField id={`${fieldId}-name`} label={t("fields.name")}>
              <Input
                id={`${fieldId}-name`}
                value={profile.name}
                onChange={(event) => onUpdate({ name: event.target.value })}
                aria-invalid={invalidField === "name" || undefined}
                className="h-8 text-xs"
              />
            </SshField>
            <SshField id={`${fieldId}-host`} label={t("fields.host")}>
              <Input
                id={`${fieldId}-host`}
                value={profile.host}
                onChange={(event) => onUpdate({ host: event.target.value })}
                aria-invalid={invalidField === "host" || undefined}
                placeholder={t("fields.hostPlaceholder")}
                className="h-8 font-mono text-xs"
              />
            </SshField>
          </div>
          <div className="grid grid-cols-[1fr_96px] gap-2">
            <SshField id={`${fieldId}-username`} label={t("fields.username")}>
              <Input
                id={`${fieldId}-username`}
                value={profile.username}
                onChange={(event) => onUpdate({ username: event.target.value })}
                aria-invalid={invalidField === "username" || undefined}
                className="h-8 font-mono text-xs"
              />
            </SshField>
            <SshField id={`${fieldId}-port`} label={t("fields.port")}>
              <Input
                id={`${fieldId}-port`}
                type="number"
                min={1}
                max={65_535}
                value={profile.port}
                onChange={(event) => onUpdate({ port: Number(event.target.value) })}
                aria-invalid={invalidField === "port" || undefined}
                className="h-8 text-xs"
              />
            </SshField>
          </div>
          <div className="grid grid-cols-[minmax(0,180px)_1fr] items-end gap-2">
            <div className="space-y-1">
              <span className="text-[11px] text-muted-foreground">{t("fields.authMethod")}</span>
              <Select
                value={profile.authMethod}
                onValueChange={(value) => onAuthMethodChange(value as SshAuthMethod)}
              >
                <SelectTrigger className="h-8 text-xs" aria-label={t("fields.authMethod")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="password">{t("auth.password")}</SelectItem>
                  <SelectItem value="privateKey">{t("auth.privateKey")}</SelectItem>
                  <SelectItem value="agent">{t("auth.agent")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {profile.authMethod === "privateKey" ? (
              <SshField id={`${fieldId}-key`} label={t("fields.privateKeyPath")}>
                <Input
                  id={`${fieldId}-key`}
                  value={profile.privateKeyPath ?? ""}
                  onChange={(event) => onUpdate({ privateKeyPath: event.target.value })}
                  aria-invalid={invalidField === "privateKeyPath" || undefined}
                  placeholder={t("fields.privateKeyPathPlaceholder")}
                  className="h-8 font-mono text-xs"
                />
              </SshField>
            ) : null}
          </div>
          {profile.authMethod === "agent" ? (
            <p
              className="text-[11px] text-muted-foreground"
              data-testid={`ssh-host-agent-notice-${profile.id}`}
            >
              {t("fields.agentNotice")}
            </p>
          ) : (
            <div className="space-y-1">
              <Label
                htmlFor={`${fieldId}-secret`}
                className="text-[11px] font-normal text-muted-foreground"
              >
                {profile.authMethod === "password" ? t("fields.password") : t("fields.passphrase")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`${fieldId}-secret`}
                  type="password"
                  value={secret}
                  onChange={(event) => onSecretChange(event.target.value)}
                  // The keyring is the desktop's. Off it, a typed secret had
                  // nowhere to go and `saveSshCredential` threw on Connect.
                  disabled={!canStoreSecrets}
                  placeholder={
                    profile.credentialRef
                      ? t("fields.credentialSaved")
                      : profile.authMethod === "password"
                        ? t("fields.password")
                        : t("fields.passphraseOptional")
                  }
                  className="h-8 text-xs"
                  data-testid={`ssh-host-secret-${profile.id}`}
                />
                {profile.credentialRef && canStoreSecrets ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 shrink-0 text-xs"
                    onClick={onForgetCredential}
                    data-testid={`ssh-host-forget-credential-${profile.id}`}
                  >
                    {t("forgetCredential")}
                  </Button>
                ) : null}
              </div>
              {canStoreSecrets ? (
                profile.authMethod === "password" && !profile.credentialRef ? (
                  <p className="text-[11px] text-muted-foreground">
                    {t("fields.secretSavedOnConnect")}
                  </p>
                ) : null
              ) : (
                <p
                  className="text-[11px] text-muted-foreground"
                  data-testid={`ssh-host-secret-desktop-only-${profile.id}`}
                >
                  {t("fields.secretDesktopOnly")}
                </p>
              )}
            </div>
          )}
          <SshForwardingEditor profile={profile} allProfiles={hosts} onChange={onUpdate} />

          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={probe}
              disabled={!canStoreSecrets || busy || probeState.status === "probing"}
              title={canStoreSecrets ? t("probe.cost") : t("probe.desktopOnly")}
              data-testid={`ssh-host-probe-${profile.id}`}
            >
              <RadioIcon className="mr-1 h-3.5 w-3.5" />
              {probeState.status === "probing" ? t("probe.running") : t("probe.action")}
            </Button>
            <Button
              asChild
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              data-testid={`ssh-host-files-${profile.id}`}
            >
              <Link href={deviceConsoleHref(sshHostRef(profile), "files")}>
                <FolderOpenIcon className="mr-1 h-3.5 w-3.5" />
                {t("browseFiles")}
              </Link>
            </Button>
            <span className="flex-1" />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={busy}
              onClick={onDuplicate}
              data-testid={`ssh-host-duplicate-${profile.id}`}
            >
              <CopyIcon className="mr-1 h-3.5 w-3.5" />
              {t("duplicate")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-destructive hover:text-destructive"
              disabled={busy}
              onClick={onRemove}
              data-testid={`ssh-host-remove-${profile.id}`}
            >
              <Trash2Icon className="mr-1 h-3.5 w-3.5" />
              {t("remove")}
            </Button>
          </div>
          {probeState.status === "settled" ? (
            <p
              role="status"
              className={cn(
                "text-[11px]",
                probeState.outcome.kind === "reachable"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-destructive"
              )}
              data-testid={`ssh-host-probe-result-${profile.id}`}
            >
              {probeState.outcome.kind === "reachable"
                ? t(
                    probeState.outcome.hostKeyStatus === "learned"
                      ? "probe.reachableLearned"
                      : "probe.reachableVerified",
                    { fingerprint: probeState.outcome.hostKeyFingerprint }
                  )
                : probeState.outcome.kind === "unreachable"
                  ? t("probe.unreachable", { message: probeState.outcome.message })
                  : t(`probe.invalid.${probeState.outcome.reason}`)}
            </p>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/** One labelled field of the host form. */
function SshField({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-[11px] font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}

export default SshHosts
