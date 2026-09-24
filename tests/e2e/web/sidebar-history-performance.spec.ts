import { writeFileSync } from "node:fs"

import { expect, test } from "@/tests/e2e/fixtures/test"
import { createMockCompanionServer } from "../mobile/mock-v2-server"
import { createOwnerPairPayload } from "../mobile/companion-fixture"
import { buildLocalHostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import { transcriptCapabilitiesV1 } from "@/lib/chat/transcript/source"
import { createEmptyHostStateSession, hostStateDigest } from "@cognia/agent-config-types/host-state"
import { ensureCogniaAccount, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

// The sidebar has no existing large-history browser workload. Seed only this
// disposable browser context; exercise the real model, Dexie and row renderer.
test("@critical sidebar preserves natural title order across a large history", async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto("/")
  await ensureCogniaAccount(page)
  await page.goto("about:blank")
  await page.goto("/")
  await waitForTestGlobals(page, 30_000)
  await setCogniaSettings(page, {
    onboardingProgress: { version: 2, path: "completed", completedAt: "2026-09-07T00:00:00.000Z" },
    conversationSidebar: {
      groupBy: "none",
      sortBy: "title",
      showPreview: false,
      showTimestamps: false,
      metadata: [],
    },
  })
  await page.goto("/")
  await waitForTestGlobals(page, 30_000)
  await expect(page.getByRole("button", { name: "New chat", exact: true }).first()).toBeVisible()
  await page.evaluate(async () => {
    // Go through the app repository: raw IndexedDB writes would bypass the
    // encrypted account database and its live-query notifications.
    for (let start = 0; start < 999; start += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, 999 - start) }, (_, offset) =>
          window.__cogniaSeedConversation!({ turns: 0, title: `History ${start + offset}` })
        )
      )
    }
    await window.__cogniaSeedConversation!({ turns: 0, title: "History 999" })
  })
  await page.reload()
  await waitForTestGlobals(page, 30_000)
  // The default rail is the scope tree, whose Chats group previews the newest
  // four rows. "Show all" is where the whole history renders — and, past 200
  // rows, where it is windowed.
  await page.getByTestId("sidebar-scope-more-chats").click()
  const list = page.getByTestId("channel-list-virtual-rows")
  await expect(list).toBeVisible()
  await expect(list.getByRole("button", { name: "History 0", exact: true })).toBeVisible()
  const samples: number[] = []
  for (let sample = 0; sample < 11; sample++) {
    await setCogniaSettings(page, {
      conversationSidebar: {
        groupBy: "none",
        sortBy: "unread",
        showPreview: false,
        showTimestamps: false,
        metadata: [],
      },
    })
    await expect(list.getByRole("button", { name: "History 999", exact: true })).toBeVisible()
    const duration = await page.evaluate(async () => {
      const started = performance.now()
      await window.__cogniaSetSettings!({
        conversationSidebar: {
          groupBy: "none",
          sortBy: "title",
          showPreview: false,
          showTimestamps: false,
          metadata: [],
        },
      })
      await new Promise<void>((resolve) => {
        const check = () => {
          const first = document.querySelector(
            '[data-testid="channel-list-virtual-rows"] li button'
          )
          if (first?.textContent?.trim() === "History 0") requestAnimationFrame(() => resolve())
          else requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      })
      return performance.now() - started
    })
    if (sample > 0) samples.push(duration)
  }
  const titles = await list.locator("li > button").allTextContents()
  expect(titles.slice(0, 10).map((title) => title.trim())).toEqual(
    Array.from({ length: 10 }, (_, index) => `History ${index}`)
  )
  const evidence = { samples, mountedRows: await list.locator("li").count(), conversations: 1000 }
  if (process.env.SIDEBAR_PERF_OUTPUT) {
    writeFileSync(process.env.SIDEBAR_PERF_OUTPUT, JSON.stringify(evidence, null, 2))
  }
  await test.info().attach("sidebar-history-performance", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  })
  // End must materialize the offscreen last row before Enter can select it.
  await list.getByRole("button", { name: "History 0", exact: true }).focus()
  await page.keyboard.press("End")
  await expect(list.getByRole("button", { name: "History 999", exact: true })).toBeVisible()
  await expect(list.locator('li[data-focused="true"]')).toContainText("History 999")
  await expect(list.getByRole("button", { name: "History 999", exact: true })).toBeFocused()
  await page.keyboard.press("Home")
  await expect(list.getByRole("button", { name: "History 0", exact: true })).toBeVisible()
  await expect(list.getByRole("button", { name: "History 0", exact: true })).toBeFocused()
  await page.screenshot({ path: test.info().outputPath("sidebar-keyboard.png") })
})

