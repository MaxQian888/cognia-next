"use client"

/**
 * Email subscription writes for the public status page (plan §10).
 *
 * - `useSubscribe` posts a signup. The 202 answer is deliberately generic:
 *   it means "if this address can be subscribed, a confirmation was queued",
 *   never "subscribed", so the UI says exactly that.
 * - `useTokenAction` handles the confirm / manage / unsubscribe links. Tokens
 *   arrive in the URL fragment (never sent to a server by the browser), are
 *   read once and cleared from the address bar immediately, and are only
 *   ever sent in a POST body. Confirming and unsubscribing need an explicit
 *   button press, so a mail scanner that renders the page changes nothing;
 *   reading preferences for the manage form is a non-mutating POST.
 *
 * Only the primary runtime may post (`runtime.allowsConsentWrites`). A mirror
 * or the in-app route never posts: the page sends the reader to the primary
 * status page instead.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import {
  parseConfirmResult,
  parseManageResult,
  parseStatusTokenFragment,
  statusApiUrl,
  SUBSCRIPTION_CONSENT_VERSION,
  type ComponentId,
  type ParseResult,
  type StatusLocale,
  type StatusRuntime,
  type StatusTokenAction,
  type SubscriptionPreferences,
} from "@/lib/status/public-status"

import {
  isAbortError,
  statusLiteralParser,
  statusPost,
  StatusRequestError,
} from "./status-transport"

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type StatusActionErrorKind =
  | "token_invalid"
  | "token_expired"
  | "token_used"
  | "revision_conflict"
  | "rate_limited"
  | "unavailable"
  | "forbidden"
  | "bad_request"
  | "network"
  | "invalid"

/** Map any failure of a subscription write to a bounded, translatable kind. */
export function classifyStatusActionError(error: unknown): StatusActionErrorKind {
  if (!(error instanceof StatusRequestError)) return "network"
  if (error.kind === "network" || error.kind === "timeout") return "network"
  if (error.kind === "invalid" || error.kind === "unsupported") return "invalid"
  switch (error.code) {
    case "token_invalid":
    case "token_expired":
    case "token_used":
    case "revision_conflict":
    case "rate_limited":
    case "unavailable":
    case "forbidden":
      return error.code
    case "bad_request":
    case "body_too_large":
      return "bad_request"
    default:
      break
  }
  switch (error.status) {
    case 400:
      return "bad_request"
    case 403:
      return "forbidden"
    case 409:
      return "revision_conflict"
    case 410:
      return "token_expired"
    case 429:
      return "rate_limited"
    default:
      return "unavailable"
  }
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

export type SubscribeState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "pending" }
  | { phase: "error"; kind: StatusActionErrorKind }

export interface SubscribeInput {
  email: string
  locale: StatusLocale
  /** Empty means every component. */
  componentIds: ComponentId[]
}

const acceptedParser = statusLiteralParser("accepted")
const unsubscribedParser = statusLiteralParser("unsubscribed")

export function useSubscribe(runtime: StatusRuntime | null) {
  const [state, setState] = useState<SubscribeState>({ phase: "idle" })
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  const submit = useCallback(
    (input: SubscribeInput) => {
      if (!runtime?.allowsConsentWrites || controllerRef.current) return
      const controller = new AbortController()
      controllerRef.current = controller
      setState({ phase: "submitting" })
      statusPost(
        statusApiUrl(runtime.apiBase, "/subscriptions"),
        {
          email: input.email.trim(),
          locale: input.locale,
          componentIds: input.componentIds,
          consentVersion: SUBSCRIPTION_CONSENT_VERSION,
        },
        acceptedParser,
        { signal: controller.signal }
      ).then(
        () => {
          if (controller.signal.aborted) return
          controllerRef.current = null
          setState({ phase: "pending" })
        },
        (caught: unknown) => {
          if (controller.signal.aborted || isAbortError(caught)) return
          controllerRef.current = null
          setState({ phase: "error", kind: classifyStatusActionError(caught) })
        }
      )
    },
    [runtime]
  )

  const reset = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setState({ phase: "idle" })
  }, [])

  return { state, submit, reset }
}

// ---------------------------------------------------------------------------
// Token links
// ---------------------------------------------------------------------------

export type TokenFragment =
  | { kind: "valid"; action: StatusTokenAction; token: string }
  /** The fragment carried token parameters that do not form a usable link. */
  | { kind: "malformed" }

/** Classify `location.hash`; null when it carries no token parameters. */
export function readTokenFragment(hash: string): TokenFragment | null {
  const parsed = parseStatusTokenFragment(hash)
  if (parsed) return { kind: "valid", ...parsed }
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash)
  return params.has("token") || params.has("action") ? { kind: "malformed" } : null
}

/** Remove the fragment, keeping path and query (the incident deep link). */
export function clearLocationFragment(): void {
  const { pathname, search } = window.location
  window.history.replaceState(window.history.state, "", `${pathname}${search}`)
}

