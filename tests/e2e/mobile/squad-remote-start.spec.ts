/** Paired phone → scoped lease/start → canonical run/control and durable plan review.
 * Real UI, Companion transport and Dexie sync; intercepted Host RPCs do not prove Rust authorization.
 */
import { expect, test, type Page, type WebSocketRoute } from "@/tests/e2e/fixtures/test"
import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"
import type { AgentTeamRow } from "@/lib/db/agent-team-definitions"
import type { ExecutionRun, ExecutionRunInterrupt, RunControlAction } from "@/types/execution/run"
import {
  bootstrapCogniaMobile,
  readDexieRow,
  setCogniaSettings,
  waitForPluginRuntimeReady,
} from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { companionConfigSecureStorage, provisionMockCompanionConfig } from "./companion-fixture"

const TEAM = "remote-review-squad"
const RUN = "execution:team:host-canonical-run"
const TITLE = "Review release evidence"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
interface Call {
  command: string
  body: Record<string, unknown>
  key: string | undefined
}
type Scenario = "success" | "consent" | "lost" | "busy" | "blocked" | "denied" | "plan"

function hostSquad(): AgentTeamRow {
  return {
    id: TEAM,
    name: "Host review squad",
    task: TITLE,
    description: "Host-owned release review",
    status: "idle",
    config: {
      ...DEFAULT_TEAM_CONFIG,
      requirePlanApproval: true,
      repositories: [{ id: "repo", role: "primary", path: "/host/release", writable: true }],
      environmentRef: { environmentId: "env", versionId: "env-v1" },
    },
    leadId: "lead",
    teammateIds: ["lead", "worker"],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function installHost(page: Page, initial: Scenario) {
  const base = process.env.E2E_V2_BASE_URL
  if (!base) throw new Error("V2 mock base URL unavailable")
  const calls: Call[] = []
  let socket: WebSocketRoute | undefined
  let seq = 0
  let scenario = initial
  let revision = 0
  let current: ExecutionRun | undefined
  let interrupt: ExecutionRunInterrupt | undefined
  const squad = hostSquad()
  const publish = () =>
    socket?.send(
      JSON.stringify({
        type: "sync://invalidate",
        seq: ++seq,
        payload: { table: "executionRuns" },
        ts_ms: Date.now(),
      })
    )
  const project = (status: ExecutionRun["status"], allowedActions: RunControlAction[]) => {
    const now = Date.now()
    current = {
      id: RUN,
      kind: "team",
      sourceId: "host-canonical-run",
      title: TITLE,
      status,
      currentRevision: ++revision,
      startedAt: now - 1000,
      updatedAt: now,
      latestSnapshot: {
        runId: RUN,
        kind: "team",
        teamId: TEAM,
        title: TITLE,
        status,
        revision,
        startedAt: now - 1000,
        updatedAt: now,
        progress: { completed: 0, total: 1, trustworthy: true },
        activeSteps: [],
        recentSteps: [],
        pendingSteps: [],
        pendingStepCount: 0,
        elapsedMs: 1000,
        artifacts: [],
        allowedActions,
        ...(interrupt?.status === "pending"
          ? { pendingInterrupt: { id: interrupt.id, title: interrupt.title, type: interrupt.type } }
          : {}),
      },
    }
    publish()
  }
  await page.routeWebSocket(/\/ws\/events(?:\?|$)/, (route) => {
    socket = route
    route.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; channels?: string[] }
      if (frame.type === "subscribe") {
        route.send(JSON.stringify({ type: "subscribed", channels: frame.channels ?? [] }))
        route.send(JSON.stringify({ type: "stream_ready", cursor: seq }))
      }
    })
  })
  await page.route(`${base}/api/_rpc/**`, async (route) => {
    const request = route.request()
    const command = new URL(request.url()).pathname.split("/").pop()!
    const body = request.postDataJSON() as Record<string, unknown>
    const call = { command, body, key: request.headers()["idempotency-key"] }
    calls.push(call)
    const reply = (value: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(value) })
    if (command === "sync_pull") {
      const rows =
        body.table === "agentTeams"
          ? [squad]
          : body.table === "executionRuns" && current
            ? [current]
            : []
      return reply({ rows, deleted_ids: [], next_since: Date.now(), has_more: false })
    }
    if (command === "host_admin_lease_issue") {
      expect(body).toMatchObject({
        operations: [expect.stringMatching(/^(team_run_start|execution_run_control)$/)],
        ttlSeconds: 120,
      })
      if (scenario === "consent") {
        return route.fulfill({
          status: 428,
          contentType: "application/json",
          body: JSON.stringify({
            code: "REMOTE_CONSENT_REQUIRED",
            message: "REMOTE_CONSENT_REQUIRED (code SQUAD123)",
            detail: "REMOTE_CONSENT_REQUIRED (code SQUAD123)",
          }),
        })
      }
      return reply({
        token: `lease-${calls.length}`,
        operations: body.operations,
        expiresAt: Date.now() + 120_000,
      })
    }
    if (command === "team_run_start") {
      expect(body.teamId).toBe(TEAM)
      expect(body.launchId).toMatch(UUID)
      expect(call.key).toMatch(UUID)
      expect(body.adminLease).toEqual(expect.any(String))
      expect(body).not.toHaveProperty("callerDeviceId")
      expect(body).not.toHaveProperty("origin")
      if (scenario === "denied")
        return route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ code: "permission_denied", message: "device denied" }),
        })
      if (scenario === "blocked")
        return reply({
          started: false,
          reason: "not_ready",
          blockers: [{ code: "missing_environment_ref", action: "configure_environment" }],
        })
      if (scenario === "busy")
        return reply({
          started: false,
          reason: "already_running",
          runId: "host-canonical-run",
          executionRunId: RUN,
        })
      if (scenario === "lost") return route.abort("connectionreset")
      if (scenario === "plan") {
        interrupt = {
          id: "plan-review-host",
          runId: RUN,
          type: "plan_approval",
          reviewKind: "plan",
          status: "pending",
          title: "Review release plan",
          subject: { revision: 1 },
          createdAt: Date.now(),
          expiresAt: Date.now() + 600_000,
        }
        project("waiting", ["approve", "deny", "stop"])
      } else project("running", ["pause", "stop"])
      return reply({
        started: true,
        runId: "host-canonical-run",
        executionRunId: RUN,
        squadName: squad.name,
        duplicate: calls.filter((c) => c.command === command).length > 1,
      })
    }
    if (command === "execution_run_detail")
      return reply({ run: current, events: [], interrupts: interrupt ? [interrupt] : [] })
    if (command === "execution_run_control") {
      expect(body.runId).toBe(RUN)
      expect(body.expectedRevision).toBe(revision)
      expect(body.adminLease).toEqual(expect.any(String))
      expect(body).not.toHaveProperty("actor")
      const action = body.action
      if (action === "pause") project("paused", ["resume", "stop"])
      else if (action === "resume") project("running", ["pause", "stop"])
      else if (action === "stop") project("cancelled", [])
      else if ((action === "approve" || action === "deny") && interrupt) {
        expect(body.interruptId).toBe(interrupt.id)
        expect(body.reviewDecision).toMatchObject({ kind: "plan" })
        interrupt = {
          ...interrupt,
          status: action === "approve" ? "approved" : "denied",
          resolvedAt: Date.now(),
        }
        project(
          action === "approve" ? "running" : "cancelled",
          action === "approve" ? ["pause", "stop"] : []
        )
      } else throw new Error(`Unexpected run control ${String(action)}`)
      return reply({ accepted: true })
    }
    // The shared V2 mock owns unrelated supported boot operations and refuses unknown commands.
    return route.continue()
  })
  return {
    calls,
    base,
    setScenario(next: Scenario) {
      scenario = next
    },
    current: () => current,
  }
}

