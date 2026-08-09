import { execFileSync } from "node:child_process"

import { expect, test, type Page } from "@playwright/test"

const pairPayload = process.env.COGNIA_REAL_PAIR_PAYLOAD
const lifecyclePairPayload = process.env.COGNIA_REAL_LIFECYCLE_PAIR_PAYLOAD
const adminPairPayload = process.env.COGNIA_REAL_ADMIN_PAIR_PAYLOAD
const revokeePairPayload = process.env.COGNIA_REAL_REVOKEE_PAIR_PAYLOAD
const secondPairPayload = process.env.COGNIA_REAL_SECOND_PAIR_PAYLOAD
const oidcMemberPairPayload = process.env.COGNIA_REAL_OIDC_MEMBER_PAIR_PAYLOAD
const oidcOwnerPairPayload = process.env.COGNIA_REAL_OIDC_OWNER_PAIR_PAYLOAD
const composeDir = process.env.COGNIA_REAL_COMPOSE_DIR
const webOrigin = process.env.COGNIA_REAL_WEB_URL ?? "https://cognia.localhost"
const directOrigin = process.env.COGNIA_REAL_DIRECT_URL ?? "https://127.0.0.1:27890"
const secondDirectOrigin = process.env.COGNIA_REAL_SECOND_URL ?? "https://127.0.0.1:27891"
const oidcMemberOrigin = process.env.COGNIA_REAL_OIDC_MEMBER_URL ?? "https://127.0.0.1:27892"
const oidcOwnerOrigin = process.env.COGNIA_REAL_OIDC_OWNER_URL ?? "https://127.0.0.1:27893"
const vaultPassword = "cognia-real-e2e-password"
const memberCapabilities = ["host.observe", "agent.run", "workspace.read"]

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(name + " must contain a fresh cgnp3 invitation")
  return value
}

function hostIdFromPairPayload(payload: string): string {
  const encoded = payload.split("|", 2)[1]
  if (!encoded) throw new Error("pair payload is missing its encoded body")
  const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
    host?: unknown
  }
  if (typeof decoded.host !== "string" || decoded.host.length === 0) {
    throw new Error("pair payload is missing its host identity")
  }
  return decoded.host
}

async function createBrowserAccount(page: Page, label: string): Promise<void> {
  // Create the account on the destination route. A full navigation after
  // creation intentionally locks the browser vault again, so pairing must
  // continue in the same unlocked document.
  await page.goto("/pair")
  const accountForm = page.locator("form")
  await accountForm.locator('input:not([type="password"])').fill(label)
  await accountForm.locator('input[type="password"]').fill(vaultPassword)
  await accountForm.locator('button[type="submit"]').click()

  const recovery = page.getByTestId("account-vault-recovery")
  await expect(recovery).toBeVisible()
  await recovery.getByRole("checkbox").check()
  await page.getByTestId("account-vault-recovery-continue").click()
}

async function pairThroughUi(page: Page, payload: string): Promise<void> {
  await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")
  await page.getByTestId("pair-payload").fill(payload)
  await page.getByTestId("pair-submit").click()
  await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "paired")
  await page.waitForFunction(() => window.__cogniaE2ECompanion?.connectionState() === "connected")
  await expect
    .poll(async () =>
      page.evaluate(async () => (await window.__cogniaE2ECompanion?.runtime())?.targetId ?? null)
    )
    .not.toBe("web-standalone")
}

async function createPairedAccount(page: Page, label: string, payload: string): Promise<void> {
  await createBrowserAccount(page, label)
  await pairThroughUi(page, payload)
}

function killHeadlessBrain(): void {
  const cwd = required(composeDir, "COGNIA_REAL_COMPOSE_DIR")
  const script = [
    "attempt=0",
    "killed=0",
    'while [ "$attempt" -lt 12 ]; do',
    "  for file in /proc/[0-9]*/cmdline; do",
    "    command=\"$(tr '\\000' ' ' < \"$file\")\"",
    '    case "$command" in',
    '      "node /app/brain/cli.mjs serve"*)',
    '        pid="$(echo "$file" | cut -d/ -f3)"',
    '        kill -9 "$pid" 2>/dev/null || true',
    "        killed=1",
    "        break",
    "        ;;",
    "    esac",
    "  done",
    "  attempt=$((attempt + 1))",
    "  sleep 0.1",
    "done",
    '[ "$killed" -eq 1 ]',
  ].join("\n")
  execFileSync("docker", ["compose", "exec", "-T", "cognia-server", "sh", "-c", script], {
    cwd,
    stdio: "pipe",
  })
}

