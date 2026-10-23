/**
 * Production MV3 worker/socket/runtime/Chrome APIs against the deterministic
 * Host fixture. Only the optional loopback install grant and agent preference
 * are seeded; pairing, per-site decisions, injected overlay and actions are real.
 * The real Rust Host is verified separately in ws_browser_companion tests.
 */
import contract from "@cognia/companion-client/browser-agent-protocol.json"

import { expect, pairThroughPanel, tabIdOf, test } from "./fixtures"

test.use({ extensionProfile: "granted" })

test("negotiates the safety profile and executes the shipped overlay in Chrome", async ({
  panel,
  mockHost,
  context,
  serviceWorker,
}) => {
  const target = await context.newPage()
  const url = mockHost.servePage(
    "agent",
    "<button onclick=\"this.textContent='Clicked'\">Click me</button>"
  )
  await target.goto(url)
  const tabId = await tabIdOf(serviceWorker, url)
  await pairThroughPanel(panel, mockHost.issueEnrollment())
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ "cognia.preferences.v1": { agentMode: true } })
  )
  await expect
    .poll(() => mockHost.agentFrames().find((frame) => frame.t === "hello"))
    .toMatchObject({
      v: contract.envelopeVersion,
      features: expect.arrayContaining([contract.agentProfile]),
    })
  mockHost.sendAgentFrame({
    t: "welcome",
    v: contract.envelopeVersion,
    agentProfile: contract.agentProfile,
    connectionId: "c",
    driveAllowed: true,
  })
  mockHost.sendAgentFrame({
    t: "op",
    id: "snapshot",
    op: "snapshot",
    args: { session: "s", startTabId: tabId },
    deadlineMs: 30_000,
  })
  await expect(
    panel.getByRole("button", { name: "Allow for this task", exact: true })
  ).toBeVisible()
  const refused = await serviceWorker.evaluate(async (tabId) => {
    const stored = await chrome.storage.session.get("cognia.agent.siteQuestions.v1")
    const questions = stored["cognia.agent.siteQuestions.v1"] as { id: string }[]
    const question = questions[0]!
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      args: [question.id],
      func: async (questionId) => {
        return chrome.runtime.sendMessage({
          kind: "cognia-agent-permission",
          action: "answer",
          questionId,
          answer: "always",
        })
      },
    })
    return result?.result
  }, tabId)
  expect(refused).toBe(false)
  await panel.getByRole("button", { name: "Allow for this task", exact: true }).click()
  await expect
    .poll(() => mockHost.agentFrames().find((frame) => frame.id === "snapshot"))
    .toMatchObject({ ok: true })
  const snapshot = mockHost.agentFrames().find((frame) => frame.id === "snapshot")!.value as {
    nodes: { role: string; ref: string }[]
  }
  const ref = snapshot.nodes.find((node) => node.role === "button")!.ref
  mockHost.sendAgentFrame({
    t: "op",
    id: "click",
    op: "act",
    args: { session: "s", ref, action: "click" },
    deadlineMs: 5_000,
  })
  await expect(target.getByRole("button", { name: "Clicked", exact: true })).toBeVisible()
  await expect
    .poll(() => mockHost.agentFrames().find((frame) => frame.id === "click"))
    .toMatchObject({ ok: true })

  // The bar uses a closed shadow root. Send its exact control message from
  // the tab's isolated world so Chrome supplies the real sender.tab identity.
  const control = (action: "stop" | "resume") =>
    serviceWorker.evaluate(
      async ({ tabId, action }) => {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: (action) =>
            chrome.runtime.sendMessage({ kind: "cognia-agent-control", session: "s", action }),
          args: [action],
        })
      },
      { tabId, action }
    )
  await control("stop")
  for (const op of ["release", "finalize_tabs", "evaluate"]) {
    mockHost.sendAgentFrame({
      t: "op",
      id: `paused-${op}`,
      op,
      args: {
        session: "s",
        startTabId: tabId,
        expression: "document.querySelector('button').textContent='Escaped'",
      },
      deadlineMs: 5_000,
    })
    await expect
      .poll(() => mockHost.agentFrames().find((frame) => frame.id === `paused-${op}`))
      .toMatchObject({ ok: false, error: { code: "browser_user_takeover" } })
  }
  await expect(target.getByRole("button", { name: "Clicked", exact: true })).toBeVisible()
  await control("resume")
  mockHost.sendAgentFrame({
    t: "op",
    id: "resumed",
    op: "evaluate",
    args: { session: "s", expression: "document.querySelector('button').textContent='Resumed'" },
    deadlineMs: 5_000,
  })
  await expect
    .poll(() => mockHost.agentFrames().find((frame) => frame.id === "resumed"))
    .toMatchObject({ ok: true })
  await expect(target.getByRole("button", { name: "Resumed", exact: true })).toBeVisible()
})

