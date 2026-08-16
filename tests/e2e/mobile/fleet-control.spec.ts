/**
 * Mobile E2E: paired Agent Fleet triage and control contract.
 *
 * A deterministic desktop boundary supplies the initial snapshot and accepts
 * permission/reply/focus commands while a real Companion WebSocket pushes a
 * newer snapshot. The product store, sorting, rows, and actions remain real.
 */

import { expect, test, type Page, type WebSocketRoute } from "@/tests/e2e/fixtures/test"

import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import {
  companionConfigSecureStorage,
  provisionMockCompanionConfig,
} from "./companion-fixture"

const PERMISSION_SESSION_ID = "fleet-e2e-permission"
const WORKING_SESSION_ID = "fleet-e2e-working"
const REPLY_TEXT = "Continue with the release checklist"

interface CapturedRpc {
  command: string
  body: Record<string, unknown>
}

function mockV2BaseUrl(): string {
  const baseUrl = process.env.E2E_V2_BASE_URL
  if (!baseUrl) throw new Error("E2E_V2_BASE_URL is required for Fleet E2E")
  return baseUrl
}

function fleetSession(
  overrides: Partial<Record<string, unknown>> & { sessionId: string; status: string }
) {
  const now = Date.now()
  return {
    agent: "opencode",
    cwd: "/workspace/cognia-next",
    projectName: overrides.sessionId,
    lastPrompt: null,
    activity: null,
    permissionMode: "default",
    model: "anthropic/claude-sonnet-4-5",
    terminal: { app: "ghostty", label: "Ghostty" },
    transcriptPath: null,
    agentPid: 42,
    pendingPermission: null,
    capabilities: {
      approvePermission: true,
      sendMessage: true,
      focusTerminal: true,
      openTranscript: false,
    },
    startedAt: now - 60_000,
    lastEventAt: now - 1_000,
    toolUseCount: 1,
    turnCount: 1,
    ...overrides,
  }
}

async function installFleetDesktop(page: Page): Promise<{
  calls: CapturedRpc[]
  pushSnapshot: (sessions: unknown[]) => void
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

    if (command === "fleet_get_snapshot") {
      const now = Date.now()
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          generatedAt: now,
          sessions: [
            fleetSession({
              sessionId: WORKING_SESSION_ID,
              status: "working",
              projectName: "Release worker",
              lastPrompt: "Prepare the rollout",
              activity: { toolName: "Bash", detail: "pnpm test" },
              lastEventAt: now,
            }),
            fleetSession({
              sessionId: PERMISSION_SESSION_ID,
              status: "waiting-permission",
              projectName: "Permission review",
              pendingPermission: {
                requestId: "fleet-permission-e2e",
                toolName: "Bash",
                detail: "git status --short",
                requestedAt: now,
              },
              lastEventAt: now - 5_000,
            }),
          ],
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

    const result = command === "fleet_permission_respond" ? true : null
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(result) })
  })

  return {
    calls,
    pushSnapshot(sessions) {
      if (!socket) throw new Error("the Fleet WebSocket is not connected")
      socket.send(
        JSON.stringify({
          type: "fleet://update",
          seq: Date.now(),
          payload: { sessions, generatedAt: Date.now() + 1_000 },
          ts_ms: Date.now(),
        })
      )
    },
  }
}

test.describe("mobile — Agent Fleet control", () => {
  test("triages a snapshot, responds, replies, focuses, and receives a live update", async ({
    page,
  }) => {
    const desktop = await installFleetDesktop(page)
    const companionConfig = await provisionMockCompanionConfig(
      mockV2BaseUrl(),
      "device-e2e-fleet"
    )
    await injectCapacitor(page, {
      platform: "android",
      network: { connected: true, connectionType: "wifi" },
      secureStorage: companionConfigSecureStorage(companionConfig),
    })
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "paired")

    await page.goto("/fleet", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("mobile-fleet-screen")).toBeVisible()
    await expect(page.getByTestId("mobile-fleet-summary")).toContainText("2")

    const permissionRow = page.getByTestId(
      `mobile-fleet-row-opencode-${PERMISSION_SESSION_ID}`
    )
    const workingRow = page.getByTestId(`mobile-fleet-row-opencode-${WORKING_SESSION_ID}`)
    await expect(permissionRow).toHaveAttribute("data-status", "waiting-permission")
    await expect(permissionRow).toContainText("git status --short")
    await expect(workingRow).toContainText("Bash(pnpm test)")

    await permissionRow.getByTestId("mobile-permission-deny").click()
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) =>
            call.command === "fleet_permission_respond" &&
            call.body.requestId === "fleet-permission-e2e"
        )
      )
      .toMatchObject({
        command: "fleet_permission_respond",
        body: { requestId: "fleet-permission-e2e", behavior: "deny" },
      })
    await expect(permissionRow.getByTestId("mobile-permission-answered")).toBeVisible()

    await workingRow.getByTestId("mobile-fleet-reply-open").click()
    await workingRow.getByTestId("mobile-fleet-reply-input").fill(REPLY_TEXT)
    await workingRow.getByTestId("mobile-fleet-reply-send").click()
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) =>
            call.command === "fleet_opencode_send_message" &&
            call.body.sessionId === WORKING_SESSION_ID
        )
      )
      .toMatchObject({
        command: "fleet_opencode_send_message",
        body: { sessionId: WORKING_SESSION_ID, text: REPLY_TEXT },
      })

    await workingRow.getByTestId("mobile-fleet-focus").click()
    await expect
      .poll(() =>
        desktop.calls.find(
          (call) => call.command === "fleet_focus_terminal" && call.body.sessionId === WORKING_SESSION_ID
        )
      )
      .toMatchObject({
        command: "fleet_focus_terminal",
        body: { agent: "opencode", sessionId: WORKING_SESSION_ID },
      })

    desktop.pushSnapshot([
      fleetSession({
        sessionId: "fleet-e2e-idle",
        status: "idle",
        projectName: "Live update received",
      }),
    ])
    await expect(page.getByText("Live update received")).toBeVisible()
    await expect(permissionRow).toHaveCount(0)
    await expect(page.getByTestId("mobile-fleet-summary")).toContainText("1")
  })
})