test("pairing, chat, replay recovery, and browser reload remain one session", async ({ page }) => {
  const payload = required(pairPayload, "COGNIA_REAL_PAIR_PAYLOAD")
  await createPairedAccount(page, "Web Headless Core", payload)
  const runtime = await page.evaluate(() => window.__cogniaE2ECompanion!.runtime())
  expect(runtime).toMatchObject({
    targetId: hostIdFromPairPayload(payload),
    deviceId: expect.any(String),
    baseUrl: webOrigin,
  })

  const manifest = await page.evaluate(() =>
    window.__cogniaE2ECompanion!.call("host_feature_manifest", {})
  )
  expect(manifest).toMatchObject({
    platform: "headless",
    hostIdentity: { kind: "cloud" },
    transportCapabilities: { eventStreamReady: 1 },
    deviceGrants: expect.arrayContaining([
      "host.observe",
      "agent.run",
      "workspace.read",
      "scheduler.manage",
    ]),
  })

  await page.evaluate(() => window.__cogniaE2ECompanion!.subscribe("claude://message"))
  await page.evaluate(() =>
    window.__cogniaE2ECompanion!.call("claude_send", {
      session_id: "web-headless-real-e2e",
      prompt: "reply through the deterministic provider",
      options: {
        allowedTools: [],
        maxTurns: 1,
        settingSources: [],
        systemPrompt: "Reply exactly as provided by the test provider.",
      },
    })
  )
  await page.waitForFunction(
    () =>
      JSON.stringify(window.__cogniaE2ECompanion!.events("claude://message")).includes(
        "[web-headless-e2e] deterministic assistant reply"
      ),
    undefined,
    { timeout: 60_000 }
  )

  await page.evaluate(() => window.__cogniaE2ECompanion!.subscribe("companion://device-seen"))
  await page.evaluate(() => window.__cogniaE2ECompanion!.call("host_feature_manifest", {}))
  await page.waitForFunction(
    () => window.__cogniaE2ECompanion!.events("companion://device-seen").length > 0
  )
  const deliveredBeforeReconnect = await page.evaluate(
    () => window.__cogniaE2ECompanion!.events("companion://device-seen").length
  )

  await page.waitForFunction(
    () => window.__cogniaE2ECompanion!.activeTier() === "rtc-direct",
    undefined,
    { timeout: 45_000 }
  )
  await page.evaluate(() => window.__cogniaE2ECompanion!.disableRtc())
  await page.waitForFunction(() => window.__cogniaE2ECompanion!.activeTier() === "ws-tunnel")
  await page.evaluate(() => window.__cogniaE2ECompanion!.reconnectWs())
  await page.evaluate(() => window.__cogniaE2ECompanion!.call("host_feature_manifest", {}))
  await page.waitForFunction(
    (previous) => window.__cogniaE2ECompanion!.events("companion://device-seen").length > previous,
    deliveredBeforeReconnect
  )

  const publicStorage = await page.evaluate(() => JSON.stringify(window.localStorage))
  expect(publicStorage).not.toContain('"d"')
  expect(publicStorage).not.toContain("PRIVATE KEY")

  await page.reload()
  const unlockForm = page.locator("form")
  await unlockForm.locator('input[type="password"]').fill(vaultPassword)
  await unlockForm.locator('button[type="submit"]').click()
  await page.waitForFunction(() => Boolean(window.__cogniaE2ECompanion))
  await expect
    .poll(() => page.evaluate(() => window.__cogniaE2ECompanion!.runtime()))
    .toMatchObject({ targetId: runtime!.targetId, deviceId: runtime!.deviceId })
  await expect(
    page.evaluate(() => window.__cogniaE2ECompanion!.call("host_feature_manifest", {}))
  ).resolves.toMatchObject({ platform: "headless" })
})

