/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { render, waitFor, cleanup } from "@testing-library/react"
import { ExposeTestGlobals } from "./expose-test-globals"
import { activateAccountDatabase, getDb, __resetDbForTesting } from "@/lib/db/schema"
import { __resetSearchIndexerForTesting } from "@/lib/chat/search/indexer"
import {
  __resetBrowserVaultForTesting,
  deleteBrowserVault,
  provisionBrowserVault,
} from "@/lib/runtime/browser-vault"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { __setRuntimeTargetRegistrarForTests } from "@/lib/tauri/transport-companion"

const originalEnv = process.env.NEXT_PUBLIC_E2E

const cleanWindowKeys: Array<keyof Window> = [
  "__cogniaResetDb",
  "__cogniaSeedWorkflow",
  "__cogniaReadMessages",
  "__cogniaReadSessions",
  "__cogniaE2EOutbound",
  "__cogniaEnqueueOutbound",
  "__cogniaReadMobileOutbound",
  "__cogniaSeedCharacter",
  "__cogniaSeedTeam",
  "__cogniaSeedSquad",
  "__cogniaSeedSquadRun",
  "__cogniaSeedSkill",
  "__cogniaSeedConnectorDraft",
  "__cogniaSeedRun",
  "__cogniaSetMockBaseUrls",
  "__cogniaMockBaseUrls",
  "__cogniaSaveCompanionConfig",
  "__cogniaClearCompanionConfig",
  "__cogniaE2ECompanion",
  "__cogniaSetSettings",
  "__cogniaE2EWebRtc",
  "__cogniaE2EWebRtcEvents",
  "__cogniaE2EWebRtcReady",
  "__cogniaTestGlobalsReady",
] as Array<keyof Window>

beforeEach(() => {
  for (const k of cleanWindowKeys) {
    delete (window as unknown as Record<string, unknown>)[k as string]
  }
  delete window.__cogniaPluginRuntimeReady
  window.localStorage.clear()
})

afterEach(async () => {
  cleanup()
  __resetSearchIndexerForTesting()
  // Every test provisions a new vault key. Retaining rows encrypted with the
  // previous key makes the next fixture fail authentication during reads.
  await getDb().delete()
  __resetDbForTesting()
  __setRuntimeTargetRegistrarForTests(null)
  clearActiveRuntimeTargetContext()
  await deleteBrowserVault("acct_e2e_vault").catch(() => undefined)
  __resetBrowserVaultForTesting()
  delete window.__cogniaPluginRuntimeReady
  process.env.NEXT_PUBLIC_E2E = originalEnv
})