for (const event of ["revoke", "disconnect", "disable"] as const) {
  test(`cancels a pending site decision on ${event}`, async ({
    panel,
    mockHost,
    context,
    serviceWorker,
  }) => {
    const target = await context.newPage()
    const url = mockHost.servePage(
      "pending",
      "<button onclick=\"this.textContent='Clicked'\">Click me</button>"
    )
    await target.goto(url)
    const tabId = await tabIdOf(serviceWorker, url)
    await pairThroughPanel(panel, mockHost.issueEnrollment())
    await serviceWorker.evaluate(() =>
      chrome.storage.local.set({ "cognia.preferences.v1": { agentMode: true } })
    )
    await expect.poll(() => mockHost.agentFrames().some((frame) => frame.t === "hello")).toBe(true)
    mockHost.sendAgentFrame({
      t: "welcome",
      v: 1,
      agentProfile: contract.agentProfile,
      connectionId: "c",
      driveAllowed: true,
    })
    mockHost.sendAgentFrame({
      t: "op",
      id: "pending",
      op: "evaluate",
      args: {
        session: "s",
        startTabId: tabId,
        expression: "document.querySelector('button').click()",
      },
      deadlineMs: 30_000,
    })
    await expect(
      panel.getByRole("button", { name: "Allow for this task", exact: true })
    ).toBeVisible()
    if (event === "revoke") mockHost.sendAgentFrame({ t: "drive", allowed: false })
    else if (event === "disconnect") mockHost.disconnectAgent()
    else
      await serviceWorker.evaluate(() =>
        chrome.storage.local.set({ "cognia.preferences.v1": { agentMode: false } })
      )
    await expect(
      panel.getByRole("button", { name: "Allow for this task", exact: true })
    ).toHaveCount(0)
    if (event !== "disconnect")
      await expect
        .poll(() => mockHost.agentFrames().find((frame) => frame.id === "pending"))
        .toMatchObject({ ok: false })
    await expect(target.getByRole("button", { name: "Click me", exact: true })).toBeVisible()
    expect(
      mockHost.agentFrames().some((frame) => frame.id === "pending" && frame.ok === true)
    ).toBe(false)
  })
}

for (const profile of [null, "agent-safe-v2"]) {
  test(`keeps profile ${profile} status-only`, async ({ panel, mockHost, serviceWorker }) => {
    await pairThroughPanel(panel, mockHost.issueEnrollment())
    await serviceWorker.evaluate(() =>
      chrome.storage.local.set({ "cognia.preferences.v1": { agentMode: true } })
    )
    await expect.poll(() => mockHost.agentFrames().some((frame) => frame.t === "hello")).toBe(true)
    mockHost.sendAgentFrame({
      t: "welcome",
      v: 1,
      agentProfile: profile,
      connectionId: "legacy",
      driveAllowed: true,
    })
    mockHost.sendAgentFrame({
      t: "op",
      id: "legacy",
      op: "create_page",
      args: { session: "s" },
      deadlineMs: 5_000,
    })
    await expect
      .poll(() => mockHost.agentFrames().find((frame) => frame.id === "legacy"))
      .toMatchObject({ ok: false, error: { code: "browser_protocol_incompatible" } })
    await expect
      .poll(() =>
        serviceWorker.evaluate(
          async () =>
            (await chrome.storage.session.get("cognia.socketState.v1"))["cognia.socketState.v1"]
        )
      )
      .toMatchObject({ kind: "status-only" })
  })
}

test("rejects an unknown envelope version without a reconnect loop", async ({
  panel,
  mockHost,
  serviceWorker,
}) => {
  await pairThroughPanel(panel, mockHost.issueEnrollment())
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ "cognia.preferences.v1": { agentMode: true } })
  )
  await expect.poll(() => mockHost.agentFrames().some((frame) => frame.t === "hello")).toBe(true)
  mockHost.sendAgentFrame({ t: "welcome", v: 999, connectionId: "future", driveAllowed: true })
  await expect
    .poll(() =>
      serviceWorker.evaluate(
        async () =>
          (await chrome.storage.session.get("cognia.socketState.v1"))["cognia.socketState.v1"]
      )
    )
    .toMatchObject({ kind: "incompatible" })
  // No retry timer is asserted by the unit test; this catches Chrome rejecting
  // an illegal WebSocket.close code before the incompatible state is stored.
})
