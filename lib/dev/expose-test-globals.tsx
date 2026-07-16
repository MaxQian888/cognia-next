"use client"

/**
 * Dev-only bridge that hangs E2E test helpers off `window`. Mounts at the
 * root of `app/layout.tsx` and no-ops in production builds. The Playwright
 * specs in `tests/e2e/` invoke these from page context to seed and reset
 * client-side state without re-implementing the Dexie + companion-storage
 * APIs in JavaScript fixtures.
 *
 * Gating: `process.env.NEXT_PUBLIC_E2E === "1"`. The Playwright config
 * injects this env var when it boots `pnpm dev`; if you run `pnpm dev`
 * manually you can set it yourself. Production bundles never include this
 * code path because the gate is dead-code-eliminated at build time.
 */

import { useEffect } from "react"
import type { SeededWorkflowKind } from "./workflow-fixtures"

export type MockBaseUrls = {
  anthropic?: string
  github?: string
  lark?: string
  vectorDb?: string
}

declare global {
  interface Window {
    __cogniaResetDb?: () => Promise<void>
    __cogniaSeedWorkflow?: (kind: SeededWorkflowKind) => Promise<string>
    __cogniaSeedRawWorkflow?: (draft: unknown) => Promise<string>
    __cogniaReadRuns?: (workflowId: string) => Promise<
      Array<{
        id: string
        status: string
        startedAt?: number
        completedAt?: number
        error?: unknown
        events: Array<Record<string, unknown>>
      }>
    >
    __cogniaSeedCharacter?: (draft: {
      name: string
      role?: string
      systemPrompt?: string
    }) => Promise<string>
    __cogniaSeedTeam?: (draft: { name: string; description?: string }) => Promise<string>
    __cogniaSeedSkill?: (draft: {
      name: string
      trigger?: string
      body?: string
    }) => Promise<string>
    __cogniaSeedConnectorDraft?: (draft: {
      adapterId: string
      conversationKey: string
      content: string
    }) => Promise<string>
    __cogniaEnqueueOutbound?: (job: { command: string; payload?: unknown }) => Promise<string>
    __cogniaSeedRun?: (
      workflowId: string,
      status?: "succeeded" | "failed" | "running"
    ) => Promise<string>
    __cogniaSetMockBaseUrls?: (urls: MockBaseUrls) => Promise<void>
    __cogniaMockBaseUrls?: MockBaseUrls
    /**
     * Captures URLs that the renderer asks the OS to open. When set, the
     * native `openUrl` helper invokes this instead of dispatching to the
     * Tauri opener plugin — specs use it to assert the OAuth authorize
     * URL was built correctly without popping a real browser window.
     */
    __cogniaE2EOpenUrl?: (url: string) => void
    __cogniaE2EOpenUrlCalls?: string[]
    /**
     * Wipe every persisted subscription account across all providers and
     * clear the active-account pointer. Keyring entries survive
     * `__cogniaResetDb` because they live outside Dexie, so subscription
     * specs call this to keep the in-process vault clean between tests.
     */
    __cogniaResetSubscriptionState?: () => Promise<void>
    /**
     * E2E override consulted by `discoverCodexAuth`. When set (even to
     * `null`) the renderer skips the Rust `codex_oauth_discover` command
     * and returns the override verbatim — lets specs drive the codex
     * "Reuse" adopt flow without writing to `~/.codex/auth.json`.
     */
    __cogniaE2ECodexDiscovery?: unknown
    /**
     * E2E short-circuit for `lib/ocr/extract()`. When set to a function,
     * `extract()` skips provider selection / cache / credentials entirely
     * and returns whatever the mock produces. Specs use this to drive UI
     * flow without depending on cloud keys or native binaries.
     */
    __cogniaE2EOcrMock?: (input: unknown) => unknown
    __cogniaSaveCompanionConfig?: (config: {
      baseUrl: string
      deviceJwt: string
      deviceId: string
      serverVersion: string
      serverFingerprint?: string
    }) => Promise<void>
    __cogniaClearCompanionConfig?: () => Promise<void>
    /**
     * Patch the AppSettings singleton through the settings store (memory +
     * Dexie). Specs need this because `__cogniaResetDb` wipes the settings
     * row, and on the Capacitor shell an unset `mobileRuntimeMode` makes
     * CompanionBootProvider bounce every route to /welcome — mobile specs
     * seed `{ mobileRuntimeMode: "standalone" }` (or "paired") right after
     * a reset. Also the only way specs can flip policy toggles like
     * `biometricRequiredFor` that have no dedicated onboarding UI hook.
     */
    __cogniaSetSettings?: (patch: Record<string, unknown>) => Promise<void>
    __cogniaTestGlobalsReady?: boolean
  }
}