test("@critical paired web sidebar receives complete recent-first history over HTTP", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const host = createMockCompanionServer()
  await host.start(0)
  // Keep history in the past: selecting the newest conversation may update
  // its timestamp to now, which must leave it at the head of recent order.
  const historyStartedAt = Date.now() - 60_000
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    id: `remote-sidebar-${999 - index}`,
    title: `Remote history ${999 - index}`,
    kind: "direct",
    createdAt: historyStartedAt + 999 - index,
    updatedAt: historyStartedAt + 999 - index,
  }))
  const responses: { since: number; rows: number; bytes: number }[] = []
  try {
    await page.routeWebSocket(/\/ws\/events(?:\?|$)/, (socket) => {
      socket.onMessage((raw) => {
        const frame = JSON.parse(String(raw)) as { type?: string; channels?: string[] }
        if (frame.type === "subscribe") {
          socket.send(JSON.stringify({ type: "subscribed", channels: frame.channels ?? [] }))
          socket.send(JSON.stringify({ type: "stream_ready", cursor: 0 }))
        }
      })
    })
    await page.route(`${host.baseUrl}/api/_rpc/host_state_status`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          hostId: "sidebar-host",
          hostGeneration: 1,
          hostSeq: 0,
          leaseExpiresAt: Date.now() + 60_000,
          pendingDispatch: 0,
          pendingBroadcast: 0,
          recovery: "ready",
        }),
      })
    )
    await page.route(`${host.baseUrl}/api/_rpc/host_state_snapshot`, (route) => {
      const { channel } = route.request().postDataJSON() as { channel: string }
      const sessionId = channel.split("/sessions/")[1]
      const state = sessionId
        ? createEmptyHostStateSession(channel, decodeURIComponent(sessionId))
        : ({ kind: "session-index", channel, revision: 0, sessions: [] } as const)
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          channel,
          hostId: "sidebar-host",
          hostGeneration: 1,
          cutHostSeq: 0,
          revision: 0,
          state,
          digest: hostStateDigest(state),
        }),
      })
    })
    await page.route(`${host.baseUrl}/api/_rpc/host_feature_manifest`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(buildLocalHostFeatureManifest({ platform: "tauri" })),
      })
    )
    for (const command of ["transcript_capabilities", "session_timeline"]) {
      await page.route(`${host.baseUrl}/api/_rpc/${command}`, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            command === "transcript_capabilities"
              ? transcriptCapabilitiesV1()
              : { items: [], revision: 0, hasMore: false }
          ),
        })
      )
    }
    await page.route(`${host.baseUrl}/api/_rpc/sync_pull`, async (route) => {
      // Keep the real HTTP authentication/DPoP exchange, replacing only the
      // host's data response. Browser transport and sync application are real.
      const authenticated = await route.fetch()
      // This mock authenticates every RPC, then rejects data-plane methods
      // absent from its command catalog. A captured call proves DPoP passed.
      expect(authenticated.status()).toBe(404)
      expect(host.rpcCalls.some((call) => call.command === "sync_pull")).toBe(true)
      const body = route.request().postDataJSON() as { table: string; since: number }
      const deltaRows =
        body.table === "sessions" ? rows.filter((row) => row.updatedAt > body.since) : []
      const payload = JSON.stringify({
        rows: deltaRows,
        deleted_ids: [],
        next_since: body.table === "sessions" ? rows[0].updatedAt : body.since,
      })
      if (body.table === "sessions") {
        responses.push({
          since: body.since,
          rows: deltaRows.length,
          bytes: Buffer.byteLength(payload),
        })
      }
      await route.fulfill({ response: authenticated, status: 200, body: payload })
    })
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/")
    await waitForTestGlobals(page, 30_000)
    await setCogniaSettings(page, {
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-09-07T00:00:00.000Z",
      },
    })
    await page.goto("/")
    await waitForTestGlobals(page, 30_000)
    await expect(page.getByRole("button", { name: "New chat", exact: true }).first()).toBeVisible()
    await page.evaluate(
      async (payload) => window.__cogniaE2ECompanion!.pair(payload),
      createOwnerPairPayload(host.baseUrl)
    )
    await setCogniaSettings(page, {
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-09-07T00:00:00.000Z",
      },
      conversationSidebar: {
        groupBy: "workspace",
        sortBy: "recent",
        showTimestamps: false,
        metadata: [],
      },
    })
    await page.goto("/")
    await expect(
      page.getByRole("button", { name: "Remote history 999", exact: true })
    ).toBeVisible()
    await expect
      .poll(() => responses.reduce((sum, response) => sum + response.rows, 0))
      .toBeGreaterThanOrEqual(1000)
    // Receipt precedes the deliberately yielded 200-row apply slices. The
    // Chats label counts its whole group, so it reaching 1000 — not first
    // paint — is the proof every row landed.
    await expect(page.getByTestId("sidebar-scope-label-chats")).toContainText("1000")
    // The rail previews the newest few rows; "Show all" renders the whole
    // history, windowed past 200 rows. Order and reach are read through it
    // rather than by counting DOM rows a windowed list never all mounts.
    await page.getByTestId("sidebar-scope-more-chats").click()
    const list = page.getByTestId("channel-list-virtual-rows")
    await expect(list).toBeVisible()
    const remoteTitles = async () =>
      (await list.locator("li button").allTextContents())
        .map((title) => title.trim())
        .filter((title) => /^Remote history \d+$/.test(title))
    await expect
      .poll(async () => (await remoteTitles()).slice(0, 10))
      .toEqual(Array.from({ length: 10 }, (_, index) => `Remote history ${999 - index}`))
    // The oldest row is reachable, and it is last: End materializes the
    // offscreen tail and lands on it.
    await list.getByRole("button", { name: "Remote history 999", exact: true }).focus()
    await page.keyboard.press("End")
    await expect(list.getByRole("button", { name: "Remote history 0", exact: true })).toBeFocused()
    expect((await remoteTitles()).at(-1)).toBe("Remote history 0")
    if (process.env.SIDEBAR_PERF_OUTPUT) {
      writeFileSync(
        `${process.env.SIDEBAR_PERF_OUTPUT}.http.json`,
        JSON.stringify(responses, null, 2)
      )
    }
    await page.screenshot({ path: test.info().outputPath("sidebar-paired-http.png") })
    await test.info().attach("paired-sidebar-http", {
      body: JSON.stringify(responses, null, 2),
      contentType: "application/json",
    })
  } finally {
    await page.goto("about:blank")
    await page.unrouteAll({ behavior: "wait" })
    await host.stop()
  }
})
