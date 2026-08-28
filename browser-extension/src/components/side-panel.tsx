import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  BrowserCaptureMode,
  BrowserContextSubmissionSummaryV1,
} from "@cognia/companion-client"
import { BROWSER_CONTEXT_LIMITS, utf8ByteLength } from "@cognia/companion-client"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@cognia/plugin-ui"

import { applyAppearance, isAppliedAppearance } from "@ext/src/lib/appearance/apply-appearance"
import { STORAGE_KEYS, type BrowserApi } from "@ext/src/lib/browser-api"
import {
  CAPTURE_REQUEST_KEY,
  isFreshCaptureRequest,
  type CaptureRequest,
} from "@ext/src/lib/capture/capture-request"
import { normalizeCaptureUrl } from "@ext/src/lib/capture/normalize-url"
import { clearDeviceKey } from "@ext/src/lib/device-key"
import {
  createHostClient,
  pairWithHost,
  restoreSigner,
  type HostClient,
  type PairingRecord,
} from "@ext/src/lib/client"
import {
  APPEARANCE_OVERRIDES,
  STATUSES_WITH_A_REASON,
  appearanceOverrideMessage,
  captureModeFor,
  initialTargetParams,
  isAppearanceOverride,
  isCompatible,
  panelStateForError,
  pollIntervalFor,
  preferredModeFor,
  selectedTargetId,
  stopFailureMessage,
  targetLabel,
  targetParamsSatisfied,
  targetsForWorkspace,
  type AppearanceOverride,
  type CapturedPage,
  type PanelState,
} from "@ext/src/lib/panel-state"
import { CapturePreview } from "./capture-preview"
import { PairScreen } from "./pair-screen"
import { RecentList } from "./recent-list"

export interface SidePanelProps {
  api: BrowserApi
  /** Test seam. Defaults to the real network client. */
  makeClient?: typeof createHostClient
  now?: () => number
}

/**
 * The whole side panel.
 *
 * State lives here rather than in the service worker because MV3 reclaims the
 * worker whenever it likes, and a captured page held there would vanish
 * mid-review with no event to notice it. The panel is alive exactly while the
 * user is looking at it, which is also exactly when this state is meaningful.
 *
 * Nothing captured ever reaches storage. The page text, the selection and the
 * instruction live in React state and die with the panel; what persists is the
 * public pairing record, the Host's appearance, and the last workspace choice.
 */