test("Brain restart fails bridge-only work fast and recovers without duplicate mutation", async ({
  page,
}) => {
  await createPairedAccount(
    page,
    "Web Headless Lifecycle",
    required(lifecyclePairPayload, "COGNIA_REAL_LIFECYCLE_PAIR_PAYLOAD")
  )
  const runtimeBefore = await page.evaluate(() => window.__cogniaE2ECompanion!.runtime())
  const sessionId = "web-headless-brain-restart"
  const uniqueContent = "single mutation " + Date.now()

  killHeadlessBrain()
  const startedAt = Date.now()
  await expect(
    page.evaluate(() =>
      window.__cogniaE2ECompanion!.call("app_settings_update", {
        patch: { colorTheme: "ocean" },
      })
    )
  ).rejects.toThrow(/available|bridge|connect/i)
  expect(Date.now() - startedAt).toBeLessThan(10_000)

  await expect
    .poll(
      async () => {
        try {
          const current = (await page.evaluate(() =>
            window.__cogniaE2ECompanion!.call("host_feature_manifest", {})
          )) as { platform?: string }
          return current.platform
        } catch {
          return "unavailable"
        }
      },
      { timeout: 60_000 }
    )
    .toBe("headless")
  await page.waitForFunction(() => window.__cogniaE2ECompanion!.connectionState() === "connected")

  await expect(
    page.evaluate(
      ({ sessionId: id, content }) =>
        window.__cogniaE2ECompanion!.call("message_send", {
          session_id: id,
          content,
          role: "user",
        }),
      { sessionId, content: uniqueContent }
    )
  ).resolves.toEqual(expect.anything())

  const messages = (await page.evaluate(
    (id) =>
      window.__cogniaE2ECompanion!.call("message_get_by_session", {
        session_id: id,
        limit: 100,
        offset: 0,
      }),
    sessionId
  )) as { rows: Array<{ content: string }> }
  expect(messages.rows.filter((message) => message.content === uniqueContent)).toHaveLength(1)
  await expect(page.evaluate(() => window.__cogniaE2ECompanion!.runtime())).resolves.toMatchObject({
    targetId: runtimeBefore!.targetId,
    deviceId: runtimeBefore!.deviceId,
  })
})

test("authorization revocation and target switching stay isolated", async ({ browser, page }) => {
  await createPairedAccount(
    page,
    "Web Headless Admin",
    required(adminPairPayload, "COGNIA_REAL_ADMIN_PAIR_PAYLOAD")
  )
  const firstRuntime = await page.evaluate(() => window.__cogniaE2ECompanion!.runtime())

  const revokeeContext = await browser.newContext({ baseURL: webOrigin, ignoreHTTPSErrors: true })
  const revokeePage = await revokeeContext.newPage()
  await createPairedAccount(
    revokeePage,
    "Web Headless Revokee",
    required(revokeePairPayload, "COGNIA_REAL_REVOKEE_PAIR_PAYLOAD")
  )
  const revokeeRuntime = await revokeePage.evaluate(() => window.__cogniaE2ECompanion!.runtime())
  expect(revokeeRuntime?.deviceId).not.toBe(firstRuntime?.deviceId)

  const reduced = await page.evaluate(
    ({ deviceId, capabilities }) =>
      window.__cogniaE2ECompanion!.request("PUT", "/api/devices/" + deviceId + "/capabilities", {
        capabilities,
      }),
    { deviceId: revokeeRuntime!.deviceId, capabilities: memberCapabilities }
  )
  expect(reduced).toMatchObject({ status: 200 })
  const reducedManifest = (await revokeePage.evaluate(() =>
    window.__cogniaE2ECompanion!.call("host_feature_manifest", {})
  )) as { deviceGrants: string[] }
  expect(reducedManifest.deviceGrants).toEqual(expect.arrayContaining(memberCapabilities))
  expect(reducedManifest.deviceGrants).toHaveLength(memberCapabilities.length)

  const revoked = await page.evaluate(
    (deviceId) => window.__cogniaE2ECompanion!.request("DELETE", "/api/devices/" + deviceId),
    revokeeRuntime!.deviceId
  )
  expect(revoked).toMatchObject({
    status: 200,
    body: { revokedDeviceId: revokeeRuntime!.deviceId },
  })
  await revokeePage.waitForFunction(
    () =>
      window.__cogniaE2ECompanion!.activeTier() === null ||
      window.__cogniaE2ECompanion!.connectionState() !== "connected"
  )
  await expect(
    revokeePage.evaluate(() => window.__cogniaE2ECompanion!.call("host_feature_manifest", {}))
  ).rejects.toThrow()
  await revokeeContext.close()

  const secondRuntime = await page.evaluate(
    (payload) => window.__cogniaE2ECompanion!.pair(payload),
    required(secondPairPayload, "COGNIA_REAL_SECOND_PAIR_PAYLOAD")
  )
  expect(secondRuntime.targetId).not.toBe(firstRuntime!.targetId)
  expect(secondRuntime.databaseName).not.toBe(firstRuntime!.databaseName)
  expect(secondRuntime.baseUrl).toBe(secondDirectOrigin)

  const targets = await page.evaluate(() => window.__cogniaE2ECompanion!.targets())
  expect(targets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "web-standalone", kind: "standalone" }),
      expect.objectContaining({ id: firstRuntime!.targetId, kind: "companion" }),
      expect.objectContaining({ id: secondRuntime.targetId, kind: "companion" }),
    ])
  )

  await page.evaluate(
    (targetId) => window.__cogniaE2ECompanion!.switchTarget(targetId),
    firstRuntime!.targetId
  )
  await expect(page.evaluate(() => window.__cogniaE2ECompanion!.runtime())).resolves.toMatchObject({
    targetId: firstRuntime!.targetId,
    databaseName: firstRuntime!.databaseName,
    deviceId: firstRuntime!.deviceId,
  })
  await page.evaluate(
    (targetId) => window.__cogniaE2ECompanion!.switchTarget(targetId),
    secondRuntime.targetId
  )
  await expect(page.evaluate(() => window.__cogniaE2ECompanion!.runtime())).resolves.toMatchObject({
    targetId: secondRuntime.targetId,
    databaseName: secondRuntime.databaseName,
    deviceId: secondRuntime.deviceId,
  })
})

