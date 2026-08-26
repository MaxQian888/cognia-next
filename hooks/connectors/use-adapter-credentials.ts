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
  /** Re-run the read after a failure. */
  retry: () => void
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
 * operator could retry their way out of.
 *
 * The connector keyring arms are `target: service`, so a device-scoped caller
 * is rejected by the transport gate, the service-scope gate or the capability
 * gate depending on which plane it came in on — and a browser with no host at
 * all fails inside `@tauri-apps/api`. All of them mean the same thing to a
 * form: a value exists that this shell may not see.
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
      const fields: Record<string, FieldState> = {}
      let refused = false

      for (const name of accountList) {
        try {
          const stored = await connectorsKeyringGet(adapterId, name)
          fields[name] =
            stored === null || stored === ""
              ? { original: null, status: "unset" }
              : { original: stored, status: "loaded" }
        } catch (err) {
          const denied = isCredentialReadRefused(err)
          refused ||= denied
          fields[name] = { original: null, status: denied ? "stored" : "error" }
        }
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

      if (!cancelled) setRead({ identity, fields, derived, refused })
    })()

    return () => {
      cancelled = true
    }
  }, [wantsRead, adapterId, accountList, derivedList, identity, attempt])

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
    retry: () => setAttempt((n) => n + 1),
    refused: resolved?.refused ?? false,
  }
}

const EMPTY_EDITS: Record<string, string> = {}
