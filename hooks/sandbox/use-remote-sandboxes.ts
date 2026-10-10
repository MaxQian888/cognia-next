"use client"

/**
 * The desktop's "Remote sandboxes" settings, as one state (ADR-0221 G7).
 *
 * Every write sends the whole document (`remote_sandboxes_set`) and takes the
 * view the Host answers with, so the page always shows what is on disk and
 * which credentials are stored — never a local guess of either. Writes are
 * built here from the current view, so a provider edit, a removal, a new
 * default and an allowlist change cannot clobber each other's fields.
 *
 * Saved settings apply at the next app start (`restartRequired`): the pool is
 * installed once at startup and a running one is never torn down under live
 * sandboxes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  environmentDriverStatus,
  isPoolDisabled,
} from "@/lib/project-environment/environment-client"
import {
  providerCredentialSecretId,
  remoteSandboxesGet,
  remoteSandboxesSet,
  withoutProvider,
} from "@/lib/sandbox/remote-sandboxes-client"
import {
  normalizeRegistryRules,
  providerFromDraft,
  validateProviderDraft,
  validateRegistryRules,
  type ProviderDraft,
} from "@/lib/sandbox/remote-sandbox-draft"
import { parseInvokeError } from "@/lib/tauri/command-error"
import type {
  DesktopRemoteSandboxes,
  RegistryRule,
  RemoteSandboxesView,
  SandboxProviderConfig,
  SandboxProviderView,
} from "@/types/sandbox/remote-sandboxes"

export interface RemoteSandboxesProblem {
  code: string
  message: string
}

export type RemoteSandboxesWriteResult =
  { ok: true } | { ok: false; problem: RemoteSandboxesProblem }

/**
 * What the pool running in this app reports about its providers — the live
 * half of the page, read from `environment_driver_status`. The settings are
 * what the next start installs; this is what the current one did.
 *
 * - `off`: no pool is running (none was configured at startup, or the build
 *   has no pinned bundle).
 * - `providers`: the running pool's remote providers, each with whether it
 *   answered and how much of its limit is in use.
 * - `unreadable`: the pool is running and its status could not be read.
 */
export type RunningPool =
  | { kind: "off" }
  | { kind: "providers"; providers: SandboxProviderView[] }
  | { kind: "unreadable"; problem: RemoteSandboxesProblem }

export interface RemoteSandboxesState {
  status: "loading" | "ready" | "failed"
  view?: RemoteSandboxesView
  /** Absent until the first read. */
  running?: RunningPool
  loadProblem?: RemoteSandboxesProblem
  busy: boolean
}

export interface RemoteSandboxesActions {
  reload(): Promise<void>
  /** Add a provider (`editingId` absent) or replace the one with `editingId`. */
  saveProvider(draft: ProviderDraft, editingId?: string): Promise<RemoteSandboxesWriteResult>
  removeProvider(id: string): Promise<RemoteSandboxesWriteResult>
  /** The provider `auto` placement uses; `undefined` clears the choice. */
  setDefaultProvider(id: string | undefined): Promise<RemoteSandboxesWriteResult>
  saveRegistryAllowlist(rules: RegistryRule[]): Promise<RemoteSandboxesWriteResult>
}

function problemOf(cause: unknown): RemoteSandboxesProblem {
  const { code, message } = parseInvokeError(cause)
  return { code, message }
}

function withProviders(
  settings: DesktopRemoteSandboxes,
  providers: SandboxProviderConfig[],
  defaultProviderId: string | undefined
): DesktopRemoteSandboxes {
  const keptDefault =
    defaultProviderId && providers.some((provider) => provider.id === defaultProviderId)
      ? defaultProviderId
      : undefined
  return {
    ...settings,
    providers: {
      version: 1,
      providers,
      ...(keptDefault ? { defaultProviderId: keptDefault } : {}),
    },
  }
}

/**
 * Drop deletions of secrets another provider still reads. Two providers can
 * share a credential only through a hand-edited file, and a save must not
 * pull it out from under the one this edit did not touch.
 */
function withoutSharedDeletes(
  secrets: Record<string, string | null>,
  providers: readonly SandboxProviderConfig[]
): Record<string, string | null> {
  const referenced = new Set(
    providers.map(providerCredentialSecretId).filter((id): id is string => id !== undefined)
  )
  return Object.fromEntries(
    Object.entries(secrets).filter(([id, value]) => value !== null || !referenced.has(id))
  )
}

async function readRunningPool(): Promise<RunningPool> {
  try {
    const status = await environmentDriverStatus()
    return {
      kind: "providers",
      providers: (status.providers ?? []).filter((provider) => provider.remote),
    }
  } catch (cause) {
    return isPoolDisabled(cause)
      ? { kind: "off" }
      : { kind: "unreadable", problem: problemOf(cause) }
  }
}