describe("ExposeTestGlobals", () => {
  it("renders nothing", () => {
    process.env.NEXT_PUBLIC_E2E = "0"
    const { container } = render(<ExposeTestGlobals />)
    expect(container.childNodes.length).toBe(0)
  })

  it("does not expose globals when NEXT_PUBLIC_E2E !== '1'", async () => {
    process.env.NEXT_PUBLIC_E2E = "0"
    render(<ExposeTestGlobals />)
    await Promise.resolve()
    expect(window.__cogniaResetDb).toBeUndefined()
    expect(window.__cogniaReadSessions).toBeUndefined()
    expect(window.__cogniaE2EOutbound).toBeUndefined()
    expect(window.__cogniaSeedWorkflow).toBeUndefined()
    expect(window.__cogniaSeedCharacter).toBeUndefined()
    expect(window.__cogniaSeedTeam).toBeUndefined()
    expect(window.__cogniaSeedSkill).toBeUndefined()
    expect(window.__cogniaSeedConnectorDraft).toBeUndefined()
    expect(window.__cogniaSeedRun).toBeUndefined()
    expect(window.__cogniaSetMockBaseUrls).toBeUndefined()
    expect(window.__cogniaSaveCompanionConfig).toBeUndefined()
    expect(window.__cogniaSetSettings).toBeUndefined()
    expect(window.__cogniaTestGlobalsReady).toBeUndefined()
  })

  it("wires every helper when NEXT_PUBLIC_E2E === '1'", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    expect(typeof window.__cogniaResetDb).toBe("function")
    expect(typeof window.__cogniaSeedWorkflow).toBe("function")
    expect(typeof window.__cogniaReadMessages).toBe("function")
    expect(typeof window.__cogniaReadSessions).toBe("function")
    expect(typeof window.__cogniaE2EOutbound?.seed).toBe("function")
    expect(typeof window.__cogniaE2EOutbound?.read).toBe("function")
    expect(typeof window.__cogniaSeedCharacter).toBe("function")
    expect(typeof window.__cogniaSeedTeam).toBe("function")
    expect(typeof window.__cogniaSeedSkill).toBe("function")
    expect(typeof window.__cogniaSeedPlan).toBe("function")
    expect(typeof window.__cogniaSeedConnectorDraft).toBe("function")
    expect(typeof window.__cogniaSeedRun).toBe("function")
    expect(typeof window.__cogniaSetMockBaseUrls).toBe("function")
    expect(typeof window.__cogniaSaveCompanionConfig).toBe("function")
    expect(typeof window.__cogniaClearCompanionConfig).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.call).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.request).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.subscribe).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.pair).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.targets).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.switchTarget).toBe("function")
    expect(typeof window.__cogniaE2ECompanion?.runtime).toBe("function")
    expect(window.__cogniaE2ECompanion?.activeTier()).toBeNull()
    expect(typeof window.__cogniaSetSettings).toBe("function")
    // ADR-0021 real-pair harness seam.
    expect(typeof window.__cogniaE2EWebRtc?.connect).toBe("function")
    expect(typeof window.__cogniaE2EWebRtc?.reconnectNow).toBe("function")
    expect(window.__cogniaE2EWebRtcEvents).toEqual({})
  })

  it("waits for an in-progress plugin schema upgrade before opening the fixture bridge", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    window.__cogniaPluginRuntimeReady = false

    render(<ExposeTestGlobals />)

    await waitFor(() => {
      expect(window.__cogniaE2EWebRtcReady).toBe(true)
    })
    expect(window.__cogniaTestGlobalsReady).not.toBe(true)

    window.__cogniaPluginRuntimeReady = true
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
  })

  it("__cogniaResetDb re-points at the bare account db, not the double-suffixed physical name", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    await provisionBrowserVault("acct_e2e_vault", "correct horse battery staple")
    // Simulate a boot that already activated the ENCRYPTED account db — its
    // physical name carries `-encrypted-v1`, which the reset must strip before
    // re-activating. Passing it verbatim produced `…-encrypted-v1-encrypted-v1`
    // and the re-seed threw "Account content cipher is locked" (E2E flake).
    activateAccountDatabase("acct_e2e_vault")
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })

    await window.__cogniaResetDb!()

    expect(getDb().name).toBe("cognia-account-acct_e2e_vault-encrypted-v1")
    // Settings writes go through the account content cipher — this is the
    // call that used to throw when the doubled name was activated instead.
    await window.__cogniaSetSettings!({ mobileRuntimeMode: "standalone" })
  })

  it("enqueues mobile work with the active target scope and preserves failures", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    await provisionBrowserVault("acct_e2e_vault", "correct horse battery staple")
    activateAccountDatabase("acct_e2e_vault")
    setActiveRuntimeTargetContext("acct_e2e_vault", "standalone-local")
    render(<ExposeTestGlobals />)
    await waitFor(() => expect(window.__cogniaTestGlobalsReady).toBe(true))

    const id = await window.__cogniaEnqueueOutbound!({
      command: "app_settings_update",
      payload: { theme: "dark" },
    })
    await expect(getDb().mobileOutboundQueue.get(id)).resolves.toMatchObject({
      accountId: "acct_e2e_vault",
      targetId: "standalone-local",
      command: "app_settings_update",
      payload: { theme: "dark" },
      status: "pending",
    })
    await expect(window.__cogniaReadMobileOutbound!()).resolves.toEqual([
      expect.objectContaining({ id, payload: { theme: "dark" }, targetId: "standalone-local" }),
    ])
    clearActiveRuntimeTargetContext()
    await expect(
      window.__cogniaEnqueueOutbound!({ command: "app_settings_update" })
    ).rejects.toThrow("Outbound queue requires an active account and runtime target.")
  })

  it("reads outbound recovery fixtures through the active target cipher", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    await provisionBrowserVault("acct_e2e_vault", "correct horse battery staple")
    activateAccountDatabase("acct_e2e_vault", "outbound-fixture-host")
    render(<ExposeTestGlobals />)
    await waitFor(() => expect(window.__cogniaTestGlobalsReady).toBe(true))
    const job = {
      id: "outbound-fixture",
      adapterId: "fixture-adapter",
      conversationKey: "telegram:fixture-adapter:fixture-chat",
      request: {
        conversationRef: {
          platform: "telegram" as const,
          adapterId: "fixture-adapter",
          chatId: "fixture-chat",
        },
        segments: [{ type: "text" as const, text: "Synthetic queued message" }],
        metadata: { idempotencyKey: "outbound-fixture-key" },
      },
      status: "deadlettered" as const,
      attempts: 5,
      lastErrorCode: "network",
      createdAt: Date.now(),
      nextAttemptAt: Date.now(),
      idempotencyKey: "outbound-fixture-key",
      source: "manual" as const,
    }
    await window.__cogniaE2EOutbound!.seed([job])
    const { appendAudit } = await import("@/lib/connectors/audit")
    await appendAudit({
      adapterId: job.adapterId,
      kind: "outbound.replayed",
      at: Date.now(),
      fields: { jobId: job.id },
    })
    await expect(window.__cogniaE2EOutbound!.read()).resolves.toMatchObject({
      jobs: [job],
      audit: [expect.objectContaining({ kind: "outbound.replayed", fields: { jobId: job.id } })],
    })
    activateAccountDatabase("acct_e2e_vault", "other-fixture-host")
    await expect(window.__cogniaE2EOutbound!.read()).resolves.toEqual({ jobs: [], audit: [] })
  })

  it("reads persisted session execution context through the active account cipher", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    await provisionBrowserVault("acct_e2e_vault", "correct horse battery staple")
    activateAccountDatabase("acct_e2e_vault")
    render(<ExposeTestGlobals />)
    await waitFor(() => expect(window.__cogniaTestGlobalsReady).toBe(true))
    const { createSession } = await import("@/lib/db/sessions")
    const executionContext = {
      location: "local" as const,
      projectId: "project_e2e",
      projectRoot: "/tmp/cognia-workflow-e2e",
      taskWorkspace: { taskId: "task_e2e", workspaceKey: "workspace_e2e" },
    }
    const session = await createSession({
      title: "Persisted execution",
      model: "claude-sonnet-5",
      projectId: "project_e2e",
      executionContext,
    })
    await expect(window.__cogniaReadSessions!()).resolves.toEqual(
      expect.arrayContaining([
        {
          database: "cognia-account-acct_e2e_vault-encrypted-v1",
          id: session.id,
          projectId: "project_e2e",
          executionContext,
        },
      ])
    )
  })

  it("__cogniaReadMessages returns the text an encrypted account database stores", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    await provisionBrowserVault("acct_e2e_vault", "correct horse battery staple")
    activateAccountDatabase("acct_e2e_vault")
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    const [{ createSession }, { persistMessages }] = await Promise.all([
      import("@/lib/db/sessions"),
      import("@/lib/db/messages"),
    ])
    // A model skips the default-preset auto-apply, which is not under test.
    const session = await createSession({ title: "Durable turn", model: "claude-sonnet-5" })
    await persistMessages(session.id, [
      { id: "u1", role: "user", parts: [{ type: "text", text: "ping" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "not the reply" },
          { type: "text", text: "po" },
          { type: "text", text: "ng" },
        ],
      },
    ])

    // What a raw IndexedDB reader sees: the envelope, not the message.
    const raw = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const open = indexedDB.open(getDb().name)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const request = open.result.transaction("messages").objectStore("messages").getAll()
        request.onsuccess = () => {
          open.result.close()
          resolve(request.result)
        }
        request.onerror = () => reject(request.error)
      }
    })
    expect(raw.length).toBeGreaterThan(0)
    expect(raw.every((row) => row.parts === undefined)).toBe(true)

    await expect(window.__cogniaReadMessages!()).resolves.toEqual(
      expect.arrayContaining([
        {
          database: "cognia-account-acct_e2e_vault-encrypted-v1",
          sessionId: session.id,
          role: "user",
          text: "ping",
        },
        {
          database: "cognia-account-acct_e2e_vault-encrypted-v1",
          sessionId: session.id,
          role: "assistant",
          text: "pong",
        },
      ])
    )
  })

  it("seeds durable Squad runs with frozen launch authority from the team's security config", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    await provisionBrowserVault("acct_e2e_vault", "correct horse battery staple")
    activateAccountDatabase("acct_e2e_vault")
    const [{ useAgentTeamStore }, { AGENT_TEAM_SECURITY_CONFIG_KEYS }] = await Promise.all([
      import("@/stores/agent/agent-team-store"),
      import("@/types/agent/agent-team-runtime"),
    ])
    const team = useAgentTeamStore.getState().createTeam({
      name: "Seed authority",
      task: "Review evidence",
      config: { allowedTools: ["Read"], disallowedTools: ["Bash"], requirePlanApproval: true },
    })
    render(<ExposeTestGlobals />)
    await waitFor(() => expect(window.__cogniaTestGlobalsReady).toBe(true))
    const { runId } = await window.__cogniaSeedSquadRun!({
      teamId: team.id,
      objective: team.task,
      status: "paused",
    })
    const run = await getDb().agentTeamRuns.get(runId)
    expect(run?.executionConstraints).toMatchObject({
      version: 1,
      origin: "interactive",
      triggeredFrom: { source: "ui" },
      requirePlanApprovalFloor: true,
      permissionCeiling: {
        permissionMode: "default",
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
      },
      teamConfig: { allowedTools: ["Read"], disallowedTools: ["Bash"], requirePlanApproval: true },
    })
    expect(Object.keys(run!.executionConstraints!.teamConfig!)).toEqual(
      AGENT_TEAM_SECURITY_CONFIG_KEYS.filter((key) => team.config[key] !== undefined)
    )
    useAgentTeamStore.getState().updateTeam(team.id, {
      config: { ...team.config, allowedTools: ["Read", "Bash"], requirePlanApproval: false },
    })
    expect((await getDb().agentTeamRuns.get(runId))?.executionConstraints).toEqual(
      run?.executionConstraints
    )
  })

  it("__cogniaE2EWebRtc.getState returns 'idle' before connect and reconnectNow returns 'no-instance'", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    // No handshake started yet — the seam reports a benign default rather than
    // throwing, so the driver can poll state before connect().
    expect(window.__cogniaE2EWebRtc!.getState()).toBe("idle")
    expect(window.__cogniaE2EWebRtc!.reconnectNow()).toBe("no-instance")
  })

  it("seeds a sendable connector draft with canonical segments and preview", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })

    const id = await window.__cogniaSeedConnectorDraft!({
      adapterId: "adapter-e2e",
      conversationKey: "lark:adapter-e2e:chat-e2e",
      content: "Pending reply",
    })
    const row = await getDb().connectorDrafts.get(id)

    expect(row).toMatchObject({
      id,
      conversationKey: "lark:adapter-e2e:chat-e2e",
      segments: [{ type: "text", text: "Pending reply" }],
      status: "pending",
      outboundPreview: {
        conversationRef: {
          platform: "lark",
          adapterId: "adapter-e2e",
          chatId: "chat-e2e",
        },
        segments: [{ type: "text", text: "Pending reply" }],
        metadata: { idempotencyKey: expect.any(String) },
      },
    })
  })

  it("removes every global on unmount", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    const { unmount } = render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    unmount()
    for (const k of cleanWindowKeys) {
      if (k === "__cogniaTestGlobalsReady" || k === "__cogniaE2EWebRtcReady") {
        expect((window as unknown as Record<string, unknown>)[k]).toBe(false)
      } else {
        expect((window as unknown as Record<string, unknown>)[k as string]).toBeUndefined()
      }
    }
  })

  it("__cogniaSaveCompanionConfig persists only public target data outside the Browser Vault", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    await provisionBrowserVault("acct_e2e_vault", "correct horse battery staple")
    setActiveRuntimeTargetContext("acct_e2e_vault", "standalone-local")
    __setRuntimeTargetRegistrarForTests(async (config) => {
      setActiveRuntimeTargetContext("acct_e2e_vault", config.targetId!)
    })
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    await window.__cogniaSaveCompanionConfig!({
      baseUrl: "https://192.168.1.42:7891",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
      deviceKeyThumbprint: "device-thumbprint",
      deviceId: "device_abc",
      serverVersion: "1.2.3",
    })
    const stored = window.localStorage.getItem("cognia.companion.hosts.v2")
    expect(stored).not.toBeNull()
    expect(stored).toContain("https://192.168.1.42:7891")
    expect(stored).not.toContain("device-private")
    expect(window.localStorage.getItem("cognia.companion.config.v1")).toBeNull()

    await window.__cogniaClearCompanionConfig!()
    expect(window.localStorage.getItem("cognia.companion.hosts.v2") ?? "").not.toContain(
      "https://192.168.1.42:7891"
    )
  })

  it("__cogniaSetMockBaseUrls round-trips through localStorage", async () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    render(<ExposeTestGlobals />)
    await waitFor(() => {
      expect(window.__cogniaTestGlobalsReady).toBe(true)
    })
    await window.__cogniaSetMockBaseUrls!({
      anthropic: "http://127.0.0.1:7892",
      github: "http://127.0.0.1:7893",
    })
    expect(window.__cogniaMockBaseUrls).toEqual({
      anthropic: "http://127.0.0.1:7892",
      github: "http://127.0.0.1:7893",
    })
    const raw = window.localStorage.getItem("cognia.e2e.mockBaseUrls.v1")
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!).github).toBe("http://127.0.0.1:7893")

    // Merge semantics: a second call patches existing keys, doesn't replace.
    await window.__cogniaSetMockBaseUrls!({ lark: "http://127.0.0.1:7894" })
    expect(window.__cogniaMockBaseUrls).toEqual({
      anthropic: "http://127.0.0.1:7892",
      github: "http://127.0.0.1:7893",
      lark: "http://127.0.0.1:7894",
    })
  })
})
