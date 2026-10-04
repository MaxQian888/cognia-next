"use client"

/**
 * The one way the UI opens a saved SSH host.
 *
 * Four surfaces connect a host: the settings editor, the dock's shell picker,
 * the device console and the phone's terminal screen. Each carried its own
 * copy of the same twenty lines and each copy had drifted:
 *
 *  - only settings recognised a missing ssh-agent, the others printed the
 *    native string;
 *  - only the device console translated `ssh_profile_not_on_host`, the other
 *    three showed the marker itself;
 *  - the dock's host-mediated success toast read a key from the wrong
 *    namespace, so a phone connecting through its host saw the raw key path;
 *  - the device console never opened the dock, so a successful Connect there
 *    produced a tab nobody could see and no word that it existed;
 *  - none of them looked at the bastions, so a password bastion with nothing
 *    in the keyring passed every check and failed natively, naming nobody;
 *  - a "set a password first" refusal named Settings → Terminal and offered no
 *    way to get there.
 *
 * So the flow is here and the surfaces mount it. A caller that wants the
 * failure inline (the device console draws it under the card it belongs to)
 * passes `onFailure`; everyone else gets a toast that carries the action that
 * fixes it.
 *
 * After the user re-trusts a changed host key the connection is retried
 * automatically. `useSshHostKeyChange` has offered `onForgotten` for exactly
 * this since it was written and nothing passed it, so re-trusting a rebuilt
 * server was followed by the user clicking Connect a second time.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useSshHostKeyChange } from "@/hooks/terminal/use-ssh-host-key-change"
import { readSavedSshHosts } from "@/lib/terminal/saved-ssh-hosts"
import { killFromDock } from "@/lib/terminal/spawn-orchestrator"
import {
  connectSshFromDock,
  resolveSshHostLaunch,
  SSH_PROFILE_NOT_ON_HOST,
  type SshConnectOutcome,
} from "@/lib/terminal/ssh-connect"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import { sshHostSettingsHref } from "@/lib/terminal/terminal-settings-link"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

/** Geometry for a session opened before any pane has measured itself. */
const DEFAULT_ROWS = 24
const DEFAULT_COLS = 80

const INVALID_PROFILE_PREFIX = "invalid SSH host profile: "

export interface SshConnectInput {
  hostId: string
  /**
   * The profile set to resolve against. Defaults to the saved settings. The
   * editor passes its in-flight list so a just-typed port or bastion is used
   * for this connection rather than the copy still being debounced to disk.
   */
  profiles?: readonly SshHostProfile[]
  projectId?: string
  rows?: number
  cols?: number
  /**
   * Restart semantics: once the new connection is up, close this session. The
   * old tab is closed only after the new one exists, so a refused reconnect (a
   * changed host key, a dead bastion) leaves the user where they were rather
   * than with no tab at all.
   */
  replacesSessionId?: string
}

export interface UseSshConnectOptions {
  /**
   * Render failures inline instead of toasting them. Receives the translated
   * sentence, never a raw marker. A changed host key is never routed here: it
   * opens the adjudication dialog, which is the only answer to it.
   */
  onFailure?: (message: string) => void
  /** Reveal the terminal dock on success. Off for surfaces that ARE the terminal. */
  revealDock?: boolean
  /** Called with the new session id once connected. */
  onConnected?: (sessionId: string) => void
  /** Test seam. Defaults to the real dock launcher. */
  connectImpl?: typeof connectSshFromDock
}

export interface UseSshConnectResult {
  connect: (input: SshConnectInput) => Promise<SshConnectOutcome | null>
  /** The host currently being connected, for a per-row busy state. */
  pendingHostId: string | null
  /** Mount this: the changed-host-key dialog. Renders nothing until needed. */
  dialog: React.ReactNode
}