export function useRemoteSandboxes(): RemoteSandboxesState & RemoteSandboxesActions {
  const [state, setState] = useState<RemoteSandboxesState>({ status: "loading", busy: false })
  // The view writes are built from. A ref, so two writes in one tick build on
  // the same document rather than on a render that has not happened yet.
  const viewRef = useRef<RemoteSandboxesView | undefined>(undefined)

  const read = useCallback(
    () =>
      Promise.all([remoteSandboxesGet(), readRunningPool()]).then(
        ([view, running]) => {
          viewRef.current = view
          setState({ status: "ready", view, running, busy: false })
        },
        (cause: unknown) => {
          // A failed reload keeps the page it already has on screen.
          setState((prev) => ({
            ...prev,
            status: prev.view ? prev.status : "failed",
            loadProblem: problemOf(cause),
            busy: false,
          }))
        }
      ),
    []
  )

  useEffect(() => {
    void read()
  }, [read])

  const reload = useCallback(async () => {
    setState((prev) => ({ ...prev, busy: true }))
    await read()
  }, [read])

  const write = useCallback(
    async (
      build: (
        view: RemoteSandboxesView
      ) =>
        | { settings: DesktopRemoteSandboxes; secrets?: Record<string, string | null> }
        | RemoteSandboxesProblem
    ): Promise<RemoteSandboxesWriteResult> => {
      const current = viewRef.current
      if (!current) {
        return { ok: false, problem: { code: "remote_sandboxes_unreadable", message: "" } }
      }
      const update = build(current)
      if ("code" in update) return { ok: false, problem: update }
      setState((prev) => ({ ...prev, busy: true }))
      try {
        const view = await remoteSandboxesSet({
          settings: update.settings,
          ...(update.secrets && Object.keys(update.secrets).length > 0
            ? { secrets: update.secrets }
            : {}),
        })
        viewRef.current = view
        // A save changes the next start, not the running pool.
        setState((prev) => ({ ...prev, status: "ready", view, busy: false }))
        return { ok: true }
      } catch (cause) {
        setState((prev) => ({ ...prev, busy: false }))
        return { ok: false, problem: problemOf(cause) }
      }
    },
    []
  )

  const saveProvider = useCallback(
    (draft: ProviderDraft, editingId?: string) =>
      write((view) => {
        const providers = view.settings.providers.providers
        const context = {
          existingIds: providers.map((provider) => provider.id),
          ...(editingId !== undefined ? { editingId } : {}),
          storedSecretIds: view.storedSecretIds,
        }
        const built = providerFromDraft(draft, context)
        if (!built) {
          // The editor disables Save while the form has problems; this is
          // the backstop for a caller that did not.
          const [first] = validateProviderDraft(draft, context)
          return { code: "remote_sandboxes_invalid", message: first?.field ?? "" }
        }
        const next =
          editingId === undefined
            ? [...providers, built.provider]
            : providers.map((provider) => (provider.id === editingId ? built.provider : provider))
        // A renamed default stays the default under its new name.
        const currentDefault = view.settings.providers.defaultProviderId
        const nextDefault =
          editingId !== undefined && currentDefault === editingId
            ? built.provider.id
            : currentDefault
        return {
          settings: withProviders(view.settings, next, nextDefault),
          secrets: withoutSharedDeletes(built.secrets, next),
        }
      }),
    [write]
  )

  const removeProvider = useCallback(
    (id: string) => write((view) => withoutProvider(view.settings, id)),
    [write]
  )

  const setDefaultProvider = useCallback(
    (id: string | undefined) =>
      write((view) => ({
        settings: withProviders(view.settings, view.settings.providers.providers, id),
      })),
    [write]
  )

  const saveRegistryAllowlist = useCallback(
    (rules: RegistryRule[]) =>
      write((view) => {
        const problems = validateRegistryRules(rules)
        if (problems.size > 0) {
          const [[index, code]] = [...problems.entries()]
          return { code: "remote_sandboxes_registry_invalid", message: `${index + 1}: ${code}` }
        }
        return {
          settings: { ...view.settings, registryAllowlist: normalizeRegistryRules(rules) },
        }
      }),
    [write]
  )

  return useMemo(
    () => ({
      ...state,
      reload,
      saveProvider,
      removeProvider,
      setDefaultProvider,
      saveRegistryAllowlist,
    }),
    [state, reload, saveProvider, removeProvider, setDefaultProvider, saveRegistryAllowlist]
  )
}
