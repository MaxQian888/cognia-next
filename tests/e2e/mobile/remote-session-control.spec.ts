/**
 * Mobile E2E: paired Remote Session control contract.
 *
 * The real companion transport talks to HTTP and WebSocket boundaries owned
 * by a deterministic desktop-host double. The test proves list → attach →
 * send → interrupt → approval → detach without replacing the route, hooks,
 * transport, or durable mobile shell.
 */

import { expect, test, type Page, type WebSocketRoute } from "@/tests/e2e/fixtures/test"
import type { TranscriptTimelineItem } from "@cognia/agent-config-types"
import { transcriptCapabilitiesV1 } from "@/lib/chat/transcript/source"
import { buildLocalHostFeatureManifest } from "@/lib/platform/host-feature-manifest"

import {
  bootstrapCogniaMobile,
  setCogniaSettings,
  waitForPluginRuntimeReady,
} from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { companionConfigSecureStorage, provisionMockCompanionConfig } from "./companion-fixture"

const SESSION_ID = "session-e2e-remote-control"
const SESSION_TITLE = "Release incident response"
const FOLLOW_UP = "Summarize the rollback evidence"

interface CapturedRpc {
  command: string
  body: Record<string, unknown>
}

function mockV2BaseUrl(): string {
  const baseUrl = process.env.E2E_V2_BASE_URL
  if (!baseUrl) {
    throw new Error("E2E_V2_BASE_URL not published — global setup did not start the V2 mock")
  }
  return baseUrl
}

async function installDesktopBoundaries(
  page: Page,
  timeline?: TranscriptTimelineItem[]
): Promise<{
  calls: CapturedRpc[]
  sendEvent: (payload: Record<string, unknown>) => void
}> {
  const calls: CapturedRpc[] = []
  let socket: WebSocketRoute | null = null
  let sequence = 0
  const baseUrl = mockV2BaseUrl()

  await page.routeWebSocket(/\/ws\/events(?:\?|$)/, (route) => {
    socket = route
    if (timeline) {
      route.onMessage((raw) => {
        const frame = JSON.parse(String(raw)) as { type?: string; channels?: string[] }
        if (frame.type === "subscribe") {
          route.send(JSON.stringify({ type: "subscribed", channels: frame.channels ?? [] }))
          route.send(JSON.stringify({ type: "stream_ready", cursor: sequence }))
        }
      })
    }
  })

  await page.route(`${baseUrl}/api/_rpc/**`, async (route) => {
    const request = route.request()
    const command = new URL(request.url()).pathname.split("/").pop() ?? ""
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>
    calls.push({ command, body })

    if (timeline && command === "host_feature_manifest") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(buildLocalHostFeatureManifest({ platform: "tauri" })),
      })
      return
    }

    if (timeline && (command === "transcript_capabilities" || command === "session_timeline")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          command === "transcript_capabilities"
            ? transcriptCapabilitiesV1()
            : { items: timeline, revision: 1, hasMore: false }
        ),
      })
      return
    }

    if (command === "session_list") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          rows: [{ id: SESSION_ID, title: SESSION_TITLE, kind: "direct", updatedAt: Date.now() }],
          total: 1,
        }),
      })
      return
    }

    if (command === "sync_pull") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ rows: [], deleted_ids: [], next_since: Date.now() }),
      })
      return
    }

    await route.fulfill({ contentType: "application/json", body: "{}" })
  })

  return {
    calls,
    sendEvent(payload) {
      if (!socket) throw new Error("the companion event WebSocket is not connected")
      socket.send(
        JSON.stringify({
          type: "claude://message",
          seq: ++sequence,
          payload,
          ts_ms: Date.now(),
        })
      )
    },
  }
}

