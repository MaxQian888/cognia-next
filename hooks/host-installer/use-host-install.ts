"use client"

/**
 * Drive one bootstrap session against a saved SSH profile (ADR-0235 P5): dial,
 * inspect, run the plan the user chose, and file the Host it paired.
 *
 * The native session holds the connection and the inspection; this hook holds
 * the renderer's view of them and enforces the order of steps:
 *
 *  * **Consent is the plan plus the inspection it was offered on.** Every step
 *    names both, and the native side refuses a stale inspection or a plan it
 *    did not offer. A step that may or may not have run (`unknown`) is never
 *    repeated in place: {@link nextStepFor} sends it back to inspection.
 *  * **A retry repeats the step that failed**, not the plan. When an install
 *    succeeded and pairing hit a fault, the retry asks for a fresh invitation
 *    only.
 *  * **The invitation is an owner credential.** It goes from the native pair
 *    step straight to `registerPairPayload` and is never stored in state,
 *    rendered or logged. The checks that must run while it is still
 *    redeemable are the shared `preflightPairing`.
 *  * **A registration failure re-inspects.** The Host may already have burned
 *    the invitation, and only a new inspection's `re_pair` plan mints another.
 *
 * The Host is installed for the machine's default local account
 * (`local_acct_a`), the id its own brain registers; naming this desktop's
 * account instead would make the brain's sync pulls disagree with the server.
 * The session closes when the hook unmounts.
 */

import { useTranslations } from "next-intl"
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react"

import {
  credentialStoreReady as defaultCredentialStoreReady,
  preflightPairing,
} from "@/components/connectivity/pair/pair-preflight"
import { registerPairPayload as defaultRegisterPairPayload } from "@/components/connectivity/pair/pair-api"
import {
  diagnosePairFailure,
  diagnosePayloadFailure,
  type PairFailure,
} from "@/components/connectivity/pair/pair-failure"
import { useRegisterPairedHost } from "@/hooks/devices/use-register-paired-host"
import { recordRecentServer } from "@/lib/connectivity/recent-servers"
import { getLocalDeviceConsoleLabel } from "@/lib/device/device-identity"
import * as installerClient from "@/lib/host-installer/client"
import type {
  InspectionView,
  InstallerFailure,
  OpenedView,
  PlanKind,
  StageName,
} from "@/lib/host-installer/client"
import {
  applyStageEvent,
  failRunningStage,
  initialProgress,
  nextStepFor,
  type NextStep,
  type StageProgress,
  type StageStatus,
} from "@/lib/host-installer/flow"
import { decodePairPayload } from "@/lib/qr/pair-payload"
import type { ForwardedRequestError } from "@/lib/terminal/ssh-forwarding"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"

export type HostInstallFailure =
  { source: "installer"; failure: InstallerFailure } | { source: "pair"; failure: PairFailure }

/** What the sheet renders. Every phase after `connecting` keeps what it learned. */
export type HostInstallPhase =
  | { kind: "idle" }
  | { kind: "invalid_profile"; reason: ForwardedRequestError }
  | { kind: "connecting" }
  | { kind: "inspecting"; opened: OpenedView }
  | { kind: "ready"; opened: OpenedView; inspection: InspectionView }
  | {
      kind: "running"
      opened: OpenedView
      inspection: InspectionView
      plan: PlanKind
      progress: StageProgress[]
    }
  | {
      kind: "paired"
      opened: OpenedView
      inspection: InspectionView
      plan: PlanKind
      progress: StageProgress[]
      host: RemoteHost
    }
  | {
      kind: "uninstalled"
      opened: OpenedView
      inspection: InspectionView
      progress: StageProgress[]
      dataDeleted: boolean
    }
  | {
      kind: "failed"
      opened: OpenedView | null
      inspection: InspectionView | null
      plan: PlanKind | null
      progress: StageProgress[]
      failure: HostInstallFailure
      next: NextStep
    }

