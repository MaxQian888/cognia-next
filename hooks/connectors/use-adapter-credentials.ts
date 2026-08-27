"use client"

/**
 * useAdapterCredentials — read back, edit and persist one adapter's keyring
 * credentials from a settings form.
 *
 * ## Why a hook and not eleven copies
 *
 * Every platform dialog used to hold `useState("")` per credential and write
 * `if (x.trim()) await connectorsKeyringSet(...)` on save. That made the
 * stored value invisible (nothing ever called `connectorsKeyringGet`), made
 * "clear this optional credential" impossible to express, and left each form
 * to invent its own answer for what happens on a host that cannot reach the
 * keyring at all.
 *
 * ## Two states, not one
 *
 * What the host said (`read`) and what the operator typed (`edits`) are kept
 * apart, each stamped with the adapter+accounts identity they belong to.
 * Everything else — the field value, its status, whether the form is dirty —
 * is derived from those two. That is what lets a dialog reopen on a different
 * adapter without a reset effect, and what makes "typed while the read was in
 * flight" a non-event instead of a merge.
 *
 * ## The write intents
 *
 * Prefilling changes what an empty box means, so the intent is derived from
 * the value AND the state it started in — never from emptiness alone:
 *
 *   - `unchanged` untouched, or equal to what was read back.
 *   - `set`       a non-empty value that differs from the original.
 *   - `clear`     a field we DID read back, deliberately emptied. Only
 *                 reachable when the original was readable, which is what
 *                 keeps "I could not read it, so I left it blank" from
 *                 silently deleting a working credential.
 *
 * ## Derived credentials
 *
 * OAuth-minted tokens (Slack `userToken`, Lark `user_token` /
 * `user_refresh_token`, Matrix `accessToken` / `refreshToken`) are never read
 * into the form. They are not operator input: a hand-edited access token is a
 * broken bot, and their presence is all a settings screen needs. They are
 * probed with `connectorsKeyringList` and reported through `derivedPresence`.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  connectorsKeyringDelete,
  connectorsKeyringGet,
  connectorsKeyringList,
  connectorsKeyringSet,
} from "@/lib/connectors/tauri/commands"
import {
  clearCredentialLease,
  credentialConsentCode,
  ensureCredentialLease,
} from "@/lib/connectors/credential-lease"
import { subscribeToHostConsent } from "@/lib/host-consent/client"
import { useCapability } from "@/hooks/use-host-profile"
// Type-only: the hook produces exactly the states the field renders, and
// sharing the union is what stops the two from drifting apart.
import type { CredentialFieldStatus } from "@/components/settings/connections/forms/_shared/credential-input"

/** What the operator's edit means for the stored value. */
export type CredentialWriteIntent = "unchanged" | "set" | "clear"

export interface UseAdapterCredentialsOptions {
  /** `null` for a create dialog — there is nothing stored to read. */
  adapterId: string | null
  /** Keyring account names the operator types in, in form order. */
  accounts: readonly string[]
  /**
   * OAuth-minted account names. Never read back; probed for presence only.
   * Defaults to none.
   */
  derivedAccounts?: readonly string[]
  /** Gate the read on dialog visibility so a closed form costs nothing. */
  enabled?: boolean
}

export interface UseAdapterCredentialsResult {
  /** Current editor value for `account`. */
  value: (account: string) => string
  /** Field state for `account`, ready to hand to `<CredentialInput status>`. */
  status: (account: string) => CredentialFieldStatus
  /** Record an edit. */
  set: (account: string, next: string) => void
  /** True when any credential would be written or cleared on save. */
  dirty: boolean
  /** Per-account write intent; the form uses it for validation messages. */
  intent: (account: string) => CredentialWriteIntent
  /**
   * Of `required`, the accounts that would hold no value after a save — a
   * create dialog left blank, or a stored value the operator emptied. A field
   * whose value could not be read is NOT missing: there is something there,
   * this shell just cannot see it.
   */
  missingRequired: (required: readonly string[]) => string[]
  /**
   * Apply every non-`unchanged` intent to the keyring. Takes the id explicitly
   * because a create dialog has none until the row has been inserted.
   */
  persist: (adapterId: string) => Promise<void>
  /** Whether a derived (OAuth) account currently has a stored value. */
  derivedPresence: (account: string) => boolean | undefined
  /** True while the initial read is in flight. */
  loading: boolean
  /**
   * Re-run the read, asking the host for consent again. Absent when there is
   * nothing to re-read — a create dialog, or a shell with no runtime to ask.
   */
  retry?: () => void
  /**
   * Set when the host refused the read rather than failing — the form shows
   * this instead of the generic "saved on the host" line.
   */
  refused: boolean
}

interface FieldState {
  /** What the host returned: a string, or `null` when nothing is stored. */
  original: string | null
  status: CredentialFieldStatus
}

