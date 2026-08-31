"use client"

/**
 * A saved SSH host, as the fleet console can honestly present it.
 *
 * The repo has a complete russh client (TOFU `known_hosts`, jump chains,
 * bidirectional port forwarding, `~/.ssh/config` import) and it lived in one
 * form under Settings → Terminal. It was the one class of remote machine no
 * machine directory listed, which is backwards: Tailscale, Termius and VS
 * Code's Remote Explorer all put SSH targets in the same list as everything
 * else.
 *
 * What that directory owes the reader is the same thing it owes for every
 * other machine: where it is, how it authenticates, what it goes through, and
 * what it will open. Those four facts were all already in `SshHostProfile` and
 * none of them were on screen, so the pane could show a Connect button for a
 * bastion-backed host and never mention the bastion.
 *
 * One thing this deliberately does not do: **it does not edit.** Ports, keys,
 * jump chains and forwarding rules stay in the Settings editor. A fleet view
 * that grew a second, smaller form for the same profile would be two places to
 * change a port.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import {
  ArrowRightIcon,
  KeyRoundIcon,
  PlugZapIcon,
  RadioIcon,
  SettingsIcon,
  TerminalIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useSshProbe, type SshProbeState } from "@/hooks/devices/use-ssh-probe"
import { useSshHostKeyChange } from "@/hooks/terminal/use-ssh-host-key-change"
import type { DeviceRow } from "@/lib/devices/types"
import { connectSshFromDock, resolveSshHostLaunch } from "@/lib/terminal/ssh-connect"
import {
  formatLocalForward,
  formatRemoteForward,
  resolveJumpChain,
} from "@/lib/terminal/ssh-forwarding"
import { selectSavedSshHosts } from "@/lib/terminal/saved-ssh-hosts"
import { SSH_PROFILE_NOT_ON_HOST } from "@/lib/terminal/ssh-connect"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import { terminalHostReachable } from "@/lib/terminal/host-settings"
import { isTauri } from "@/lib/platform/detect"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { DeviceFactList, DeviceFactRow, shortenFingerprint } from "./device-visuals"

/** Default geometry for a session opened from a console row rather than a pane. */
const DEFAULT_ROWS = 24
const DEFAULT_COLS = 80

export interface SshHostControlsProps {
  row: DeviceRow
  /** Test seam. Defaults to the real dock launcher. */
  connect?: typeof connectSshFromDock
}