/** What the user chose for a plan. Pairing options apply to every plan but uninstall. */
export interface RunChoice {
  plan: PlanKind
  /** The release channel the Host follows. */
  channel: string
  label: string
  alwaysOn: boolean
  connectAfter: boolean
  /** The machine's name, typed, to also delete the Host's data on uninstall. */
  deleteDataConfirmation?: string
}

export interface HostInstallDeps {
  client?: Pick<
    typeof installerClient,
    | "installerSshRequest"
    | "openSsh"
    | "inspectMachine"
    | "installHost"
    | "pairHost"
    | "uninstallHost"
    | "closeSession"
    | "onStage"
  >
  registerPairPayload?: typeof defaultRegisterPairPayload
  credentialStoreReady?: () => boolean
  deviceName?: () => Promise<string>
  now?: () => number
}

export interface HostInstall {
  phase: HostInstallPhase
  /** Dial the profile and inspect the machine. Closes any session first. */
  connect: () => Promise<void>
  /** Read the machine again; the only way forward after an unknown outcome. */
  reinspect: () => Promise<void>
  run: (choice: RunChoice) => Promise<void>
  /** Repeat the step that failed. Only meaningful when `next` is `retry`. */
  retry: () => Promise<void>
  /** The host-switch confirmation `connectAfter` may raise. Render it once. */
  dialog: ReactElement
}

type Step = "install" | "pair" | "uninstall"

const SUCCESS_STAGES: Record<Step, readonly StageName[]> = {
  install: ["fetch", "upload", "stage", "service"],
  pair: ["pair"],
  uninstall: ["service"],
}

function markStages(
  progress: readonly StageProgress[],
  stages: readonly StageName[],
  status: StageStatus
): StageProgress[] {
  return progress.map((entry) => (stages.includes(entry.stage) ? { ...entry, status } : entry))
}

function failedStage(failure: HostInstallFailure): StageName | null {
  if (failure.source === "pair") return "pair"
  const native = failure.failure
  if ("stage" in native) return native.stage
  if (native.kind === "release") return "fetch"
  if (native.kind === "relay_unavailable") return "pair"
  return null
}