interface ReadState {
  identity: string
  /** True when the host is waiting on a human before it will answer at all. */
  awaitingConsent: boolean
  fields: Record<string, FieldState>
  derived: Record<string, boolean>
  refused: boolean
}

interface EditState {
  identity: string
  values: Record<string, string>
}

/**
 * Refusals are policy, not faults, and must not render as an error the
 * operator could retry their way out of — though some of them the operator
 * CAN consent their way out of, which is what the unlock affordance is for.
 *
 * Since ADR-0152 the keyring arms are `target: host-admin`, so a paired device
 * is turned away by the admin-lease gate (`REMOTE_CONSENT_REQUIRED`) rather
 * than by the service-scope gate — but the older shapes stay listed, because
 * a device talking to a host that predates the change still meets them, as
 * does a browser with no host at all failing inside `@tauri-apps/api`. All of
 * them mean the same thing to a form: a value exists that this shell may not
 * see.
 */
export function isCredentialReadRefused(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "")
  return [
    "command_transport_forbidden",
    "remote_control_forbidden",
    "missing_capability",
    "REMOTE_SCOPE_DENIED",
    "REMOTE_CONSENT_REQUIRED",
    "requires the headless service token",
    "__TAURI_INTERNALS__",
    "tauri-only command from web mode",
  ].some((needle) => message.includes(needle))
}