export function SidePanel({
  api,
  makeClient = createHostClient,
  now = () => Date.now(),
}: SidePanelProps) {
  const [state, setState] = useState<PanelState>({ kind: "loading" })
  const [instruction, setInstruction] = useState("")
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [preferredTargetId, setPreferredTargetId] = useState<string | null>(null)
  const [targetParams, setTargetParams] = useState<Record<string, string>>({})
  const [wholePage, setWholePage] = useState(false)
  const [includeFullUrl, setIncludeFullUrl] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  // Assumed absent until proven otherwise. Over-explaining a prompt that does
  // not appear is a smaller failure than a system dialog nobody was warned
  // about.
  const [hasPermission, setHasPermission] = useState(false)
  const [override, setOverride] = useState<AppearanceOverride>("follow-host")
  const [failureCodes, setFailureCodes] = useState<Record<string, string>>({})
  const [answers, setAnswers] = useState<Record<string, { text?: string; truncated?: boolean }>>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const [stopping, setStopping] = useState<string | null>(null)
  const clientRef = useRef<HostClient | null>(null)
  const pendingSubmissionRef = useRef<{ fingerprint: string; submissionId: string } | null>(null)
  // Ids already asked about, so an answered row is not re-fetched every poll —
  // held in a ref rather than derived from `failureCodes` so this effect does
  // not depend on the state it writes.
  const askedForReasonRef = useRef<Set<string>>(new Set())

  // Paint before anything else. The stored appearance is the Host's last
  // answer, so a panel reopened offline still looks like the app rather than
  // flashing the fallback palette and then correcting itself.
  useEffect(() => {
    void api
      .read<unknown>(STORAGE_KEYS.appearance)
      .then((stored) => {
        if (isAppliedAppearance(stored)) applyAppearance(document.documentElement, stored)
      })
      .catch(() => undefined)
  }, [api])

  useEffect(() => {
    void api.hasLoopbackPermission().then(setHasPermission)
  }, [api])

  useEffect(() => {
    void api
      .read<unknown>(STORAGE_KEYS.appearanceOverride)
      .then((stored) => {
        if (isAppearanceOverride(stored)) setOverride(stored)
      })
      .catch(() => undefined)
  }, [api])

  // Recover a submission whose response never arrived.
  //
  // This used to live only in the ref, which dies with the panel — so the one
  // case it existed for (the panel closing mid-submit) was exactly the case it
  // could not cover, and reopening minted a fresh id for the same capture. The
  // id is not content: it is a UUID and a fingerprint of the choices, so it is
  // safe in `chrome.storage.local` alongside the pairing record.
  useEffect(() => {
    void api
      .read<{ fingerprint: string; submissionId: string }>(STORAGE_KEYS.pendingSubmission)
      .then((stored) => {
        if (stored?.fingerprint && stored.submissionId) pendingSubmissionRef.current = stored
      })
      .catch(() => undefined)
  }, [api])

  /**
   * Work out where this browser stands with the Host.
   *
   * Returns the answer rather than applying it. Setting state from inside an
   * async function that an effect calls is the shape React's own lint rule
   * objects to — and the objection is fair: it makes "what does connecting
   * decide?" unanswerable without tracing every branch's side effects. As a
   * pure-ish resolver, the branches are one `switch` worth of reading.
   */
  const resolveConnection = useCallback(async (): Promise<{
    state: PanelState
    workspaceId?: string | null
  }> => {
    let connection: {
      pairing: PairingRecord
      signer: NonNullable<Awaited<ReturnType<typeof restoreSigner>>>
    }
    try {
      const pairing = await api.read<PairingRecord>(STORAGE_KEYS.pairing)
      if (!pairing) return { state: { kind: "unpaired" } }
      const signer = await restoreSigner(pairing)
      if (!signer) {
        // The public record survived but the key did not — a profile copied
        // between machines, or IndexedDB cleared. Treat it as unpaired rather
        // than as an error: the remedy is the same and the state is honest.
        await api.remove([STORAGE_KEYS.pairing])
        return { state: { kind: "unpaired" } }
      }
      connection = { pairing, signer }
    } catch {
      return { state: { kind: "storage-error" } }
    }
    const { pairing, signer } = connection
    const client = makeClient({ pairing, signer })
    clientRef.current = client
    try {
      let capability = await client.capability(preferredModeFor(override, undefined, prefersDark()))
      if (!isCompatible(capability)) {
        return {
          state: { kind: "incompatible", hostSchemaVersion: capability.schemaVersion },
        }
      }
      // Only now is `followsSystem` known, and it is the one input the Host
      // cannot supply itself. Asking again is a second round trip, and only for
      // a Host in system mode with no local override — the alternative is
      // painting the panel dark for everyone whose system is light, which is
      // what it did before.
      const wanted = preferredModeFor(override, capability.followsSystem, prefersDark())
      if (wanted && wanted !== capability.appearance.mode) {
        capability = await client.capability(wanted)
      }
      applyAppearance(document.documentElement, capability.appearance)
      void api.write(STORAGE_KEYS.appearance, capability.appearance)
      const stored = await api.read<string>(STORAGE_KEYS.lastWorkspaceId)
      const chosen =
        capability.workspaces.find((w) => w.id === stored) ??
        capability.workspaces.find((w) => w.isDefault) ??
        capability.workspaces[0]
      const page = await client.list()
      return {
        state: {
          kind: "ready",
          pairing,
          capability,
          capabilityRevision: page.capabilityRevision,
          recent: page.items,
          captured: null,
        },
        workspaceId: chosen?.id ?? null,
      }
    } catch (error) {
      const state = panelStateForError(error, pairing)
      // A revoked device's cached access token is dead and its refresh will be
      // refused too. Dropping the client without invalidating leaves that token
      // in the session cache, so a reconnect on the same panel replays it once
      // before finding out — one wasted round trip that reports as an
      // authentication failure rather than as "reconnect".
      if (state.kind === "revoked") client.invalidate()
      return { state }
    }
  }, [api, makeClient, override])

  const connect = useCallback(async () => {
    const next = await resolveConnection()
    setState(next.state)
    if (next.workspaceId !== undefined) setWorkspaceId(next.workspaceId)
  }, [resolveConnection])

  useEffect(() => {
    let cancelled = false
    void resolveConnection().then((next) => {
      if (cancelled) return
      setState(next.state)
      if (next.workspaceId !== undefined) setWorkspaceId(next.workspaceId)
    })
    return () => {
      cancelled = true
    }
  }, [resolveConnection])

  /**
   * Read a page and put it in the preview.
   *
   * `tabId` names the tab the user actually gestured on. It matters because
   * the gesture and this call are not in the same moment: a context-menu click
   * happens in the background worker, which records the request and opens the
   * panel, and the panel may be starting from nothing. By then "the active
   * tab" can be a different page — or, when the panel is a tab rather than a
   * side panel, the panel itself. Falling back to the active tab is right only
   * for the panel's own capture button, where the gesture *is* here.
   */
  const runCapture = useCallback(
    async (whole: boolean, tabId?: number) => {
      const tab = tabId === undefined ? await api.activeTab() : await api.tabById(tabId)
      if (!tab) {
        // A recorded request whose tab has since closed. Saying so beats
        // silently doing nothing, which reads as the extension being broken.
        if (tabId !== undefined) setSubmitError(api.message("captureNoGrant"))
        return
      }
      const decision = normalizeCaptureUrl(tab.url, includeFullUrl)
      if (!decision.ok) {
        setSubmitError(api.message("captureRestricted"))
        return
      }
      let extracted
      try {
        extracted = await api.extract(tab.id, whole)
      } catch {
        // `activeTab` is granted to the gesture that invoked the extension, on
        // the tab it was invoked from — and it lapses on navigation. Switching
        // tabs with the panel open is the ordinary way to arrive here, so this
        // is a instruction rather than an error.
        setSubmitError(api.message("captureNoGrant"))
        return
      }
      const selection = clip(extracted.selection, BROWSER_CONTEXT_LIMITS.selectionBytes)
      const readable = clip(extracted.readableText, BROWSER_CONTEXT_LIMITS.readableTextBytes)
      setSubmitError(null)
      setWholePage(whole)
      setState((current) =>
        current.kind === "ready"
          ? {
              ...current,
              captured: {
                tabId: tab.id,
                title: extracted.title || tab.title,
                url: decision.url,
                rawUrl: tab.url,
                selection,
                readableText: readable
                  ? { ...readable, originalCharacterCount: extracted.readableCharacterCount }
                  : null,
                capturedAt: now(),
                strippedQuery: decision.strippedQuery || decision.strippedFragment,
              },
            }
          : current
      )
    },
    [api, includeFullUrl, now]
  )

  // Pick up a capture the background worker recorded, once the panel is
  // connected. Consumed immediately: leaving it in storage would re-capture on
  // every panel open, which is precisely the "reads the page without being
  // asked" behaviour the design forbids.
  const ready = state.kind === "ready"
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    void api.read<CaptureRequest>(CAPTURE_REQUEST_KEY).then(async (request) => {
      if (!request || cancelled) return
      await api.remove([CAPTURE_REQUEST_KEY])
      if (!isFreshCaptureRequest(request, now())) return
      await runCapture(request.mode === "page", request.tabId)
    })
    return () => {
      cancelled = true
    }
  }, [ready, api, now, runCapture])

  const recent = state.kind === "ready" ? state.recent : EMPTY
  const pollMs = useMemo(() => pollIntervalFor(recent), [recent])

  // Ask why, once per failed submission.
  //
  // The list is thin by design and carries no `errorCode`; `browser_context_get`
  // is the only call that answers it. A refusal to read one is not worth
  // surfacing on its own — the row already says the submission failed, and this
  // is the sentence underneath it.
  useEffect(() => {
    const unexplained = recent.filter(
      (item) =>
        STATUSES_WITH_A_REASON.includes(item.status) &&
        !askedForReasonRef.current.has(item.submissionId)
    )
    if (unexplained.length === 0) return
    let cancelled = false
    for (const item of unexplained) askedForReasonRef.current.add(item.submissionId)
    void Promise.all(
      unexplained.map(async (item) => {
        try {
          const detail = await clientRef.current?.get(item.submissionId)
          return [item.submissionId, detail?.errorCode ?? ""] as const
        } catch {
          // Asked and could not be told. The id stays in the asked set: a row
          // whose detail read fails once will fail the same way every poll.
          return [item.submissionId, ""] as const
        }
      })
    ).then((entries) => {
      if (cancelled) return
      const answered = entries.filter(([, code]) => code.length > 0)
      if (answered.length > 0) {
        setFailureCodes((current) => ({ ...current, ...Object.fromEntries(answered) }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [recent])

  // Poll only while the panel is visible. A hidden side panel is one the user
  // is not reading, and a request every three seconds for a list nobody is
  // looking at is a cost with no reader.
  // Refs rather than deps: the poll loop is torn down and rebuilt whenever its
  // dependencies change, and restarting a three-second timer every time the
  // recent list moves would make the interval meaningless.
  const revisionRef = useRef<string | undefined>(undefined)
  const preferredModeRef = useRef<"light" | "dark" | undefined>(undefined)
  const readyRevision = state.kind === "ready" ? state.capabilityRevision : undefined
  const followsSystem = state.kind === "ready" ? state.capability.followsSystem : undefined
  useEffect(() => {
    revisionRef.current = readyRevision
  }, [readyRevision])
  useEffect(() => {
    preferredModeRef.current = preferredModeFor(override, followsSystem, prefersDark())
  }, [override, followsSystem])

  useEffect(() => {
    if (state.kind !== "ready") return
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const tick = async () => {
      if (stopped || document.visibilityState !== "visible") {
        timer = setTimeout(() => void tick(), pollMs)
        return
      }
      try {
        const page = await clientRef.current?.list()
        if (page && !stopped) {
          setState((current) =>
            current.kind === "ready" ? { ...current, recent: page.items } : current
          )
          // The Host says, in one string, whether anything the capability
          // describes has moved — its theme, its workspaces, its delivery
          // targets. Re-reading the whole capability every poll would send a
          // palette every three seconds for a thing that changes when the user
          // does something.
          if (page.capabilityRevision && page.capabilityRevision !== revisionRef.current) {
            revisionRef.current = page.capabilityRevision
            const refreshed = await clientRef.current?.capability(preferredModeRef.current)
            if (refreshed && isCompatible(refreshed) && !stopped) {
              applyAppearance(document.documentElement, refreshed.appearance)
              void api.write(STORAGE_KEYS.appearance, refreshed.appearance)
              setState((current) =>
                current.kind === "ready"
                  ? {
                      ...current,
                      capability: refreshed,
                      capabilityRevision: page.capabilityRevision,
                    }
                  : current
              )
            }
          }
        }
      } catch {
        // A failed poll is not a state change: the pairing is still good and
        // the next tick may succeed. Only an explicit refusal demotes us.
      }
      timer = setTimeout(() => void tick(), pollMs)
    }
    timer = setTimeout(() => void tick(), pollMs)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [state.kind, pollMs, api])

  /**
   * Show or hide one task's answer, fetching it the first time.
   *
   * Fetched on demand rather than with the list: the list is polled and an
   * answer is the largest thing this contract returns, so pulling every one on
   * every tick would move kilobytes for rows nobody is reading. Re-fetched on
   * every expand, because a running task's answer changes.
   */
  const toggleAnswer = useCallback(
    (submissionId: string) => {
      setExpanded((current) =>
        current.includes(submissionId)
          ? current.filter((id) => id !== submissionId)
          : [...current, submissionId]
      )
      if (expanded.includes(submissionId)) return
      void clientRef.current
        ?.result(submissionId)
        .then((detail) => {
          setAnswers((current) => ({
            ...current,
            [submissionId]: { text: detail.text, truncated: detail.truncated },
          }))
        })
        .catch(() => {
          // The row stays expanded and shows "no answer yet", which is what an
          // unreadable result and an unwritten one look like from here.
          setAnswers((current) => ({ ...current, [submissionId]: {} }))
        })
    },
    [expanded]
  )

  /**
   * Stop one task.
   *
   * The Host's refusal codes matter here more than usual: "another device is
   * driving this" is not a failure, it is a different place to press the
   * button, and saying "could not be stopped" would send somebody looking for
   * a fault that is not there.
   */
  const stopTask = useCallback(
    async (submissionId: string) => {
      setStopping(submissionId)
      setSubmitError(null)
      try {
        await clientRef.current?.cancel(submissionId)
        const page = await clientRef.current?.list()
        if (page) {
          setState((current) =>
            current.kind === "ready" ? { ...current, recent: page.items } : current
          )
        }
      } catch (error) {
        setSubmitError(stopFailureMessage((error as { code?: string })?.code, api.message))
      } finally {
        setStopping(null)
      }
    },
    [api]
  )

  const onPair = useCallback(
    async (code: string) => {
      setState({ kind: "pairing" })
      const granted = (await api.hasLoopbackPermission()) || (await api.requestLoopbackPermission())
      const outcome = await pairWithHost({
        code,
        extensionOrigin: api.extensionOrigin(),
        hasPermission: granted,
        displayName: navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome",
      })
      if (!outcome.ok) {
        setState({ kind: "unpaired", failure: outcome.failure })
        return
      }
      await api.write(STORAGE_KEYS.pairing, outcome.pairing)
      await connect()
    },
    [api, connect]
  )

  const onSubmit = useCallback(async () => {
    if (state.kind !== "ready" || !state.captured || !workspaceId) return
    const captured = withDisplayUrl(state.captured, includeFullUrl)
    const mode: BrowserCaptureMode = captureModeFor(captured, wholePage)
    // Recomputed here from the same two helpers the control renders from,
    // rather than read out of state: one rule for "which target is selected"
    // means the value sent is by construction the one on screen.
    const offered = targetsForWorkspace(state.capability.deliveryTargets, workspaceId)
    const chosenTarget = selectedTargetId(offered, preferredTargetId)
    const chosen = offered.find((target) => target.id === chosenTarget)
    const declaredParams = chosen?.params ?? []
    const declaredTemplate = chosen?.kind === "template"
    setSubmitting(true)
    setSubmitError(null)
    const draft = {
      workspaceId,
      ...(chosenTarget ? { targetId: chosenTarget } : {}),
      // Only the values the chosen target actually declares. Sending the whole
      // map would carry a previous target's answers along, and the Host drops
      // them anyway — this keeps the request describing what was on screen.
      ...(declaredParams.length > 0
        ? {
            targetParams: Object.fromEntries(
              declaredParams
                .filter((param) => (targetParams[param.id] ?? "").length > 0)
                .map((param) => [param.id, targetParams[param.id]])
            ),
          }
        : {}),
      // A template supplies the instruction on the Host; the field is not shown
      // for one, so sending its stale contents would be sending something the
      // user is not looking at.
      instruction: declaredTemplate ? "" : instruction.trim(),
      context: {
        schemaVersion: 1 as const,
        captureMode: mode,
        url: captured.url,
        title: captured.title,
        capturedAt: captured.capturedAt,
        ...(mode !== "metadata" && captured.selection ? { selection: captured.selection } : {}),
        ...(mode === "readable-page" && captured.readableText
          ? { readableText: captured.readableText }
          : {}),
      },
    }
    // Cheap discriminators, not the payload. `readableText` runs to the
    // whole-page ceiling, so hashing the draft serialized hundreds of KB on the
    // main thread on every press — and then `submit` serialized the same object
    // again for the request body, a visible hitch on the click for nothing.
    // What decides "same capture" is the page, the moment it was taken, the
    // mode, the ask and the target; the two content lengths catch a
    // re-extraction of the same URL.
    const fingerprint = JSON.stringify([
      workspaceId,
      // Where it goes is part of what makes this the same submission. Leaving
      // it out would let a retry that changed the destination reuse the first
      // one's id, which the Host refuses — as a mismatch the user cannot see
      // the cause of.
      chosenTarget,
      draft.instruction,
      // The values are part of what makes this the same submission: a retry
      // that changed one and reused the id would ask a different question of
      // the page the first attempt captured.
      JSON.stringify(draft.targetParams ?? {}),
      mode,
      captured.url,
      captured.capturedAt,
      captured.selection?.text.length ?? -1,
      captured.readableText?.text.length ?? -1,
    ])
    const submissionId =
      pendingSubmissionRef.current?.fingerprint === fingerprint
        ? pendingSubmissionRef.current.submissionId
        : crypto.randomUUID()
    pendingSubmissionRef.current = { fingerprint, submissionId }
    await api.write(STORAGE_KEYS.pendingSubmission, { fingerprint, submissionId })
    try {
      await clientRef.current?.submit({
        submissionId,
        ...draft,
      })
      pendingSubmissionRef.current = null
      await api.remove([STORAGE_KEYS.pendingSubmission])
      void api.write(STORAGE_KEYS.lastWorkspaceId, workspaceId)
      setInstruction("")
      setState((current) => (current.kind === "ready" ? { ...current, captured: null } : current))
      // Both, because a submission changes both: the recent list gains a row,
      // and the target catalogue gains the conversation it just started. The
      // catalogue is only re-read here and on connect — it is a small list that
      // changes when the user does something, not on its own.
      const [page, capability] = await Promise.all([
        clientRef.current?.list(),
        clientRef.current?.capability().catch(() => undefined),
      ])
      setState((current) =>
        current.kind === "ready"
          ? {
              ...current,
              ...(page ? { recent: page.items } : {}),
              ...(capability && isCompatible(capability) ? { capability } : {}),
            }
          : current
      )
    } catch (error) {
      setSubmitError(
        api.message("submitFailed", [error instanceof Error ? error.message : String(error)])
      )
    } finally {
      setSubmitting(false)
    }
  }, [
    api,
    includeFullUrl,
    instruction,
    preferredTargetId,
    state,
    targetParams,
    wholePage,
    workspaceId,
  ])

  /**
   * Forget this browser entirely.
   *
   * The key goes first. If the two writes are interrupted between them, a
   * missing key with a surviving pairing record reads as unpaired (the panel
   * clears the stale record on next connect), whereas the reverse would leave
   * an orphaned key that nothing can ever use or delete.
   */
  const disconnect = useCallback(async () => {
    await clearDeviceKey()
    await api.remove(Object.values(STORAGE_KEYS))
    clientRef.current = null
    setState({ kind: "unpaired" })
  }, [api])

  /**
   * Forget the local conveniences but stay paired.
   *
   * The recent list is the Host's, not ours — it comes back on the next poll.
   * What this clears is the cached appearance and the remembered workspace,
   * which is what somebody handing over a laptop would want gone.
   */
  const clearLocal = useCallback(async () => {
    await api.remove([STORAGE_KEYS.appearance, STORAGE_KEYS.lastWorkspaceId])
  }, [api])

  if (state.kind === "loading") return <div className="p-4" data-testid="panel-loading" />

  if (state.kind === "storage-error") {
    return (
      <Notice
        testId="panel-storage-error"
        title={api.message("storageError")}
        detail={api.message("storageErrorHint")}
        action={api.message("retry")}
        onAction={() => void connect()}
      />
    )
  }

  if (state.kind === "unpaired" || state.kind === "pairing") {
    return (
      <PairScreen
        api={api}
        busy={state.kind === "pairing"}
        needsPermission={!hasPermission}
        failure={state.kind === "unpaired" ? state.failure : undefined}
        onSubmit={(code) => void onPair(code)}
      />
    )
  }

  if (state.kind === "revoked") {
    return (
      <Notice
        testId="panel-revoked"
        title={api.message("revoked")}
        action={api.message("reconnect")}
        onAction={() => setState({ kind: "unpaired" })}
      />
    )
  }

  if (state.kind === "incompatible") {
    return <Notice testId="panel-incompatible" title={api.message("incompatible")} />
  }

  if (state.kind === "host-offline") {
    return (
      <Notice
        testId="panel-offline"
        title={api.message("hostOffline")}
        detail={api.message("hostOfflineHint")}
        action={api.message("retry")}
        onAction={() => void connect()}
      />
    )
  }

  // Derived, not stored. The address the user is agreeing to is a function of
  // what was captured and whether they asked for the query string back — and
  // re-deriving it beats re-extracting the page, which could silently hand
  // back different text than the one they reviewed.
  const captured = state.captured ? withDisplayUrl(state.captured, includeFullUrl) : null
  const mode: BrowserCaptureMode = captured ? captureModeFor(captured, wholePage) : "metadata"
  // Derived at render rather than held in state, so changing the workspace can
  // never leave a target selected that the new workspace does not offer — the
  // Host would refuse that submission, correctly and inexplicably.
  const offeredTargets = targetsForWorkspace(state.capability.deliveryTargets, workspaceId)
  const targetId = selectedTargetId(offeredTargets, preferredTargetId)
  const selectedTarget = offeredTargets.find((target) => target.id === targetId)
  const paramsReady = targetParamsSatisfied(selectedTarget, targetParams)
  // A template supplies the instruction, so the free-text box is not the ask
  // for one — showing both would invite two instructions in one turn.
  const needsInstruction = selectedTarget?.kind !== "template"

  return (
    <div className="flex flex-col gap-4 p-3">
      <section className="space-y-2">
        <h1 className="text-sm font-semibold">{api.message("captureTitle")}</h1>
        {captured ? (
          <>
            <CapturePreview
              api={api}
              page={captured}
              mode={mode}
              limits={state.capability.limits}
              includeFullUrl={includeFullUrl}
              onToggleFullUrl={setIncludeFullUrl}
            />
            <div className="space-y-1.5">
              <Label htmlFor="cognia-workspace" className="text-xs text-muted-foreground">
                {api.message("workspaceLabel")}
              </Label>
              <Select value={workspaceId ?? undefined} onValueChange={setWorkspaceId}>
                <SelectTrigger
                  id="cognia-workspace"
                  className="w-full"
                  data-testid="workspace-select"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {state.capability.workspaces.map((workspace) => (
                    // The label is the item's only child on purpose: a nested
                    // element leaves the option with no accessible name, and a
                    // listbox of unnamed options is unusable by keyboard.
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Only when there is a choice. A Host that offers one target — an
                older one, or a browser that has started nothing yet — would
                otherwise get a dropdown whose every state is the same. */}
            {offeredTargets.length > 1 ? (
              <div className="space-y-1.5">
                <Label htmlFor="cognia-target" className="text-xs text-muted-foreground">
                  {api.message("targetLabel")}
                </Label>
                <Select
                  value={targetId ?? undefined}
                  onValueChange={(next) => {
                    setPreferredTargetId(next)
                    // Rebuilt rather than merged: carrying one template's
                    // answers into another's field of the same name would
                    // silently reuse a value nobody re-read.
                    setTargetParams(
                      initialTargetParams(
                        offeredTargets.find((target) => target.id === next)?.params
                      )
                    )
                  }}
                >
                  <SelectTrigger id="cognia-target" className="w-full" data-testid="target-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {offeredTargets.map((target) => (
                      // The label is the item's only child, as with workspaces:
                      // a nested element leaves the option with no accessible
                      // name and the listbox unusable by keyboard.
                      <SelectItem key={target.id} value={target.id}>
                        {targetLabel(target, api.message)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {selectedTarget?.params?.length ? (
              <div className="space-y-2" data-testid="target-params">
                <p className="text-xs text-muted-foreground">{api.message("targetParamsTitle")}</p>
                {selectedTarget.params.map((param) => (
                  <div key={param.id} className="space-y-1">
                    <Label
                      htmlFor={`cognia-param-${param.id}`}
                      className="text-xs text-muted-foreground"
                    >
                      {param.label}
                    </Label>
                    {param.kind === "enum" && param.options?.length ? (
                      <Select
                        value={targetParams[param.id] ?? undefined}
                        onValueChange={(next) =>
                          setTargetParams((current) => ({ ...current, [param.id]: next }))
                        }
                      >
                        <SelectTrigger
                          id={`cognia-param-${param.id}`}
                          className="w-full"
                          data-testid={`param-${param.id}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {param.options.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Textarea
                        id={`cognia-param-${param.id}`}
                        rows={param.multiline ? 3 : 1}
                        value={targetParams[param.id] ?? ""}
                        onChange={(event) =>
                          setTargetParams((current) => ({
                            ...current,
                            [param.id]: event.target.value,
                          }))
                        }
                        aria-label={param.label}
                        data-testid={`param-${param.id}`}
                      />
                    )}
                    {param.description ? (
                      <p className="text-[11px] text-muted-foreground">{param.description}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {needsInstruction ? (
              <Textarea
                rows={3}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder={api.message("instructionPlaceholder")}
                aria-label={api.message("instructionPlaceholder")}
                data-testid="instruction"
              />
            ) : null}
            <div className="flex items-center gap-2">
              <Button
                onClick={() => void onSubmit()}
                disabled={
                  submitting ||
                  !workspaceId ||
                  !paramsReady ||
                  (needsInstruction && !instruction.trim())
                }
                data-testid="submit"
              >
                {submitting ? api.message("submitting") : api.message("submit")}
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  setState((current) =>
                    current.kind === "ready" ? { ...current, captured: null } : current
                  )
                }
              >
                {api.message("clearCapture")}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="capture-empty">
            {api.message("captureEmpty")}
          </p>
        )}
        {/* Always offered, captured or not. Re-capturing is how a user sends
            the whole page after seeing that only their selection was picked
            up, and how they refresh a capture after the page changed under
            them. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={captured ? "outline" : "default"}
            size="sm"
            onClick={() => void runCapture(false)}
            data-testid="capture-now"
          >
            {captured ? api.message("captureRecapture") : api.message("captureNow")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void runCapture(true)}
            data-testid="capture-whole-page"
          >
            {api.message("captureWholePage")}
          </Button>
        </div>
        {submitError ? (
          <Alert variant="destructive" data-testid="submit-error">
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        ) : null}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {api.message("recentTitle")}
        </h2>
        <RecentList
          api={api}
          items={state.recent}
          failureCodes={failureCodes}
          answers={answers}
          expanded={expanded}
          onToggleAnswer={toggleAnswer}
          onStop={(submissionId) => void stopTask(submissionId)}
          stopping={stopping}
        />
      </section>

      <section className="space-y-1 border-t border-border pt-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {api.message("settingsTitle")}
        </h2>
        <p className="font-mono text-[11px] text-muted-foreground" data-testid="diagnostics">
          {api.message("diagnostics")}: {state.pairing.baseUrl}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="cognia-appearance" className="text-xs text-muted-foreground">
            {api.message("appearanceLabel")}
          </Label>
          <Select
            value={override}
            onValueChange={(next) => {
              if (!isAppearanceOverride(next)) return
              setOverride(next)
              void api.write(STORAGE_KEYS.appearanceOverride, next)
            }}
          >
            <SelectTrigger
              id="cognia-appearance"
              className="w-full"
              data-testid="appearance-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {APPEARANCE_OVERRIDES.map((option) => (
                <SelectItem key={option} value={option}>
                  {appearanceOverrideMessage(option, api.message)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void disconnect()}
            data-testid="disconnect"
          >
            {api.message("disconnect")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void clearLocal()}
            data-testid="clear-local"
          >
            {api.message("clearLocal")}
          </Button>
        </div>
      </section>
    </div>
  )
}

const EMPTY: BrowserContextSubmissionSummaryV1[] = []

/**
 * Whether this browser's system theme is dark.
 *
 * Guarded because `matchMedia` is absent in a jsdom test and, historically, in
 * some extension contexts. Defaulting to `false` there means "no preference
 * expressed", which leaves the Host's own setting standing rather than forcing
 * a mode nobody asked for.
 */
function prefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false
}

/**
 * The address as it will actually be sent.
 *
 * Derived at render rather than stored, so toggling "include the full address"
 * cannot drift from what was captured — and re-deriving beats re-extracting,
 * which could silently hand back different page text than the one the user
 * reviewed. A capture that no longer normalizes keeps the URL it was captured
 * with; the submit path re-checks the scheme anyway.
 */
function withDisplayUrl(page: CapturedPage, includeFullUrl: boolean): CapturedPage {
  const decision = normalizeCaptureUrl(page.rawUrl, includeFullUrl)
  return decision.ok ? { ...page, url: decision.url } : page
}

function Notice({
  testId,
  title,
  detail,
  action,
  onAction,
}: {
  testId: string
  title: string
  detail?: string
  action?: string
  onAction?: () => void
}) {
  return (
    <div className="space-y-2 p-4" data-testid={testId}>
      <Alert>
        <AlertTitle>{title}</AlertTitle>
        {detail ? <AlertDescription>{detail}</AlertDescription> : null}
      </Alert>
      {action && onAction ? (
        <Button variant="outline" onClick={onAction}>
          {action}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Cut text to a byte ceiling on a character boundary, and say whether it was
 * cut.
 *
 * Bytes, not characters, because that is the unit the contract is denominated
 * in — and the loop steps back a character at a time so a multi-byte
 * codepoint is never split into a replacement character.
 */
function clip(
  value: string | null,
  limitBytes: number
): { text: string; truncated: boolean } | null {
  if (!value) return null
  if (utf8ByteLength(value) <= limitBytes) return { text: value, truncated: false }
  let cut = value.length
  while (cut > 0 && utf8ByteLength(value.slice(0, cut)) > limitBytes) {
    cut = Math.max(0, cut - Math.ceil((utf8ByteLength(value.slice(0, cut)) - limitBytes) / 4) - 1)
  }
  return { text: value.slice(0, cut), truncated: true }
}