export function useHostInstall(
  profile: SshHostProfile,
  allProfiles: readonly SshHostProfile[],
  deps: HostInstallDeps = {}
): HostInstall {
  const client = deps.client ?? installerClient
  const register = deps.registerPairPayload ?? defaultRegisterPairPayload
  const storeReady = deps.credentialStoreReady ?? defaultCredentialStoreReady
  const deviceName = deps.deviceName ?? getLocalDeviceConsoleLabel
  const now = deps.now ?? Date.now
  const { register: fileHost, dialog } = useRegisterPairedHost()
  const tPair = useTranslations("mobile.pair")

  const [phase, setPhase] = useState<HostInstallPhase>({ kind: "idle" })
  const sessionRef = useRef<string | null>(null)
  const unlistenRef = useRef<(() => void) | null>(null)
  const openedRef = useRef<OpenedView | null>(null)
  const inspectionRef = useRef<InspectionView | null>(null)
  const progressRef = useRef<StageProgress[]>([])
  const lastRef = useRef<{ choice: RunChoice; step: Step } | null>(null)
  const mountedRef = useRef(true)

  const commit = useCallback((next: HostInstallPhase) => {
    if (mountedRef.current) setPhase(next)
  }, [])

  const setProgress = useCallback((next: StageProgress[]) => {
    progressRef.current = next
  }, [])

  const fail = useCallback(
    (failure: HostInstallFailure, plan: PlanKind | null) => {
      // The row a failure names is failed even when its start event has not
      // arrived yet; a registration failure comes after the native pair step
      // reported success, so its row is named rather than found running.
      const named = failedStage(failure)
      const running = failRunningStage(progressRef.current)
      const progress = named ? markStages(running, [named], "failed") : running
      setProgress(progress)
      const next = failure.source === "installer" ? nextStepFor(failure.failure) : "reinspect"
      commit({
        kind: "failed",
        opened: openedRef.current,
        inspection: inspectionRef.current,
        plan,
        progress,
        failure,
        next,
      })
    },
    [commit, setProgress]
  )

  const closeCurrent = useCallback(async () => {
    unlistenRef.current?.()
    unlistenRef.current = null
    const id = sessionRef.current
    sessionRef.current = null
    openedRef.current = null
    inspectionRef.current = null
    if (id) await client.closeSession(id)
  }, [client])

  const inspect = useCallback(async () => {
    const sessionId = sessionRef.current
    const opened = openedRef.current
    if (!sessionId || !opened) {
      fail({ source: "installer", failure: { kind: "no_session" } }, null)
      return
    }
    lastRef.current = null
    setProgress([])
    commit({ kind: "inspecting", opened })
    const result = await client.inspectMachine(sessionId)
    if (!result.ok) {
      inspectionRef.current = null
      fail({ source: "installer", failure: result.failure }, null)
      return
    }
    inspectionRef.current = result.value
    commit({ kind: "ready", opened, inspection: result.value })
  }, [client, commit, fail, setProgress])

  const connect = useCallback(async () => {
    await closeCurrent()
    const built = client.installerSshRequest(profile, allProfiles)
    if (built.kind !== "ok") {
      commit({ kind: "invalid_profile", reason: built.reason })
      return
    }
    setProgress([])
    commit({ kind: "connecting" })
    const opened = await client.openSsh(built.request)
    if (!opened.ok) {
      fail({ source: "installer", failure: opened.failure }, null)
      return
    }
    const sessionId = opened.value.sessionId
    if (!mountedRef.current) {
      await client.closeSession(sessionId)
      return
    }
    sessionRef.current = sessionId
    openedRef.current = opened.value
    const unlisten = await client.onStage(sessionId, (event) => {
      if (sessionRef.current !== sessionId) return
      const progress = applyStageEvent(progressRef.current, event)
      if (progress === progressRef.current) return
      setProgress(progress)
      if (!mountedRef.current) return
      setPhase((current) => (current.kind === "running" ? { ...current, progress } : current))
    })
    if (sessionRef.current !== sessionId) {
      unlisten()
      return
    }
    unlistenRef.current = unlisten
    await inspect()
  }, [allProfiles, client, closeCurrent, commit, fail, inspect, profile, setProgress])

  const pairStep = useCallback(
    async (choice: RunChoice) => {
      const sessionId = sessionRef.current
      const opened = openedRef.current
      const inspection = inspectionRef.current
      if (!sessionId || !opened || !inspection || choice.plan === "uninstall") return
      lastRef.current = { choice, step: "pair" }
      const minted = await client.pairHost({
        sessionId,
        inspectionId: inspection.inspectionId,
        plan: choice.plan,
        deviceName: await deviceName(),
      })
      if (!minted.ok) {
        fail({ source: "installer", failure: minted.failure }, choice.plan)
        return
      }
      // The invitation stays in this scope: decoded, checked and redeemed.
      const invitation = minted.value.invitation
      const decoded = decodePairPayload(invitation)
      if (decoded.kind !== "ok") {
        fail({ source: "pair", failure: diagnosePayloadFailure(decoded) }, choice.plan)
        return
      }
      const preflight = preflightPairing({
        baseUrl: decoded.payload.baseUrl,
        hasRelay: decoded.payload.relay !== undefined,
        webMode: false,
        credentialStoreReady: storeReady(),
        vaultLockedText: tPair("failure.body.vaultLockedPending"),
      })
      if (preflight) {
        fail({ source: "pair", failure: preflight }, choice.plan)
        return
      }
      const result = await register(invitation)
      if (result.kind === "invalid_payload") {
        fail({ source: "pair", failure: diagnosePayloadFailure(result.outcome) }, choice.plan)
        return
      }
      if (result.kind !== "ok") {
        fail(
          {
            source: "pair",
            failure: diagnosePairFailure(result.error, {
              stage: "register",
              baseUrl: result.baseUrl,
              webMode: false,
            }),
          },
          choice.plan
        )
        return
      }
      let host: RemoteHost
      try {
        host = fileHost(result.config, {
          label: choice.label,
          alwaysOn: choice.alwaysOn,
          connectAfter: choice.connectAfter,
          installBinding: { kind: "ssh", profileId: profile.id, installedAt: now() },
        })
      } catch (error) {
        fail(
          {
            source: "pair",
            failure: diagnosePairFailure(error, {
              stage: "persist",
              baseUrl: result.config.baseUrl,
              webMode: false,
            }),
          },
          choice.plan
        )
        return
      }
      recordRecentServer({
        baseUrl: result.config.baseUrl,
        fingerprint: result.config.serverFingerprint,
        label: host.label,
        deviceId: result.config.deviceId,
        serverVersion: result.config.serverVersion,
      })
      const progress = markStages(progressRef.current, SUCCESS_STAGES.pair, "done")
      setProgress(progress)
      lastRef.current = null
      commit({ kind: "paired", opened, inspection, plan: choice.plan, progress, host })
    },
    [
      client,
      commit,
      deviceName,
      fail,
      fileHost,
      now,
      profile.id,
      register,
      setProgress,
      storeReady,
      tPair,
    ]
  )

  const runFrom = useCallback(
    async (choice: RunChoice, step: Step) => {
      const sessionId = sessionRef.current
      const opened = openedRef.current
      const inspection = inspectionRef.current
      if (!sessionId || !opened || !inspection) {
        fail({ source: "installer", failure: { kind: "no_session" } }, choice.plan)
        return
      }
      // A retried step starts from the progress it failed in; a new plan
      // starts from its own stages.
      const progress =
        lastRef.current?.choice === choice
          ? progressRef.current.map((entry) =>
              entry.status === "failed" ? { ...entry, status: "pending" as const } : entry
            )
          : initialProgress(choice.plan)
      setProgress(progress)
      commit({ kind: "running", opened, inspection, plan: choice.plan, progress })

      if (step === "uninstall") {
        lastRef.current = { choice, step }
        const result = await client.uninstallHost({
          sessionId,
          inspectionId: inspection.inspectionId,
          deleteDataConfirmation: choice.deleteDataConfirmation,
        })
        if (!result.ok) {
          fail({ source: "installer", failure: result.failure }, choice.plan)
          return
        }
        const done = markStages(progressRef.current, SUCCESS_STAGES.uninstall, "done")
        setProgress(done)
        lastRef.current = null
        commit({
          kind: "uninstalled",
          opened,
          inspection,
          progress: done,
          dataDeleted: Boolean(choice.deleteDataConfirmation),
        })
        return
      }

      if (step === "install") {
        if (choice.plan !== "fresh" && choice.plan !== "repair") return
        lastRef.current = { choice, step }
        const result = await client.installHost({
          sessionId,
          inspectionId: inspection.inspectionId,
          plan: choice.plan,
          channel: choice.channel,
        })
        if (!result.ok) {
          fail({ source: "installer", failure: result.failure }, choice.plan)
          return
        }
        setProgress(markStages(progressRef.current, SUCCESS_STAGES.install, "done"))
        commit({
          kind: "running",
          opened,
          inspection,
          plan: choice.plan,
          progress: progressRef.current,
        })
      }
      await pairStep(choice)
    },
    [client, commit, fail, pairStep, setProgress]
  )

  const run = useCallback(
    async (choice: RunChoice) => {
      lastRef.current = null
      const step: Step =
        choice.plan === "uninstall" ? "uninstall" : choice.plan === "re_pair" ? "pair" : "install"
      await runFrom(choice, step)
    },
    [runFrom]
  )

  const retry = useCallback(async () => {
    const last = lastRef.current
    if (!last) return
    await runFrom(last.choice, last.step)
  }, [runFrom])

  // The session closes on unmount only, whatever the callers' deps do.
  const closeRef = useRef(closeCurrent)
  useEffect(() => {
    closeRef.current = closeCurrent
  }, [closeCurrent])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      void closeRef.current()
    }
  }, [])

  return { phase, connect, reinspect: inspect, run, retry, dialog }
}
