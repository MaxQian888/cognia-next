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
import type { ChatPerfMediaOptions } from "./chat-perf-fixtures"

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
    /**
     * Seed a conversation of `turns` user/assistant pairs and return its id.
     * Long enough to exercise the virtualized path and the timeline minimap,
     * which is what the conversation-anchor specs need and what no amount of
     * jsdom can produce (it has no layout).
     *
     * `media` loads the conversation with the payload the render-performance
     * benchmark measures — agent-sized screenshots as `file` parts, mermaid
     * fences, and oversized table / code blocks. Omit it and the shape is
     * exactly what it was before the benchmark existed.
     */
    __cogniaSeedConversation?: (draft: {
      turns: number
      title?: string
      media?: ChatPerfMediaOptions
    }) => Promise<{ sessionId: string; messageIds: string[]; imageBytes: number }>
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
      devicePrivateKeyJwk: JsonWebKey
      deviceKeyThumbprint: string
      deviceId: string
      serverVersion: string
      serverFingerprint?: string
    }) => Promise<void>
    __cogniaClearCompanionConfig?: () => Promise<void>
    /**
     * Real Web Companion E2E seam. It always resolves the live module transport
     * so a first-time pairing that replaces `WebStubTransport` is visible
     * without reloading the page.
     */
    __cogniaE2ECompanion?: {
      call(method: string, params?: Record<string, unknown>): Promise<unknown>
      request(
        method: "GET" | "POST" | "PUT" | "DELETE",
        path: string,
        body?: unknown
      ): Promise<{ status: number; body: unknown }>
      pair(pairPayload: string): Promise<{
        accountId: string
        targetId: string
        databaseName: string
        deviceId: string
        baseUrl: string
      }>
      targets(): Promise<
        Array<{
          id: string
          kind: "standalone" | "companion" | "legacy-readonly"
          baseUrl?: string
          deviceId?: string
        }>
      >
      switchTarget(targetId: string): Promise<void>
      runtime(): Promise<{
        accountId: string
        targetId: string
        databaseName: string
        deviceId: string | null
        baseUrl: string | null
      } | null>
      subscribe(event: string): void
      unsubscribe(event: string): void
      events(event: string): unknown[]
      connectionState(): string | null
      activeTier(): string | null
      reconnectWs(): void
      reconnectRtc(): string
      disableRtc(): void
    }
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
    /**
     * ADR-0021 real-pair harness seam. Constructs a REAL `TransportRtc`
     * (real `RTCPeerConnection` + real `SignalingClient`, no mock factories)
     * so `pnpm webrtc:pair` can drive the browser offerer against a live
     * `cognia-webrtc-peer` answerer through a live signaling server. Only the
     * mobile (offerer) role is exercised here — the desktop answerer is the
     * Rust harness binary. All methods are page-context callable via
     * `page.evaluate`; received events accumulate in
     * {@link __cogniaE2EWebRtcEvents} for the driver to poll.
     */
    __cogniaE2EWebRtc?: {
      connect(opts: {
        signalingUrl: string
        rendezvousId: string
        signalingRoomDescriptor: import("@/lib/signaling/v2-crypto").RoomDescriptorV2
        signalingPrivateKeyJwk: JsonWebKey
        deviceId: string
        /** Loopback harness → host candidates suffice; default no STUN. */
        iceServers?: RTCIceServer[]
        /** Short peer-wait / negotiation windows keep the harness snappy. */
        peerWaitTimeoutMs?: number
        negotiationTimeoutMs?: number
      }): Promise<void>
      getState(): string
      getSelectedCandidateKind(): Promise<string>
      call(method: string, params?: Record<string, unknown>): Promise<unknown>
      /** Begin collecting `event` frames into `__cogniaE2EWebRtcEvents`. */
      subscribe(event: string): void
      reconnectNow(): "started" | "busy" | "throttled" | "no-instance"
      close(): void
    }
    /** Per-channel event log populated by `__cogniaE2EWebRtc.subscribe`. */
    __cogniaE2EWebRtcEvents?: Record<string, Array<{ seq: number; payload: unknown; at: number }>>
    /** WebRTC-only seam readiness, independent of the much larger Dexie fixture bridge. */
    __cogniaE2EWebRtcReady?: boolean
    __cogniaTestGlobalsReady?: boolean
  }
}