test.describe("mobile — remote session control", () => {
  test("@perf reads settled history while remote tokens stream", async ({ page }, testInfo) => {
    test.skip(process.env.CHAT_PERF_BENCH !== "1", "Opt-in renderer benchmark")
    test.setTimeout(180_000)
    const timeline: TranscriptTimelineItem[] = Array.from({ length: 30 }, (_, index) => ({
      kind: "completed-turn",
      itemKey: `turn:${index}`,
      turnKey: `turn:${index}`,
      revision: 1,
      detailRevision: 1,
      status: "completed",
      startedAt: index * 2,
      completedAt: index * 2 + 1,
      userMessages: [
        { id: `u${index}`, role: "user", text: `Question ${index}`, createdAt: index * 2 },
      ],
      finalResponse: {
        id: `a${index}`,
        role: "assistant",
        createdAt: index * 2 + 1,
        text:
          `Answer ${index}\n\n` +
          "**Measured history** with a [reference](https://example.com).\n\n".repeat(8),
      },
      collapsed: { exists: false, messageCount: 2, trailingCount: 0, mediaCount: 0 },
    }))
    const desktop = await installDesktopBoundaries(page, timeline)
    const companionConfig = await provisionMockCompanionConfig(
      mockV2BaseUrl(),
      "device-e2e-remote-perf"
    )
    if (process.env.CHAT_PERF_SHELL !== "web") {
      await injectCapacitor(page, {
        platform: "android",
        network: { connected: true, connectionType: "wifi" },
        secureStorage: companionConfigSecureStorage(companionConfig),
      })
    }
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "paired", {
      onboardingProgress: {
        version: 1,
        path: "completed",
        completedAt: "2026-09-07T00:00:00.000Z",
      },
    })
    await page.goto("/plugins", { waitUntil: "domcontentloaded" })
    await waitForPluginRuntimeReady(page, 60_000)
    await page.waitForFunction(() => typeof window.__cogniaSaveCompanionConfig === "function")
    await page.evaluate(
      async (config) => window.__cogniaSaveCompanionConfig!(config),
      {
        ...companionConfig,
        // The provisioning helper generates both fields; CompanionConfig also
        // models unpaired/legacy records, so its public type makes them optional.
        devicePrivateKeyJwk: companionConfig.devicePrivateKeyJwk!,
        deviceKeyThumbprint: companionConfig.deviceKeyThumbprint!,
      }
    )
    await setCogniaSettings(page, {
      mobileRuntimeMode: "paired",
      onboardingProgress: {
        version: 1,
        path: "completed",
        completedAt: "2026-09-07T00:00:00.000Z",
      },
    })
    await page.goto("/remote-sessions", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("remote-sessions-page")).toBeVisible()
    await page.getByTestId(`remote-session-row-${SESSION_ID}`).click()
    const log = page.getByRole("log")
    await expect(log.getByText("Question 0", { exact: true })).toBeVisible()
    await expect(page.getByTestId("remote-connection-pill")).toHaveAttribute(
      "data-state",
      "connected"
    )
    const emit = (event: Record<string, unknown>) =>
      desktop.sendEvent({
        type: "event",
        sessionId: SESSION_ID,
        event: { type: "stream_event", event },
      })
    emit({ type: "message_start", message: { id: "perf-live" } })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Performance.enable")
    const taskDuration = async () => {
      const { metrics } = await cdp.send("Performance.getMetrics")
      const metric = metrics.find((entry) => entry.name === "TaskDuration")
      if (!metric) throw new Error("Chromium TaskDuration is unavailable")
      return metric.value * 1000
    }
    const samples: number[] = []
    for (let sample = 0; sample < 11; sample++) {
      const start = await taskDuration()
      for (let token = 0; token < 100; token++) {
        emit({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } })
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      const duration = (await taskDuration()) - start
      if (sample > 0) samples.push(duration)
      // Reading older content must not be interrupted by the arriving reply.
      await expect(log.getByText("Question 0", { exact: true })).toBeVisible()
      expect(await log.evaluate((element) => element.scrollTop)).toBeLessThan(2)
    }
    await log.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(log.getByText("x".repeat(1100), { exact: true })).toBeVisible()
    const snapshot = {
      project: testInfo.project.name,
      messages: 60,
      tokens: 1100,
      taskDurationMs: samples,
    }
    await testInfo.attach("remote-stream-perf", {
      body: JSON.stringify(snapshot, null, 2),
      contentType: "application/json",
    })
    console.log("[remote-stream-perf]", JSON.stringify(snapshot))
    await cdp.detach()
  })

  test("attaches, controls a turn, resolves approval, and detaches", async ({ page }) => {
    const desktop = await installDesktopBoundaries(page)
    const companionConfig = await provisionMockCompanionConfig(
      mockV2BaseUrl(),
      "device-e2e-remote-session"
    )

    await injectCapacitor(page, {
      platform: "android",
      network: { connected: true, connectionType: "wifi" },
      secureStorage: companionConfigSecureStorage(companionConfig),
    })
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "paired")

    await page.goto("/remote-sessions", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("remote-sessions-page")).toBeVisible()
    const sessionRow = page.getByTestId(`remote-session-row-${SESSION_ID}`)
    await expect(sessionRow).toContainText(SESSION_TITLE)
    await sessionRow.click()

    await expect(page.getByTestId("remote-session-detail")).toBeVisible()
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) => call.command === "session_attach" && call.body.sessionId === SESSION_ID
        )
      )
      .toMatchObject({
        command: "session_attach",
        // No `deviceId`: the Host binds the attachment to the DPoP-verified
        // caller and ignores any id in the payload. `mode` asks for control and
        // lets the Host narrow it to observe.
        body: { sessionId: SESSION_ID, mode: "control" },
      })
    await expect(page.getByTestId("remote-connection-pill")).toHaveAttribute(
      "data-state",
      "connected"
    )

    await page.getByTestId("remote-composer-input").fill(FOLLOW_UP)
    await page.getByTestId("remote-send").click()
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) => call.command === "claude_send" && call.body.sessionId === SESSION_ID
        )
      )
      .toMatchObject({
        command: "claude_send",
        body: { sessionId: SESSION_ID, prompt: FOLLOW_UP },
      })

    await expect(page.getByTestId("remote-streaming-badge")).toBeVisible()
    await page.getByTestId("remote-interrupt").click()
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) => call.command === "claude_interrupt" && call.body.sessionId === SESSION_ID
        )
      )
      .toMatchObject({ command: "claude_interrupt", body: { sessionId: SESSION_ID } })
    await expect(page.getByTestId("remote-send")).toBeVisible()

    desktop.sendEvent({
      type: "permission_request",
      sessionId: SESSION_ID,
      requestId: "approval-e2e-release",
      toolUseID: "tool-use-e2e-release",
      toolName: "Bash",
      input: { command: "git status --short" },
      title: "Inspect release workspace",
      description: "Read the current repository status",
    })
    const approvalCard = page.getByTestId("remote-approval-card")
    await expect(approvalCard).toContainText("Allow Bash?")
    await expect(approvalCard).toContainText("Read the current repository status")
    // The action buttons come from the shared decision surface now, so their
    // ids are kind-scoped rather than remote-scoped; the card around them is
    // still the mobile one.
    await page.getByTestId("decision-deny").click()
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) =>
            call.command === "claude_approve" && call.body.requestId === "approval-e2e-release"
        )
      )
      .toMatchObject({
        command: "claude_approve",
        body: {
          sessionId: SESSION_ID,
          requestId: "approval-e2e-release",
          decision: "deny",
        },
      })
    await expect(page.getByTestId("remote-approval-card")).toHaveCount(0)

    await page.getByTestId("remote-sessions-back").click()
    await expect(page.getByTestId("remote-sessions-list")).toBeVisible()
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) => call.command === "session_detach" && call.body.sessionId === SESSION_ID
        )
      )
      .toMatchObject({
        command: "session_detach",
        // Same as attach: the Host releases the authenticated caller's own
        // lease, so no device id crosses the wire.
        body: { sessionId: SESSION_ID },
      })
  })
})