export function useSshConnect(options: UseSshConnectOptions = {}): UseSshConnectResult {
  const t = useTranslations("terminal.sshConnect")
  const router = useRouter()
  const { onFailure, revealDock = true, onConnected, connectImpl = connectSshFromDock } = options
  const [pendingHostId, setPendingHostId] = useState<string | null>(null)
  const lastInput = useRef<SshConnectInput | null>(null)
  const retryRef = useRef<((input: SshConnectInput) => Promise<unknown>) | null>(null)

  const hostKeyGuard = useSshHostKeyChange({
    onForgotten: () => {
      const input = lastInput.current
      if (input && retryRef.current) void retryRef.current(input)
    },
  })
  const { capture } = hostKeyGuard

  const fail = useCallback(
    (message: string, action?: { hostId: string; label: string }, description?: string) => {
      if (onFailure) {
        onFailure(description ? `${message} ${description}` : message)
        return
      }
      toast.error(message, {
        description,
        action: action
          ? {
              label: action.label,
              onClick: () => router.push(sshHostSettingsHref(action.hostId)),
            }
          : undefined,
      })
    },
    [onFailure, router]
  )

  const connect = useCallback(
    async (input: SshConnectInput): Promise<SshConnectOutcome | null> => {
      const profiles = input.profiles ?? readSavedSshHosts()
      const launch = resolveSshHostLaunch(input.hostId, profiles)
      if (launch.kind === "unknownHost") {
        fail(t("unknownHost"))
        return null
      }
      if (launch.kind === "credentialRequired") {
        fail(
          launch.bastion
            ? t("credentialRequiredBastion", { name: launch.name, bastion: launch.bastion.name })
            : t("credentialRequired", { name: launch.name }),
          { hostId: launch.hostId, label: t("actions.addPassword") }
        )
        return null
      }
      if (launch.kind === "chainBroken") {
        fail(t("chainBroken", { name: launch.name }), {
          hostId: launch.hostId,
          label: t("actions.editHost"),
        })
        return null
      }

      const profile = launch.profile
      const name = profile.name.trim() || `${profile.username}@${profile.host}`
      lastInput.current = input
      setPendingHostId(profile.id)
      let outcome: SshConnectOutcome
      try {
        outcome = await connectImpl({
          profile,
          allProfiles: profiles,
          rows: input.rows ?? DEFAULT_ROWS,
          cols: input.cols ?? DEFAULT_COLS,
          projectId: input.projectId,
          // Read at call time: subscribing the whole store here would re-render
          // every consumer on each keystroke in any terminal.
          store: useTerminalStore.getState(),
        })
      } catch (error) {
        outcome = { kind: "error", message: error instanceof Error ? error.message : String(error) }
      } finally {
        setPendingHostId(null)
      }

      if (outcome.kind === "error") {
        // A changed server key is refused before anything else can happen, and
        // it is the one failure the user must adjudicate rather than retry.
        if (capture(outcome.message)) return outcome
        if (outcome.message.startsWith(`${SSH_PROFILE_NOT_ON_HOST}:`)) {
          fail(t("notOnHost", { name: outcome.message.slice(SSH_PROFILE_NOT_ON_HOST.length + 1) }))
          return outcome
        }
        if (outcome.message.startsWith(INVALID_PROFILE_PREFIX)) {
          fail(
            t("invalidProfile", { name }),
            { hostId: profile.id, label: t("actions.editHost") },
            t(`invalidField.${invalidField(outcome.message)}`)
          )
          return outcome
        }
        // A missing or empty agent is the common first-run stumble, and the
        // generic failure title buries it. The native side reports both cases
        // as "SSH agent …", and the exact reason still rides in the body.
        if (profile.authMethod === "agent" && /\bssh agent\b/i.test(outcome.message)) {
          fail(t("agentUnavailable", { name }), undefined, outcome.message)
          return outcome
        }
        fail(
          t("failed", { name }),
          { hostId: profile.id, label: t("actions.editHost") },
          outcome.message
        )
        return outcome
      }

      if (input.replacesSessionId) {
        const store = useTerminalStore.getState()
        await killFromDock(input.replacesSessionId, store).catch((error) => {
          console.warn("use-ssh-connect: closing the replaced session failed", error)
        })
      }
      if (revealDock) useTerminalStore.getState().setPanelOpen(true)
      /**
       * A null verdict is not a missing one. It means the host made the
       * connection and the `/ws/terminal` frames carry no host-key fields, so
       * the key was verified somewhere we cannot read.
       */
      if (outcome.hostKeyStatus === null) {
        toast.success(t("connected.viaHost", { name }))
      } else {
        toast.success(t(`connected.${outcome.hostKeyStatus}`, { name }), {
          description: outcome.hostKeyFingerprint ?? undefined,
        })
      }
      onConnected?.(outcome.sessionId)
      return outcome
    },
    [capture, connectImpl, fail, onConnected, revealDock, t]
  )
  // Assigned after render, not during it: the retry runs from the dialog's
  // trust handler, long after this render committed.
  useEffect(() => {
    retryRef.current = connect
  }, [connect])

  return { connect, pendingHostId, dialog: hostKeyGuard.dialog }
}

/** The field `buildForwardedConnectRequest` named, or `profile` when unknown. */
function invalidField(message: string): InvalidField {
  const reason = message.slice(INVALID_PROFILE_PREFIX.length).trim()
  return (INVALID_FIELDS as readonly string[]).includes(reason)
    ? (reason as InvalidField)
    : "profile"
}

const INVALID_FIELDS = [
  "name",
  "host",
  "port",
  "username",
  "privateKeyPath",
  "profile",
  "jumpChain",
  "localForward",
  "remoteForward",
] as const

type InvalidField = (typeof INVALID_FIELDS)[number]