export function SshHostControls({ row, connect = connectSshFromDock }: SshHostControlsProps) {
  const t = useTranslations("devices.ssh")
  const savedHosts = useSettingsStore(selectSavedSshHosts)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const profileId = row.ref.startsWith("ssh:") ? row.ref.slice(4) : null
  // Memoised so `onConnect`'s identity is stable: a jump host is stored as a
  // profile id, so the whole set has to travel with the one being launched or
  // a bastion-backed host connects direct.
  const hosts = useMemo(() => savedHosts ?? [], [savedHosts])
  const launch = useMemo(
    () => (profileId ? resolveSshHostLaunch(profileId, hosts) : { kind: "unknownHost" as const }),
    [profileId, hosts]
  )
  /**
   * Whether this shell is the desktop, which decides HOW a connection is made
   * rather than whether one can be.
   *
   * On the desktop the request is built here and handed to `ssh_terminal_spawn`
   * with the local keyring behind it. Anywhere else the host makes the
   * connection from a profile id, so what matters is whether a host can answer
   * at all.
   */
  const local = isTauri()
  const hostReachable = terminalHostReachable()

  /**
   * Resolved from the saved set, not from `launch`.
   *
   * `resolveSshHostLaunch` answers "can this be launched by id alone", and it
   * says `credentialRequired` without handing back the profile. Deriving the
   * facts from it would blank the whole card for a password host with nothing
   * in the keyring, which is exactly the host a reader most needs described:
   * they are about to go and fix it. Only `unknownHost` has no profile at all.
   */
  const profile = useMemo(
    () => (profileId ? (hosts.find((host) => host.id === profileId) ?? null) : null),
    [hosts, profileId]
  )

  /**
   * The resolved chain, or `null` when it cannot be walked.
   *
   * `null` does not mean "direct". It means a missing profile, a cycle, or a
   * chain past `MAX_JUMP_DEPTH`, all of which `buildForwardedConnectRequest`
   * refuses. A direct host is a chain of length one, holding only itself.
   */
  const chain = useMemo(() => (profile ? resolveJumpChain(profile, hosts) : null), [profile, hosts])
  const chainBroken = Boolean(profile?.jumpHostId) && chain === null

  const { state: probeState, probe } = useSshProbe(profile, hosts)
  /**
   * A changed host key was the one failure this card could not resolve. It
   * arrived as the raw `ssh_host_key_changed:{…}` string in the error line,
   * with the only remedy in a Settings screen nothing pointed at.
   */
  const hostKeyGuard = useSshHostKeyChange()

  const forwards = useMemo(() => {
    if (!profile) return []
    return [
      ...(profile.localForwards ?? []).map((forward) => ({
        id: `local:${forward.id}`,
        text: formatLocalForward(forward),
        enabled: forward.enabled,
      })),
      ...(profile.remoteForwards ?? []).map((forward) => ({
        id: `remote:${forward.id}`,
        text: formatRemoteForward(forward),
        enabled: forward.enabled,
      })),
    ]
  }, [profile])

  const onConnect = useCallback(async () => {
    if (launch.kind !== "ready") return
    setError(null)
    setBusy(true)
    try {
      const outcome = await connect({
        profile: launch.profile,
        allProfiles: hosts,
        rows: DEFAULT_ROWS,
        cols: DEFAULT_COLS,
        // Read at call time, like the dock does: subscribing the whole store
        // here would re-render this card on every keystroke in any terminal.
        store: useTerminalStore.getState(),
      })
      if (outcome.kind === "error") {
        // Adjudicated rather than printed. The raw payload is JSON and tells
        // the user nothing they can act on.
        if (!hostKeyGuard.capture(outcome.message)) setError(outcome.message)
      }
    } finally {
      setBusy(false)
    }
  }, [connect, hostKeyGuard, hosts, launch])

  if (row.kind !== "ssh-host") return null

  return (
    <div className="space-y-3" data-testid="ssh-host-controls">
      {/*
        Who will actually dial this host, stated once because it governs every
        control below and because the answer is not the machine the reader is
        looking at. Off the desktop the connection is made by the paired host
        out of its own keyring, which is also why a profile it never registered
        cannot be opened from here.
      */}
      {!local && hostReachable ? (
        <Alert data-testid="ssh-via-host">
          <AlertTitle>{t("viaHostTitle")}</AlertTitle>
          <AlertDescription>{t("viaHostBody")}</AlertDescription>
        </Alert>
      ) : null}

      {!hostReachable ? (
        <Alert data-testid="ssh-no-host">
          <AlertTitle>{t("noHostTitle")}</AlertTitle>
          <AlertDescription>{t("noHostBody")}</AlertDescription>
        </Alert>
      ) : null}

      {launch.kind === "credentialRequired" ? (
        <Alert data-testid="ssh-credential-required">
          <AlertTitle>{t("credentialRequiredTitle")}</AlertTitle>
          <AlertDescription>{t("credentialRequiredBody", { name: launch.name })}</AlertDescription>
        </Alert>
      ) : null}

      {/*
        The third reason Connect can be dead, and the one that hid a real bug:
        the row exists but no saved profile carries its id. While every read of
        the SSH list resolved to `undefined`, this was the state of every row on
        screen, and nothing said so. A disabled button with no sentence next to
        it is indistinguishable from a working host you simply cannot click.
      */}
      {launch.kind === "unknownHost" ? (
        <Alert variant="destructive" data-testid="ssh-unknown-host">
          <AlertTitle>{t("unknownHostTitle")}</AlertTitle>
          <AlertDescription>{t("unknownHostBody", { ref: row.ref })}</AlertDescription>
        </Alert>
      ) : null}

      {/*
        A broken chain is its own failure, not a direct connection. Saying so
        here matters more than anywhere else in this card, because the
        alternative reading is that the bastion is fine and something else is
        wrong, which sends the user looking in the wrong place.
      */}
      {chainBroken ? (
        <Alert variant="destructive" data-testid="ssh-chain-broken">
          <AlertTitle>{t("chainBrokenTitle")}</AlertTitle>
          <AlertDescription>{t("chainBrokenBody")}</AlertDescription>
        </Alert>
      ) : null}

      {/*
        No address row below. The Overview card beside this one already renders
        `row.baseUrl`, which is the same `user@host:port` in URL form, and the
        route ends on the target anyway. Two cards holding one fact is how they
        end up disagreeing.
      */}
      {profile ? (
        <DeviceFactList>
          <DeviceFactRow label={t("facts.auth")}>
            <SshAuthFact profile={profile} />
          </DeviceFactRow>
          <DeviceFactRow label={t("facts.route")}>
            <SshRouteFact chain={chain} broken={chainBroken} />
          </DeviceFactRow>
          {/*
            Only ever from a connection this app made. There is no way to learn
            a fingerprint without one, so an untested host shows nothing here
            rather than a placeholder that reads as a missing value.
          */}
          {probeState.status === "settled" && probeState.outcome.kind === "reachable" ? (
            <DeviceFactRow label={t("facts.hostKey")} mono>
              {shortenFingerprint(probeState.outcome.hostKeyFingerprint) ??
                probeState.outcome.hostKeyFingerprint}
            </DeviceFactRow>
          ) : null}
        </DeviceFactList>
      ) : null}

      {profile ? (
        <div className="space-y-1.5" data-testid="ssh-forwards">
          <p className="text-[11px] leading-tight text-muted-foreground">{t("facts.forwards")}</p>
          {forwards.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("forwardsNone")}</p>
          ) : (
            <ul className="space-y-1">
              {forwards.map((forward) => (
                <li key={forward.id} className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] break-all">{forward.text}</span>
                  {/*
                    A rule that exists and a rule that runs are different
                    facts. `enabled` is read as a plain boolean on the Rust
                    side and fails closed, so a disabled rule opens nothing and
                    must not be drawn as though it did.
                  */}
                  <Badge variant="outline" className="font-normal">
                    {forward.enabled ? t("forwardEnabled") : t("forwardDisabled")}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {/*
            Both ends bind loopback and that is a constant rather than a
            setting, so it is stated once instead of repeated per rule.
          */}
          <p className="text-[11px] text-muted-foreground">{t("forwardsLoopback")}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => void onConnect()}
          disabled={!hostReachable || launch.kind !== "ready" || chainBroken || busy}
          data-testid="ssh-connect"
        >
          {launch.kind === "credentialRequired" ? (
            <KeyRoundIcon className="size-3.5" />
          ) : (
            <PlugZapIcon className="size-3.5" />
          )}
          {busy ? t("connecting") : t("connect")}
        </Button>
        {/*
          A real connection, so it is never automatic and it is never implied
          by opening the page. What it costs is stated below rather than
          discovered in an auth log.
        */}
        <Button
          size="sm"
          variant="outline"
          onClick={probe}
          /*
            Still desktop-only, and for a real reason rather than an inherited
            one: the probe opens its own connection from this machine through
            `ssh_terminal_spawn`. There is no host-mediated equivalent, because
            a connect-then-kill by profile id would open and close a session in
            the host's own tab list.
          */
          disabled={!local || !profile || chainBroken || probeState.status === "probing"}
          data-testid="ssh-probe"
        >
          <RadioIcon className="size-3.5" />
          {probeState.status === "probing" ? t("probe.running") : t("probe.action")}
        </Button>
        <Button asChild size="sm" variant="ghost" data-testid="ssh-edit">
          <Link href="/settings?section=terminal">
            <SettingsIcon className="size-3.5" />
            {t("edit")}
          </Link>
        </Button>
      </div>

      <SshProbeResult state={probeState} />

      {hostKeyGuard.dialog}

      {error ? (
        <p role="alert" className="text-xs text-destructive" data-testid="ssh-connect-error">
          {error.startsWith(`${SSH_PROFILE_NOT_ON_HOST}:`)
            ? t("notOnHost", { name: error.slice(SSH_PROFILE_NOT_ON_HOST.length + 1) })
            : error}
        </p>
      ) : null}

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <TerminalIcon className="size-3" aria-hidden />
        {t("shellOnly")}
      </p>
    </div>
  )
}

/**
 * What the last Test connection found, and what running one costs.
 *
 * The cost line is not decoration. A probe authenticates, so it lands in the
 * target's and every bastion's auth log, it can raise an ssh-agent passphrase
 * prompt, and on first contact it learns the host key through the same silent
 * TOFU path a session uses. A button that quietly does all three should say so
 * before it is pressed, not after somebody asks why a key trusted itself.
 */
function SshProbeResult({ state }: { state: SshProbeState }) {
  const t = useTranslations("devices.ssh")
  return (
    <div className="space-y-1" data-testid="ssh-probe-result">
      {state.status === "settled" ? (
        <p
          className={
            state.outcome.kind === "reachable"
              ? "text-xs text-emerald-600 dark:text-emerald-400"
              : "text-xs text-destructive"
          }
          role="status"
        >
          {state.outcome.kind === "reachable"
            ? /*
                `learned` means this probe is what wrote the key. Saying so is
                the only notice the user gets that a trust decision was made on
                their behalf.
              */
              t(
                state.outcome.hostKeyStatus === "learned"
                  ? "probe.reachableLearned"
                  : "probe.reachableVerified"
              )
            : state.outcome.kind === "unreachable"
              ? t("probe.unreachable", { message: state.outcome.message })
              : t("probe.invalid", { reason: state.outcome.reason })}
        </p>
      ) : null}
      <p className="text-[11px] text-muted-foreground">{t("probe.cost")}</p>
    </div>
  )
}

/**
 * How this host authenticates, and whether the thing it needs is present.
 *
 * The second half is the point. "Password" alone does not tell you the connect
 * button will fail, and `agent` needs nothing stored at all, so a single
 * "secret saved" indicator across all three methods would be wrong for two of
 * them.
 */
function SshAuthFact({ profile }: { profile: SshHostProfile }) {
  const t = useTranslations("devices.ssh")
  if (profile.authMethod === "agent") return <>{t("auth.agent")}</>
  if (profile.authMethod === "privateKey") {
    return (
      <span className="flex flex-col gap-0.5">
        <span>{t("auth.privateKey")}</span>
        {profile.privateKeyPath ? (
          <span className="font-mono text-[11px] font-normal break-all text-muted-foreground">
            {profile.privateKeyPath}
          </span>
        ) : null}
        {profile.credentialRef ? (
          <span className="text-[11px] font-normal text-muted-foreground">
            {t("auth.passphraseSaved")}
          </span>
        ) : null}
      </span>
    )
  }
  return (
    <span className="flex flex-col gap-0.5">
      <span>{t("auth.password")}</span>
      <span className="text-[11px] font-normal text-muted-foreground">
        {profile.credentialRef ? t("auth.passwordSaved") : t("auth.passwordMissing")}
      </span>
    </span>
  )
}

/**
 * The chain, outermost bastion first, drawn as the route it is.
 *
 * `ssh_config(5)` supports several comma-separated `ProxyJump` hops, and each
 * one authenticates and is TOFU-verified separately, so a chain is a list of
 * machines you are trusting rather than a transparent pipe. Flattening it to
 * "via a bastion" would hide how many.
 */
function SshRouteFact({
  chain,
  broken,
}: {
  chain: readonly SshHostProfile[] | null
  broken: boolean
}) {
  const t = useTranslations("devices.ssh")
  if (broken) return <span className="text-destructive">{t("route.broken")}</span>
  if (!chain || chain.length <= 1) return <>{t("route.direct")}</>
  return (
    <span className="flex flex-wrap items-center gap-1" data-testid="ssh-jump-chain">
      <span className="text-muted-foreground">{t("route.thisMachine")}</span>
      {chain.map((hop) => (
        <span key={hop.id} className="flex items-center gap-1">
          <ArrowRightIcon className="size-3 text-muted-foreground" aria-hidden />
          <span className="font-mono text-[11px] font-normal break-all">
            {`${hop.username}@${hop.host}:${hop.port}`}
          </span>
        </span>
      ))}
    </span>
  )
}