async function boot(page: Page, scenario: Scenario = "success") {
  const host = await installHost(page, scenario)
  const config = await provisionMockCompanionConfig(host.base)
  await injectCapacitor(page, {
    platform: "android",
    network: { connected: true, connectionType: "wifi" },
    secureStorage: companionConfigSecureStorage(config),
  })
  await page.goto("/onboarding")
  await bootstrapCogniaMobile(page, "paired", {
    onboardingProgress: { version: 1, path: "completed", completedAt: "2026-10-06T00:00:00.000Z" },
  })
  await waitForPluginRuntimeReady(page, 60_000)
  await page.waitForFunction(() => typeof window.__cogniaSaveCompanionConfig === "function")
  await page.evaluate(async (value) => window.__cogniaSaveCompanionConfig!(value), {
    ...config,
    devicePrivateKeyJwk: config.devicePrivateKeyJwk!,
    deviceKeyThumbprint: config.deviceKeyThumbprint!,
  })
  await setCogniaSettings(page, {
    mobileRuntimeMode: "paired",
    onboardingProgress: { version: 1, path: "completed", completedAt: "2026-10-06T00:00:00.000Z" },
  })
  await page.goto(`/squads?id=${TEAM}`, { waitUntil: "domcontentloaded" })
  await expect
    .poll(() => readDexieRow(page, { table: "agentTeams", key: TEAM }))
    .toMatchObject({ id: TEAM })
  // Definitions hydrate at account boot; retain the canonical sync-written row across reload.
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("squad-fleet-inspector")).toBeVisible()
  await expect(page.getByTestId("start-team")).toBeEnabled()
  return host
}

