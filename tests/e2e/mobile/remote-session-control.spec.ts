/**
 * Mobile E2E: paired Remote Session control contract.
 *
 * The real companion transport talks to HTTP and WebSocket boundaries owned
 * by a deterministic desktop-host double. The test proves list → attach →
 * send → interrupt → approval → detach without replacing the route, hooks,
 * transport, or durable mobile shell.
 */

import { expect, test, type Page, type WebSocketRoute } from "@/tests/e2e/fixtures/test"

import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import {
  companionConfigSecureStorage,
  provisionMockCompanionConfig,
} from "./companion-fixture"

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

async function installDesktopBoundaries(page: Page): Promise<{
  calls: CapturedRpc[]
  sendEvent: (payload: Record<string, unknown>) => void
}> {
  const calls: CapturedRpc[] = []
  let socket: WebSocketRoute | null = null
  const baseUrl = mockV2BaseUrl()

  await page.routeWebSocket(/\/ws\/events(?:\?|$)/, (route) => {
    socket = route
  })

  await page.route(`${baseUrl}/api/_rpc/**`, async (route) => {
    const request = route.request()
    const command = new URL(request.url()).pathname.split("/").pop() ?? ""
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>
    calls.push({ command, body })

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
          seq: Date.now(),
          payload,
          ts_ms: Date.now(),
        })
      )
    },
  }
}

test.describe("mobile — remote session control", () => {
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
        body: { sessionId: SESSION_ID, deviceId: companionConfig.deviceId },
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
    await page.getByTestId("remote-approval-deny").click()
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) => call.command === "claude_approve" && call.body.requestId === "approval-e2e-release"
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
        body: { sessionId: SESSION_ID, deviceId: companionConfig.deviceId },
      })
  })
})