export function ExposeTestGlobals(): null {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_E2E !== "1") return
    if (typeof window === "undefined") return

    let cancelled = false

    void (async () => {
      const [
        { __resetDbForTesting, getDb, whenSeeded, activateAccountDatabase },
        // Route through the transport module, NOT companionStorage() directly:
        // the transport's hot path reads a module-level in-memory cache that
        // only saveCompanionConfig/clearCompanionConfig update. A raw storage
        // write leaves that cache null and every transport.call() rejects
        // with not_paired even though storage holds the config.
        { saveCompanionConfig, clearCompanionConfig },
        { buildWorkflowFixture },
      ] = await Promise.all([
        import("@/lib/db/schema"),
        import("@/lib/tauri/transport-companion"),
        import("./workflow-fixtures"),
      ])

      const ACCOUNT_DB_PREFIX = "cognia-account-"

      window.__cogniaResetDb = async () => {
        // The main Dexie db is account-scoped (`cognia-account-<id>`). Capture
        // the active db BEFORE the reset so we can re-point at the same account
        // afterwards: `__resetDbForTesting()` clears the active selection, so a
        // bare `getDb()` would fall back to the LEGACY db and seed data would
        // land where the (account-scoped) app never reads it.
        const prevName = getDb().name
        try {
          await getDb().delete()
        } catch {
          // DatabaseClosedError is normal during repeated resets; the cache
          // drop below recovers.
        }
        __resetDbForTesting()
        if (prevName.startsWith(ACCOUNT_DB_PREFIX)) {
          activateAccountDatabase(prevName.slice(ACCOUNT_DB_PREFIX.length))
        }
        getDb()
        await whenSeeded()
        const db = getDb()
        await db.workflows.clear()
        await db.workflowRuns.clear()
        await db.workflowTriggers.clear()
        await db.workflowRunEvents.clear().catch(() => undefined)
        await db.characters.clear().catch(() => undefined)
        await db.teams.clear().catch(() => undefined)
        await db.skills.clear().catch(() => undefined)
        await db.connectorDrafts.clear().catch(() => undefined)
        // Preserve the dev-unlock marker across the storage wipe: the app is
        // gated behind AccountGate, and E2E seeds an unlocked account whose
        // unlock lives in sessionStorage. Clearing it would re-lock the gate on
        // the next navigation (e.g. assertLatestRunStatus's goto), blanking the
        // app. The account registry DB itself is a separate DB untouched here.
        const devUnlock = window.sessionStorage.getItem("cognia-dev-unlocked-account")
        window.localStorage.clear()
        window.sessionStorage.clear()
        if (devUnlock) {
          window.sessionStorage.setItem("cognia-dev-unlocked-account", devUnlock)
        }
        // Mock base URLs survive a reset by design — specs configure them
        // once via __cogniaSetMockBaseUrls and expect them to stick.
      }

      window.__cogniaSeedWorkflow = async (kind) => {
        const { createWorkflow } = await import("@/lib/db/workflows")
        const draft = buildWorkflowFixture(kind)
        const wf = await createWorkflow(draft)
        return wf.id
      }

      // Seed an ARBITRARY workflow graph (not a predefined fixture kind). Runs
      // inside the app bundle so `@/`-aliased imports resolve — they do NOT in
      // raw page.evaluate under Turbopack dev. Specs that need a bespoke graph
      // (e.g. a node engineered to fail) use this instead of `import()`ing
      // `@/lib/db/workflows` from page context.
      window.__cogniaSeedRawWorkflow = async (draft) => {
        const { createWorkflow } = await import("@/lib/db/workflows")
        const wf = await createWorkflow(draft as Parameters<typeof createWorkflow>[0])
        return wf.id
      }

      // Read a workflow's runs (with embedded events) straight from the
      // account-scoped Dexie db. The bridge runs in the app bundle, so this
      // works where a page.evaluate `import("@/lib/db/schema")` would fail to
      // resolve. Lets specs assert REAL run outcomes (status / events / branch
      // arm / iteration count) instead of pill visibility.
      window.__cogniaReadRuns = async (workflowId) => {
        const db = getDb()
        const rows = await db.workflowRuns
          .where("workflowId")
          .equals(workflowId)
          .sortBy("startedAt")
        // The per-step timeline lives in a SEPARATE table (`workflowRunEvents`,
        // keyed by `runId`), not embedded on the run row — so a spec asserting
        // "the failing step carries an error" must read both. We fold the
        // timeline (oldest → newest) plus the run-level `error` into each run.
        return Promise.all(
          rows.map(async (r) => {
            const row = r as unknown as {
              id: string
              status: string
              startedAt?: number
              completedAt?: number
              error?: unknown
            }
            const events = await db.workflowRunEvents.where("runId").equals(row.id).sortBy("ts")
            return {
              id: row.id,
              status: row.status,
              startedAt: row.startedAt,
              completedAt: row.completedAt,
              error: row.error,
              events: events as unknown as Array<Record<string, unknown>>,
            }
          })
        )
      }

      window.__cogniaSeedCharacter = async (draft) => {
        const { createCharacter } = await import("@/lib/db/characters")
        const c = await createCharacter({
          name: draft.name,
          systemPrompt: draft.systemPrompt ?? "You are helpful.",
        })
        return c.id
      }

      window.__cogniaSeedTeam = async (draft) => {
        const { createTeam } = await import("@/lib/db/teams")
        const t = await createTeam({
          name: draft.name,
          description: draft.description ?? "",
        } as Parameters<typeof createTeam>[0])
        return t.id
      }

      window.__cogniaSeedSkill = async (draft) => {
        const { createSkill } = await import("@/lib/db/skills")
        const s = await createSkill({
          name: draft.name,
          content: draft.body ?? "",
        })
        return s.id
      }

      window.__cogniaSeedConnectorDraft = async (draft) => {
        const { createDraft } = await import("@/lib/db/connector-drafts")
        const segments = [{ kind: "text", text: draft.content }] as unknown as Parameters<
          typeof createDraft
        >[0]["segments"]
        const d = await createDraft({
          conversationKey: draft.conversationKey,
          sessionId: "sess_e2e",
          segments,
        })
        return d.id
      }

      window.__cogniaEnqueueOutbound = async (job) => {
        // mobileOutboundQueue is the canonical table for the mobile client's
        // queued commands; the dev path enqueues directly so specs can drive
        // the runner without going through every UI surface.
        const db = getDb()
        const id = `mq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        const row = {
          id,
          command: job.command,
          payload: (job.payload ?? {}) as Record<string, unknown>,
          attempts: 0,
          nextAttemptAt: Date.now(),
          status: "pending",
          createdAt: Date.now(),
          idempotencyKey: id,
        }
        await db.mobileOutboundQueue
          .put(row as unknown as Parameters<typeof db.mobileOutboundQueue.put>[0])
          .catch(() => undefined)
        return id
      }

      window.__cogniaSeedRun = async (workflowId, status = "succeeded") => {
        const db = getDb()
        const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        await db.workflowRuns.put({
          id,
          workflowId,
          status,
          startedAt: Date.now(),
          completedAt: status === "running" ? undefined : Date.now() + 1000,
          // Older schema versions don't carry every field; the cast lets us
          // seed a row that the run-list page can render without flake.
        } as Parameters<typeof db.workflowRuns.put>[0])
        return id
      }

      window.__cogniaSetMockBaseUrls = async (urls) => {
        window.__cogniaMockBaseUrls = { ...window.__cogniaMockBaseUrls, ...urls }
        try {
          window.localStorage.setItem(
            "cognia.e2e.mockBaseUrls.v1",
            JSON.stringify(window.__cogniaMockBaseUrls)
          )
        } catch {
          // localStorage may be quota-limited in mobile-viewport runs.
        }
      }

      window.__cogniaSaveCompanionConfig = async (config) => {
        await saveCompanionConfig(config)
      }
      window.__cogniaClearCompanionConfig = async () => {
        await clearCompanionConfig()
      }
      window.__cogniaSetSettings = async (patch) => {
        const { useSettingsStore } = await import("@/stores/settings")
        type SavePatch = Parameters<ReturnType<typeof useSettingsStore.getState>["save"]>[0]
        await useSettingsStore.getState().save(patch as SavePatch)
      }

      // Subscription cleanup helper — wipes every per-provider account in the
      // OS keyring. Specs call this from `beforeEach` (after the Dexie reset)
      // so each test sees an empty vault even though the keyring sits outside
      // of Dexie's transactional reset.
      window.__cogniaE2EOpenUrlCalls = []
      window.__cogniaE2EOpenUrl = (url) => {
        window.__cogniaE2EOpenUrlCalls!.push(url)
      }
      window.__cogniaResetSubscriptionState = async () => {
        const { listAccounts, deleteAccount, setActiveAccount } =
          await import("@/lib/subscription/core/transport")
        const { ALL_PROVIDER_IDS } = await import("@/types/subscription")
        for (const provider of ALL_PROVIDER_IDS) {
          try {
            await setActiveAccount(provider, null)
          } catch {
            // best-effort — provider may have no active pointer yet
          }
          try {
            const accounts = await listAccounts(provider)
            for (const acct of accounts) {
              try {
                await deleteAccount(provider, acct.id)
              } catch {
                // best-effort
              }
            }
          } catch {
            // best-effort — provider may not be initialized
          }
        }
      }

      // Rehydrate any previously-set mock base URLs so a navigation that
      // re-mounts the bridge doesn't drop the configuration.
      try {
        const raw = window.localStorage.getItem("cognia.e2e.mockBaseUrls.v1")
        if (raw) window.__cogniaMockBaseUrls = JSON.parse(raw) as MockBaseUrls
      } catch {
        // ignore malformed storage
      }

      if (!cancelled) {
        window.__cogniaTestGlobalsReady = true
      }
    })().catch((err) => {
      console.error("expose-test-globals failed to wire", err)
    })

    return () => {
      cancelled = true
      delete window.__cogniaResetDb
      delete window.__cogniaSeedWorkflow
      delete window.__cogniaSeedCharacter
      delete window.__cogniaSeedTeam
      delete window.__cogniaSeedSkill
      delete window.__cogniaSeedConnectorDraft
      delete window.__cogniaEnqueueOutbound
      delete window.__cogniaSeedRun
      delete window.__cogniaSetMockBaseUrls
      delete window.__cogniaMockBaseUrls
      delete window.__cogniaSaveCompanionConfig
      delete window.__cogniaClearCompanionConfig
      delete window.__cogniaSetSettings
      delete window.__cogniaE2EOpenUrl
      delete window.__cogniaE2EOpenUrlCalls
      delete window.__cogniaResetSubscriptionState
      delete window.__cogniaE2ECodexDiscovery
      delete window.__cogniaE2EOcrMock
      window.__cogniaTestGlobalsReady = false
    }
  }, [])

  return null
}