export function ExposeTestGlobals(): null {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_E2E !== "1") return
    if (typeof window === "undefined") return

    let cancelled = false
    let detachCompanionE2E = () => {}

    void (async () => {
      // Install the real-pair WebRTC seam before opening Dexie. The broader
      // E2E fixture bridge below can legitimately wait on a plugin schema
      // upgrade, but that unrelated database work must not block a transport-
      // only smoke test from opening a DataChannel.
      {
        const { TransportRtc } = await import("@/lib/tauri/transport-rtc")
        const { importV2SigningPrivateKey } = await import("@/lib/signaling/v2-crypto")
        let rtc: InstanceType<typeof TransportRtc> | null = null
        window.__cogniaE2EWebRtcEvents = {}
        window.__cogniaE2EWebRtc = {
          async connect(opts) {
            rtc?.close()
            const signalingPrivateKey = await importV2SigningPrivateKey(opts.signalingPrivateKeyJwk)
            rtc = new TransportRtc({
              signalingUrl: opts.signalingUrl,
              rendezvousId: opts.rendezvousId,
              signalingRoomDescriptor: opts.signalingRoomDescriptor,
              signalingPrivateKey,
              deviceId: opts.deviceId,
              role: "mobile",
              rtcConfiguration: { iceServers: opts.iceServers ?? [] },
              peerWaitTimeoutMs: opts.peerWaitTimeoutMs,
              negotiationTimeoutMs: opts.negotiationTimeoutMs,
            })
            await rtc.connect()
          },
          getState() {
            return rtc?.getState() ?? "idle"
          },
          async getSelectedCandidateKind() {
            return rtc ? rtc.getSelectedCandidateKind() : "unknown"
          },
          async call(method, params) {
            if (!rtc) throw new Error("__cogniaE2EWebRtc: not connected")
            return rtc.call(method, params)
          },
          subscribe(event) {
            if (!rtc) throw new Error("__cogniaE2EWebRtc: not connected")
            const log = (window.__cogniaE2EWebRtcEvents![event] ??= [])
            rtc.subscribe(event, (payload) => {
              const seq = rtc?.getSeqCursor()[event] ?? 0
              log.push({ seq, payload, at: Date.now() })
            })
          },
          reconnectNow() {
            return rtc ? rtc.reconnectNow() : "no-instance"
          },
          close() {
            rtc?.close()
            rtc = null
          },
        }
        window.__cogniaE2EWebRtcReady = true
      }

      // Plugin discovery can add dynamic Dexie tables. If its E2E initializer
      // has started, do not import the broad fixture bridge (which opens the
      // account DB at the current schema) until that upgrade has settled.
      // Otherwise the two same-page connections can deadlock each other at
      // adjacent versions and make the prescribed recovery Reload repeat.
      while (window.__cogniaPluginRuntimeReady === false && !cancelled) {
        await new Promise((resolve) => window.setTimeout(resolve, 25))
      }
      if (cancelled) return

      const [
        { __resetDbForTesting, getDb, whenSeeded, activateAccountDatabase },
        // Route through the transport module, NOT companionStorage() directly:
        // the transport's hot path reads a module-level in-memory cache that
        // only saveCompanionConfig/clearCompanionConfig update. A raw storage
        // write leaves that cache null and every transport.call() rejects
        // with not_paired even though storage holds the config.
        { saveCompanionConfig, clearCompanionConfig, loadCompanionConfig },
        { buildWorkflowFixture },
        transportModule,
      ] = await Promise.all([
        import("@/lib/db/schema"),
        import("@/lib/tauri/transport-companion"),
        import("./workflow-fixtures"),
        import("@/lib/tauri/transport-instance"),
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
        // Safe to wipe wholesale: the unlocked-account state the gate reads is
        // never stored here. Dev builds re-derive it from the account registry
        // (a separate DB, untouched by this reset) on every load — see
        // `lib/accounts/dev-auto-unlock.ts`.
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

      window.__cogniaSeedConversation = async (draft) => {
        const { createSession } = await import("@/lib/db/sessions")
        const { persistMessages } = await import("@/lib/db/messages")
        const { buildPerfConversation, createNoiseImageDataUrl } =
          await import("./chat-perf-fixtures")
        const session = await createSession({ title: draft.title ?? "Anchors spec" })
        const longEdge = draft.media?.imageLongEdge ?? 1568
        const { messages, imageBytes } = buildPerfConversation({
          sessionId: session.id,
          turns: draft.turns,
          media: draft.media,
          makeImage: (index) => createNoiseImageDataUrl(longEdge, index + 1),
          baseTime: Date.now(),
        })
        await persistMessages(session.id, messages as never)
        return { sessionId: session.id, messageIds: messages.map((m) => m.id), imageBytes }
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
        const { parseConversationKey } = await import("@/types/connectors/event")
        const parsed = parseConversationKey(draft.conversationKey)
        if (parsed.adapterId !== draft.adapterId) {
          throw new Error(
            `connector draft adapter mismatch: ${draft.adapterId} !== ${parsed.adapterId}`
          )
        }
        const segments: Parameters<typeof createDraft>[0]["segments"] = [
          { type: "text", text: draft.content },
        ]
        const d = await createDraft({
          conversationKey: draft.conversationKey,
          sessionId: "sess_e2e",
          segments,
          outboundPreview: {
            conversationRef: {
              platform: parsed.platform,
              adapterId: parsed.adapterId,
              chatId: parsed.remoteChatId,
              ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
            },
            segments,
            metadata: { idempotencyKey: crypto.randomUUID() },
          },
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
      const companionEventLogs = new Map<string, unknown[]>()
      const companionEventUnsubscribers = new Map<string, () => void>()
      detachCompanionE2E = () => {
        for (const unsubscribe of companionEventUnsubscribers.values()) unsubscribe()
        companionEventUnsubscribers.clear()
        companionEventLogs.clear()
      }
      const liveCompanionTransport = () =>
        transportModule.transport as typeof transportModule.transport & {
          getConnectionState?: () => string
          getActiveTier?: () => string
          reconnectWs?: () => void
          reconnectRtc?: () => string
          disableWebRtcTier?: () => void
        }
      const companionRequest = async (
        method: "GET" | "POST" | "PUT" | "DELETE",
        path: string,
        body?: unknown
      ): Promise<{ status: number; body: unknown }> => {
        if (!path.startsWith("/") || path.includes("#")) {
          throw new Error("Companion E2E request path must be absolute and fragment-free")
        }
        const config = loadCompanionConfig()
        if (!config) throw new Error("Companion E2E request requires an active pairing")
        const [{ companionAuthorizationHeaders }, { pinnedFetch }] = await Promise.all([
          import("@/lib/tauri/companion-auth"),
          import("@/lib/tauri/pinned-fetch"),
        ])
        const headers: Record<string, string> = await companionAuthorizationHeaders(
          config,
          method,
          new URL(path, config.baseUrl).pathname
        )
        let serializedBody: string | undefined
        if (body !== undefined) {
          headers["Content-Type"] = "application/json"
          serializedBody = JSON.stringify(body)
        }
        const response = await pinnedFetch(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
          method,
          headers,
          body: serializedBody,
          serverFingerprint: config.serverFingerprint,
        })
        const responseBody = await response.json().catch(() => null)
        return { status: response.status, body: responseBody }
      }
      const runtimeSummary = async () => {
        const { getActiveRuntimeTargetContext } =
          await import("@/lib/runtime/runtime-target-context")
        const context = getActiveRuntimeTargetContext()
        if (!context) return null
        const config = loadCompanionConfig()
        return {
          accountId: context.accountId,
          targetId: context.targetId,
          databaseName: getDb().name,
          deviceId: config?.deviceId ?? null,
          baseUrl: config?.baseUrl ?? null,
        }
      }
      window.__cogniaE2ECompanion = {
        call(method, params) {
          return liveCompanionTransport().call(method, params)
        },
        request: companionRequest,
        async pair(pairPayload) {
          const { registerPairPayload } = await import("@/components/mobile/pair/pair-api")
          const result = await registerPairPayload(pairPayload)
          if (result.kind !== "ok") throw new Error(result.message)
          await saveCompanionConfig(result.config)
          const summary = await runtimeSummary()
          if (!summary || !summary.deviceId || !summary.baseUrl) {
            throw new Error("Pairing completed without an active Companion runtime target")
          }
          return {
            ...summary,
            deviceId: summary.deviceId,
            baseUrl: summary.baseUrl,
          }
        },
        async targets() {
          const [{ getActiveRuntimeTargetContext }, { RuntimeTargetRegistry }] = await Promise.all([
            import("@/lib/runtime/runtime-target-context"),
            import("@/lib/runtime/target-registry"),
          ])
          const context = getActiveRuntimeTargetContext()
          if (!context) return []
          const registry = new RuntimeTargetRegistry()
          try {
            return (await registry.listTargets(context.accountId)).map((target) => ({
              id: target.id,
              kind: target.kind,
              baseUrl: target.baseUrl,
              deviceId: target.deviceId,
            }))
          } finally {
            registry.close()
          }
        },
        async switchTarget(targetId) {
          const [{ getActiveRuntimeTargetContext }, { switchAccountRuntimeTarget }] =
            await Promise.all([
              import("@/lib/runtime/runtime-target-context"),
              import("@/lib/runtime/account-runtime-target"),
            ])
          const context = getActiveRuntimeTargetContext()
          if (!context) throw new Error("Runtime target switching requires an active account")
          await switchAccountRuntimeTarget(context.accountId, targetId)
        },
        runtime: runtimeSummary,
        subscribe(event) {
          if (companionEventUnsubscribers.has(event)) return
          const log = companionEventLogs.get(event) ?? []
          companionEventLogs.set(event, log)
          companionEventUnsubscribers.set(
            event,
            liveCompanionTransport().subscribe(event, (payload) => log.push(payload))
          )
        },
        unsubscribe(event) {
          companionEventUnsubscribers.get(event)?.()
          companionEventUnsubscribers.delete(event)
        },
        events(event) {
          return [...(companionEventLogs.get(event) ?? [])]
        },
        connectionState() {
          return liveCompanionTransport().getConnectionState?.() ?? null
        },
        activeTier() {
          return liveCompanionTransport().getActiveTier?.() ?? null
        },
        reconnectWs() {
          liveCompanionTransport().reconnectWs?.()
        },
        reconnectRtc() {
          return liveCompanionTransport().reconnectRtc?.() ?? "no-tier"
        },
        disableRtc() {
          liveCompanionTransport().disableWebRtcTier?.()
        },
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
      detachCompanionE2E()
      delete window.__cogniaResetDb
      delete window.__cogniaSeedWorkflow
      delete window.__cogniaSeedCharacter
      delete window.__cogniaSeedConversation
      delete window.__cogniaSeedTeam
      delete window.__cogniaSeedSkill
      delete window.__cogniaSeedConnectorDraft
      delete window.__cogniaEnqueueOutbound
      delete window.__cogniaSeedRun
      delete window.__cogniaSetMockBaseUrls
      delete window.__cogniaMockBaseUrls
      delete window.__cogniaSaveCompanionConfig
      delete window.__cogniaClearCompanionConfig
      delete window.__cogniaE2ECompanion
      delete window.__cogniaSetSettings
      delete window.__cogniaE2EOpenUrl
      delete window.__cogniaE2EOpenUrlCalls
      delete window.__cogniaResetSubscriptionState
      delete window.__cogniaE2ECodexDiscovery
      delete window.__cogniaE2EOcrMock
      window.__cogniaE2EWebRtc?.close()
      delete window.__cogniaE2EWebRtc
      delete window.__cogniaE2EWebRtcEvents
      window.__cogniaE2EWebRtcReady = false
      window.__cogniaTestGlobalsReady = false
    }
  }, [])

  return null
}