export function useAdapterCredentials({
  adapterId,
  accounts,
  derivedAccounts,
  enabled = true,
}: UseAdapterCredentialsOptions): UseAdapterCredentialsResult {
  const connectorRuntime = useCapability("connector-runtime")

  // Join/split rather than holding the arrays: every caller passes an inline
  // literal, so identity changes on every render and a raw dependency would
  // re-run the read forever.
  const accountKey = accounts.join(" ")
  const derivedKey = (derivedAccounts ?? []).join(" ")
  const accountList = useMemo(() => accountKey.split(" ").filter(Boolean), [accountKey])
  const derivedList = useMemo(() => derivedKey.split(" ").filter(Boolean), [derivedKey])

  // Length-prefixed rather than separator-joined: an adapter id is opaque,
  // so any separator character could in principle occur inside one and make
  // two different (adapter, accounts) pairs collide onto one identity.
  const identity = `${(adapterId ?? "").length}:${adapterId ?? ""}:${accountKey}`

  const [read, setRead] = useState<ReadState | null>(null)
  const [edits, setEdits] = useState<EditState>({ identity, values: {} })
  const [attempt, setAttempt] = useState(0)

  // Stamped state means a stale answer is simply not the current one — no
  // reset effect, no ref written during render.
  const resolved = read?.identity === identity ? read : null
  const typed = edits.identity === identity ? edits.values : EMPTY_EDITS

  // Derived accounts are probed even when there is no editable field at all:
  // WeChat Personal has only a QR login, and whether a token is stored is the
  // only honest answer to "is this bot signed in".
  const wantsRead =
    enabled && Boolean(adapterId) && accountList.length + derivedList.length > 0 && connectorRuntime
  const loading = wantsRead && !resolved

  useEffect(() => {
    if (!wantsRead || !adapterId) return

    let cancelled = false

    void (async () => {
      // Before the first read, not after a failure: on a companion the reads
      // below are device-plane RPCs, and without a lease every one of them
      // comes back refused. `ensureCredentialLease` is a cache hit for the
      // second dialog and a no-op wherever the keyring is local.
      await ensureCredentialLease()
      // "The host is waiting for a human" ends by itself; "this shell may not
      // see it" does not. Reading the distinction here rather than from the
      // keyring error keeps it out of every per-field catch below.
      const awaitingConsent = credentialConsentCode() !== null

      const fields: Record<string, FieldState> = {}
      let refused = false

      // One pass, not one round trip per field. The reads are independent, and
      // `dirty` is gated on `!loading`, so a sequential loop left Save inert
      // for the SUM of five round trips on Slack and four on Lark — seconds of
      // it over the companion transport, where each hop is a network request
      // rather than a local IPC. Each field keeps its own try/catch, so one
      // refused read still lands as `stored` next to four that loaded.
      const results = await Promise.all(
        accountList.map(async (name): Promise<[string, FieldState, boolean]> => {
          try {
            const stored = await connectorsKeyringGet(adapterId, name)
            return [
              name,
              stored === null || stored === ""
                ? { original: null, status: "unset" }
                : { original: stored, status: "loaded" },
              false,
            ]
          } catch (err) {
            const denied = isCredentialReadRefused(err)
            const status: CredentialFieldStatus = denied
              ? awaitingConsent
                ? "awaiting-consent"
                : "stored"
              : "error"
            return [name, { original: null, status }, denied]
          }
        })
      )
      for (const [name, state, denied] of results) {
        fields[name] = state
        refused ||= denied
      }

      let derived: Record<string, boolean> = {}
      if (derivedList.length > 0) {
        try {
          const found = await connectorsKeyringList(adapterId, derivedList)
          derived = Object.fromEntries(derivedList.map((n) => [n, found.includes(n)]))
        } catch {
          // Presence is decoration; a failed probe leaves it unknown rather
          // than claiming the token is missing.
          derived = {}
        }
      }

      if (!cancelled) setRead({ identity, awaitingConsent, fields, derived, refused })
    })()

    return () => {
      cancelled = true
    }
  }, [wantsRead, adapterId, accountList, derivedList, identity, attempt])

  // An approval arrives out of band, on someone else's screen. Without this the
  // operator would be told "waiting for approval", watch it be granted, and
  // still face an unchanged form until they thought to press retry — and the
  // refusal cooldown would make even that a no-op for thirty seconds.
  //
  // Any approval is worth a retry: a device does not know its own id, the read
  // is idempotent, and the worst case is one wasted round trip.
  useEffect(() => {
    if (!resolved?.awaitingConsent) return
    return subscribeToHostConsent((request) => {
      if (request.state !== "approved") return
      clearCredentialLease()
      setAttempt((n) => n + 1)
    })
  }, [resolved?.awaitingConsent])

  const statusFor = useCallback(
    (account: string): CredentialFieldStatus => {
      if (!adapterId) return "new"
      // A stored value may well exist; we simply have no way to ask on this
      // host. Say so rather than probing and rendering the failure as a fault.
      if (!connectorRuntime) return "stored"
      const field = resolved?.fields[account]
      if (!field) return loading ? "loading" : "stored"
      // A field read back as unset but since typed into reads as a fresh
      // entry, not as an empty saved one.
      return field.status
    },
    [adapterId, connectorRuntime, resolved, loading]
  )

  const intentFor = useCallback(
    (account: string): CredentialWriteIntent => {
      const entered = typed[account]
      if (entered === undefined) return "unchanged"
      const next = entered.trim()
      const original = resolved?.fields[account]?.original ?? null
      // `original === null` covers both "nothing stored" and "could not read
      // it": in neither case may an empty box mean delete.
      if (original === null) return next ? "set" : "unchanged"
      if (next === original) return "unchanged"
      return next ? "set" : "clear"
    },
    [typed, resolved]
  )

  const dirty = useMemo(
    () => accountList.some((name) => intentFor(name) !== "unchanged"),
    [accountList, intentFor]
  )

  // Re-reading only means something when there is a stored value to re-read
  // and a runtime that could serve it.
  const retryable = Boolean(adapterId) && connectorRuntime

  const missingRequired = useCallback(
    (required: readonly string[]) =>
      required.filter((name) => {
        const decision = intentFor(name)
        if (decision === "clear") return true
        if (decision === "set") return false
        // Create dialog: nothing is stored, so the typed value is all there is.
        if (!adapterId) return !(typed[name] ?? "").trim()
        // Untouched on an existing adapter. Missing only when the read
        // SUCCEEDED and found nothing — `stored` and `error` mean a value may
        // well be there, and blocking a save on what we could not see would
        // strand every remote operator.
        return resolved?.fields[name]?.status === "unset"
      }),
    [adapterId, intentFor, typed, resolved]
  )

  const set = useCallback(
    (account: string, next: string) => {
      setEdits((prev) => {
        const base = prev.identity === identity ? prev.values : {}
        return { identity, values: { ...base, [account]: next } }
      })
    },
    [identity]
  )

  const persist = useCallback(
    async (targetId: string) => {
      // A form can sit open longer than a lease lives; re-acquiring here costs
      // nothing when the cached one is still good and is the difference
      // between a save that lands and one that is refused at the gate.
      await ensureCredentialLease()
      for (const name of accountList) {
        const decision = intentFor(name)
        if (decision === "set") await connectorsKeyringSet(targetId, name, typed[name].trim())
        else if (decision === "clear") await connectorsKeyringDelete(targetId, name)
      }
    },
    [accountList, intentFor, typed]
  )

  return {
    value: (account) => typed[account] ?? resolved?.fields[account]?.original ?? "",
    status: statusFor,
    set,
    dirty,
    intent: intentFor,
    missingRequired,
    persist,
    derivedPresence: (account) => resolved?.derived[account],
    loading,
    // Undefined rather than a no-op when nothing could change: a standalone
    // browser has no host to ask, and offering "unlock" there would be an
    // affordance that cannot work. Every form spreads this straight onto
    // `CredentialInput.onRetry`, so the control simply is not rendered.
    retry: retryable
      ? () => {
          // An explicit retry is the operator asking again, so it must clear
          // the refusal cooldown as well as the token — otherwise the second
          // click would be answered from cache for the next thirty seconds.
          clearCredentialLease()
          setAttempt((n) => n + 1)
        }
      : undefined,
    refused: resolved?.refused ?? false,
  }
}

const EMPTY_EDITS: Record<string, string> = {}