export type TokenFlowState =
  /** Waiting for the reader to press the confirm / unsubscribe button. */
  | { phase: "ready" }
  | { phase: "working" }
  | { phase: "confirmed"; preferences: SubscriptionPreferences }
  | {
      phase: "preferences"
      preferences: SubscriptionPreferences
      notice: "saved" | "conflict" | null
      saving: boolean
      saveError: StatusActionErrorKind | null
    }
  | { phase: "unsubscribed" }
  | { phase: "error"; kind: StatusActionErrorKind }

export interface TokenActionState {
  fragment: TokenFragment | null
  /** The dialog was closed by the reader. */
  dismissed: boolean
  state: TokenFlowState
  confirm: () => void
  unsubscribe: () => void
  savePreferences: (input: { locale: StatusLocale; componentIds: ComponentId[] }) => void
  dismiss: () => void
}

export function useTokenAction(runtime: StatusRuntime | null): TokenActionState {
  const [fragment] = useState<TokenFragment | null>(() =>
    typeof window === "undefined" ? null : readTokenFragment(window.location.hash)
  )
  const [dismissed, setDismissed] = useState(false)
  const [state, setState] = useState<TokenFlowState>(() =>
    fragment?.kind === "valid" && fragment.action === "manage" && runtime?.allowsConsentWrites
      ? { phase: "working" }
      : { phase: "ready" }
  )
  const controllerRef = useRef<AbortController | null>(null)

  // The token must not linger in the address bar, history or a shared URL.
  useEffect(() => {
    if (fragment) clearLocationFragment()
  }, [fragment])

  useEffect(() => () => controllerRef.current?.abort(), [])

  const valid = fragment?.kind === "valid" ? fragment : null
  const canWrite = Boolean(runtime?.allowsConsentWrites && valid)
  const apiBase = runtime?.apiBase ?? null

  const post = useCallback(
    <T>(
      path: string,
      body: unknown,
      parse: (value: unknown) => ParseResult<T>,
      onDone: (value: T) => void,
      onError: (kind: StatusActionErrorKind) => void
    ) => {
      if (apiBase === null) return
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller
      statusPost(statusApiUrl(apiBase, path), body, parse, { signal: controller.signal }).then(
        ({ value }) => {
          if (controller.signal.aborted) return
          controllerRef.current = null
          onDone(value)
        },
        (caught: unknown) => {
          if (controller.signal.aborted || isAbortError(caught)) return
          controllerRef.current = null
          onError(classifyStatusActionError(caught))
        }
      )
    },
    [apiBase]
  )

  const readPreferences = useCallback(
    (notice: "conflict" | null) => {
      if (!valid) return
      post(
        "/subscriptions/manage",
        { token: valid.token, operation: "read" },
        parseManageResult,
        (value) =>
          setState({
            phase: "preferences",
            preferences: value.preferences,
            notice,
            saving: false,
            saveError: null,
          }),
        (kind) => setState({ phase: "error", kind })
      )
    },
    [post, valid]
  )

  // Manage links load the current preferences right away: a read changes
  // nothing, unlike confirm and unsubscribe, which wait for a button press.
  const manageToken = canWrite && valid?.action === "manage" ? valid.token : null
  useEffect(() => {
    if (manageToken === null) return
    readPreferences(null)
    // readPreferences is stable for a given token; run once per token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manageToken])

  const confirm = useCallback(() => {
    if (!canWrite || !valid || valid.action !== "confirm") return
    setState({ phase: "working" })
    post(
      "/subscriptions/confirm",
      { token: valid.token },
      parseConfirmResult,
      (value) => setState({ phase: "confirmed", preferences: value.preferences }),
      (kind) => setState({ phase: "error", kind })
    )
  }, [canWrite, post, valid])

  const unsubscribe = useCallback(() => {
    if (!canWrite || !valid || valid.action !== "unsubscribe") return
    setState({ phase: "working" })
    post(
      "/subscriptions/unsubscribe",
      { token: valid.token },
      unsubscribedParser,
      () => setState({ phase: "unsubscribed" }),
      (kind) => setState({ phase: "error", kind })
    )
  }, [canWrite, post, valid])

  const savePreferences = useCallback(
    (input: { locale: StatusLocale; componentIds: ComponentId[] }) => {
      if (!canWrite || !valid || valid.action !== "manage") return
      if (state.phase !== "preferences" || state.saving) return
      const expectedRevision = state.preferences.revision
      setState({ ...state, saving: true, saveError: null, notice: null })
      post(
        "/subscriptions/manage",
        {
          token: valid.token,
          operation: "update",
          expectedRevision,
          locale: input.locale,
          componentIds: input.componentIds,
        },
        parseManageResult,
        (value) =>
          setState({
            phase: "preferences",
            preferences: value.preferences,
            notice: "saved",
            saving: false,
            saveError: null,
          }),
        (kind) => {
          if (kind === "revision_conflict") {
            // Someone changed the preferences elsewhere: show the current
            // version instead of overwriting it.
            readPreferences("conflict")
            return
          }
          setState((previous) =>
            previous.phase === "preferences"
              ? { ...previous, saving: false, saveError: kind }
              : { phase: "error", kind }
          )
        }
      )
    },
    [canWrite, post, readPreferences, state, valid]
  )

  const dismiss = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setDismissed(true)
  }, [])

  return { fragment, dismissed, state, confirm, unsubscribe, savePreferences, dismiss }
}
