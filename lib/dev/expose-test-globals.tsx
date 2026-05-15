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
    __cogniaSaveCompanionConfig?: (config: {
      baseUrl: string
      deviceJwt: string
      deviceId: string
      serverVersion: string
      serverFingerprint?: string
    }) => Promise<void>
    __cogniaClearCompanionConfig?: () => Promise<void>
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
        { __resetDbForTesting, getDb, whenSeeded },
        { companionStorage },
        { buildWorkflowFixture },
      ] = await Promise.all([
        import("@/lib/db/schema"),
        import("@/lib/tauri/companion-storage"),
        import("./workflow-fixtures"),
      ])

      window.__cogniaResetDb = async () => {
        try {
          await getDb().delete()
        } catch {
          // DatabaseClosedError is normal during repeated resets; the cache
          // drop below recovers.
        }
        __resetDbForTesting()
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
        window.localStorage.clear()
        window.sessionStorage.clear()
        // Mock base URLs survive a reset by design — specs configure them
        // once via __cogniaSetMockBaseUrls and expect them to stick.
      }

      window.__cogniaSeedWorkflow = async (kind) => {
        const { createWorkflow } = await import("@/lib/db/workflows")
        const draft = buildWorkflowFixture(kind)
        const wf = await createWorkflow(draft)
        return wf.id
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
        await companionStorage().save(config)
      }
      window.__cogniaClearCompanionConfig = async () => {
        await companionStorage().clear()
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
      window.__cogniaTestGlobalsReady = false
    }
  }, [])

  return null
}