test("CORS and private-network access are explicit", async ({ request }) => {
  const allowedPreflight = await request.fetch(directOrigin + "/api/auth/config", {
    method: "OPTIONS",
    headers: {
      Origin: webOrigin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "content-type,dpop",
      "Access-Control-Request-Private-Network": "true",
    },
  })
  expect(allowedPreflight.headers()["access-control-allow-origin"]).toBe(webOrigin)
  expect(allowedPreflight.headers()["access-control-allow-private-network"]).toBe("true")
  expect(allowedPreflight.headers().vary).toContain("Origin")

  const deniedPreflight = await request.fetch(directOrigin + "/api/auth/config", {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Private-Network": "true",
    },
  })
  expect(deniedPreflight.headers()["access-control-allow-origin"]).toBeUndefined()
  expect(deniedPreflight.headers()["access-control-allow-private-network"]).toBeUndefined()
})

test("OIDC member and Owner sessions remain tenant- and scope-bound", async ({ browser }) => {
  const memberContext = await browser.newContext({ baseURL: webOrigin, ignoreHTTPSErrors: true })
  const memberPage = await memberContext.newPage()
  await createPairedAccount(
    memberPage,
    "Web Headless OIDC Member",
    required(oidcMemberPairPayload, "COGNIA_REAL_OIDC_MEMBER_PAIR_PAYLOAD")
  )
  await expect(
    memberPage.evaluate(() => window.__cogniaE2ECompanion!.runtime())
  ).resolves.toMatchObject({
    baseUrl: oidcMemberOrigin,
  })
  const memberManifest = (await memberPage.evaluate(() =>
    window.__cogniaE2ECompanion!.call("host_feature_manifest", {})
  )) as { deviceGrants: string[] }
  expect(memberManifest.deviceGrants).toEqual(expect.arrayContaining(memberCapabilities))
  expect(memberManifest.deviceGrants).toHaveLength(memberCapabilities.length)
  await expect(
    memberPage.evaluate(
      (payload) => window.__cogniaE2ECompanion!.pair(payload),
      required(oidcOwnerPairPayload, "COGNIA_REAL_OIDC_OWNER_PAIR_PAYLOAD")
    )
  ).rejects.toThrow(/issuer, resource, or client does not match/)
  await expect(
    memberPage.evaluate(() => window.__cogniaE2ECompanion!.runtime())
  ).resolves.toMatchObject({
    baseUrl: oidcMemberOrigin,
  })
  await memberContext.close()

  const ownerContext = await browser.newContext({ baseURL: webOrigin, ignoreHTTPSErrors: true })
  const ownerPage = await ownerContext.newPage()
  await createPairedAccount(
    ownerPage,
    "Web Headless OIDC Owner",
    required(oidcOwnerPairPayload, "COGNIA_REAL_OIDC_OWNER_PAIR_PAYLOAD")
  )
  await expect(
    ownerPage.evaluate(() => window.__cogniaE2ECompanion!.runtime())
  ).resolves.toMatchObject({
    baseUrl: oidcOwnerOrigin,
  })
  const ownerManifest = await ownerPage.evaluate(() =>
    window.__cogniaE2ECompanion!.call("host_feature_manifest", {})
  )
  expect(ownerManifest).toMatchObject({
    deviceGrants: expect.arrayContaining(["host.admin", "device.admin", "scheduler.manage"]),
  })
  const ownerDevices = await ownerPage.evaluate(() =>
    window.__cogniaE2ECompanion!.request("GET", "/api/devices")
  )
  expect(ownerDevices).toMatchObject({
    status: 200,
    body: { devices: [expect.objectContaining({ role: "owner" })] },
  })
  await ownerContext.close()
})