test.describe("mobile — remote Squad start", () => {
  test("starts once, controls the canonical run, and opens Runs", async ({ page }) => {
    const host = await boot(page)
    await page.getByTestId("start-team").dblclick()
    await expect(page.getByTestId("pause-team")).toBeVisible()
    expect(host.calls.filter((c) => c.command === "team_run_start")).toHaveLength(1)
    await page.getByTestId("pause-team").click()
    await expect(page.getByTestId("resume-team")).toBeVisible()
    await page.getByTestId("resume-team").click()
    await expect(page.getByTestId("pause-team")).toBeVisible()
    await page.getByRole("link", { name: "Open run" }).click()
    await expect(page).toHaveURL(new RegExp(`run=${encodeURIComponent(RUN)}`))
    await expect(page.getByRole("dialog")).toContainText(TITLE)
    await page.getByRole("button", { name: "Stop", exact: true }).click()
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
    expect(
      host.calls.filter((c) => c.command === "execution_run_control").map((c) => c.body.action)
    ).toEqual(["pause", "resume", "stop"])
    expect(host.calls.some((c) => /^team_run_(pause|resume|stop)$/.test(c.command))).toBe(false)
  })
  test("consent and lost-response retries preserve the gesture with fresh lease keys", async ({
    page,
  }) => {
    const host = await boot(page, "consent")
    await page.getByTestId("start-team").click()
    await expect(page.getByTestId("squad-fleet-inspector").getByRole("alert")).toContainText(
      "SQUAD123"
    )
    expect(host.calls.filter((c) => c.command === "team_run_start")).toHaveLength(0)
    host.setScenario("lost")
    await page.getByRole("button", { name: "Retry this start" }).click()
    await expect(page.getByTestId("squad-fleet-inspector").getByRole("alert")).toContainText(
      "could not be confirmed"
    )
    const lost = host.calls.filter((c) => c.command === "team_run_start")
    expect(lost.length).toBeGreaterThan(0)
    host.setScenario("success")
    await page.getByRole("button", { name: "Retry this start" }).click()
    await expect(page.getByTestId("pause-team")).toBeVisible()
    const latest = host.calls.filter((c) => c.command === "team_run_start").at(-1)!
    expect(latest.body.launchId).toBe(lost[0].body.launchId)
    expect(latest.key).not.toBe(lost[0].key)
    expect(latest.body.adminLease).not.toBe(lost[0].body.adminLease)
  })
  for (const [scenario, message] of [
    ["busy", "already running"],
    ["blocked", "No environment is chosen"],
    ["denied", "not allowed"],
  ] as const) {
    test(`shows the Host ${scenario} refusal`, async ({ page }) => {
      await boot(page, scenario)
      await page.getByTestId("start-team").click()
      await expect(page.getByTestId("squad-fleet-inspector").getByRole("alert")).toContainText(
        message
      )
      await expect(page.getByTestId("pause-team")).toHaveCount(0)
    })
  }
  for (const decision of ["approve", "deny"] as const) {
    test(`a durable plan review survives reload and sends ${decision}`, async ({ page }) => {
      const host = await boot(page, "plan")
      await page.getByTestId("start-team").click()
      await page.getByRole("link", { name: "Open run" }).click()
      await expect(page.getByTestId("squad-review-form")).toHaveAttribute(
        "data-review-kind",
        "plan"
      )
      await page.reload({ waitUntil: "domcontentloaded" })
      await expect(page.getByTestId("squad-review-form")).toHaveAttribute(
        "data-review-kind",
        "plan"
      )
      await page.getByLabel("Feedback for the lead").fill("Include the release rollback check")
      await page
        .getByTestId("squad-review-form")
        .getByRole("button", {
          name: decision === "approve" ? "Approve plan" : "Request changes",
          exact: true,
        })
        .click()
      await expect(page.getByTestId("squad-review-form")).toHaveCount(0)
      expect(
        host.calls.filter((c) => c.command === "execution_run_control").at(-1)?.body
      ).toMatchObject({
        action: decision,
        runId: RUN,
        interruptId: "plan-review-host",
        reviewDecision: { kind: "plan", feedback: "Include the release rollback check" },
      })
    })
  }
  test("an offline start is not queued or replayed on reconnect", async ({ page, context }) => {
    const host = await boot(page)
    const before = host.calls.filter((c) => c.command === "team_run_start").length
    await context.setOffline(true)
    await page.getByTestId("start-team").click()
    await expect(page.getByTestId("squad-fleet-inspector").getByRole("alert")).toContainText(
      "not queued"
    )
    await context.setOffline(false)
    await expect(page.getByTestId("start-team")).toBeEnabled()
    await page.getByTestId("squad-fleet-configure").focus()
    expect(host.calls.filter((c) => c.command === "team_run_start")).toHaveLength(before)
    // Reconnection may remount the phone sheet; only an explicit gesture may start work.
    await page.getByTestId("start-team").click()
    await expect(page.getByTestId("pause-team")).toBeVisible()
    expect(host.calls.filter((c) => c.command === "team_run_start")).toHaveLength(before + 1)
  })
})
