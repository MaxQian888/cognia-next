/**
 * Cognia Cloud sign-in, end to end, through the real gate (ADR-0149).
 *
 * Every other spec in this lane walks past the gate: `NEXT_PUBLIC_E2E=1`
 * lets a browser in without a person. This one runs against a bundle built
 * with `NEXT_PUBLIC_E2E_CLOUD_GATE=1`, so the gate is live, and proves the
 * whole path a first owner and a second person take:
 *
 * 1. The browser is pointed at a multi-tenant gateway (the install-level
 *    deployment record, the same seam Settings writes), creates its local
 *    profile, and meets the sign-in screen with the GitHub method.
 * 2. "Continue with GitHub" opens the identity provider (the OIDC fixture,
 *    which accepts `direct_sign_in` and signs the context's subject in), the
 *    callback lands, and the person is signed in but in no organization.
 * 3. The bootstrap credential claims the deployment. The gate passes.
 * 4. The owner mints an invitation on the collaboration server. A second
 *    browser signs in as somebody else, redeems it, and lands in the same
 *    organization.
 *
 * The identity provider is the deterministic fixture, not GitHub itself:
 * what is under test is Cognia's chain from `/api/auth/config` through Logto's
 * protocol to the account plane, not GitHub's login page.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test"

const webOrigin = process.env.COGNIA_REAL_WEB_URL ?? "https://cognia.localhost"
const cloudGateway = process.env.COGNIA_REAL_CLOUD_URL ?? "https://127.0.0.1:27894"
/** The fixture as Node reaches it (published port). The browser uses the mapped name. */
const fixtureNodeUrl = process.env.COGNIA_REAL_OIDC_FIXTURE_URL ?? "http://127.0.0.1:4020"
const fixtureBrowserUrl =
  process.env.COGNIA_REAL_OIDC_FIXTURE_BROWSER_URL ?? "http://oidc-fixture:4020"
/** collab-server on its published port, so Node needs no Caddy trust. */
const collabDirectUrl = process.env.COGNIA_REAL_COLLAB_DIRECT_URL ?? "http://127.0.0.1:8080"
const audience = process.env.COGNIA_REAL_CLOUD_AUDIENCE ?? "https://cognia.localhost/api"
const bootstrapCredential = process.env.COGNIA_REAL_BOOTSTRAP_CREDENTIAL
const vaultPassword = "cognia-real-e2e-password"

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} must be set for the cloud sign-in lane`)
  return value
}

async function contextFor(browser: Browser, subject: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: webOrigin, ignoreHTTPSErrors: true })
  // The deployment record Settings would write: the gate discovers this
  // gateway instead of the single-user Host behind the same origin.
  await context.addInitScript(
    (record: { key: string; value: string }) => {
      try {
        window.localStorage.setItem(record.key, record.value)
      } catch {
        // A context without storage cannot run this lane at all.
      }
    },
    {
      key: "cognia.cloud.deployment.default",
      value: JSON.stringify({ baseUrl: cloudGateway }),
    }
  )
  // Pick who this context signs in as. The fixture keeps it in a cookie on
  // its own origin, which the authorization popup carries back to it.
  const page = await context.newPage()
  await page.goto(
    `${fixtureBrowserUrl}/e2e/as?sub=${encodeURIComponent(subject)}&return=${encodeURIComponent(`${webOrigin}/`)}`
  )
  await page.waitForURL((url) => url.origin === webOrigin)
  await page.close()
  return context
}

async function createBrowserAccount(page: Page, label: string): Promise<void> {
  await page.goto("/")
  const accountForm = page.locator("form")
  await accountForm.locator('input:not([type="password"])').fill(label)
  await accountForm.locator('input[type="password"]').fill(vaultPassword)
  await accountForm.locator('button[type="submit"]').click()

  const recovery = page.getByTestId("account-vault-recovery")
  await expect(recovery).toBeVisible()
  await recovery.getByRole("checkbox").check()
  await page.getByTestId("account-vault-recovery-continue").click()
}

/** Click the social method and let the popup round-trip complete. */
async function signInWithGitHub(context: BrowserContext, page: Page): Promise<void> {
  const gate = page.getByTestId("cloud-sign-in")
  await expect(gate).toBeVisible()
  await expect(gate).toHaveAttribute("data-view", "sign-in")
  const popupPromise = context.waitForEvent("page")
  await page.getByTestId("cloud-sign-in-social-github").click()
  const popup = await popupPromise
  // The fixture answers the authorization request with a redirect to the
  // callback page, which hands the code to its opener and closes itself.
  await popup.waitForEvent("close", { timeout: 60_000 }).catch(() => undefined)
  await expect(gate).toHaveAttribute("data-view", "unaffiliated", { timeout: 60_000 })
}

async function passedTheGate(page: Page): Promise<void> {
  await expect(page.getByTestId("cloud-sign-in")).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByTestId("account-vault-recovery")).toHaveCount(0)
}

async function fixtureToken(subject: string): Promise<string> {
  const response = await fetch(`${fixtureNodeUrl}/e2e/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sub: subject, aud: audience, scope: "openid" }),
  })
  if (!response.ok) throw new Error(`fixture token: ${response.status}`)
  const body = (await response.json()) as { access_token: string }
  return body.access_token
}

async function memberships(token: string): Promise<{ orgId: string; userId: string }[]> {
  const response = await fetch(`${collabDirectUrl}/v1/account/memberships`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`memberships: ${response.status} ${await response.text()}`)
  const body = (await response.json()) as { memberships: { orgId: string; userId: string }[] }
  return body.memberships
}

async function mintInvitation(token: string, orgId: string): Promise<string> {
  const grantResponse = await fetch(
    `${collabDirectUrl}/v1/orgs/${encodeURIComponent(orgId)}/grants`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    }
  )
  if (!grantResponse.ok) throw new Error(`grant: ${grantResponse.status}`)
  const { grant } = (await grantResponse.json()) as { grant: string }
  const response = await fetch(
    `${collabDirectUrl}/v1/orgs/${encodeURIComponent(orgId)}/invitations`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
      body: JSON.stringify({ orgRole: "member", reason: "cloud sign-in lane" }),
    }
  )
  if (!response.ok) throw new Error(`invitation: ${response.status} ${await response.text()}`)
  const body = (await response.json()) as { token: string }
  return body.token
}

test("the gateway announces a multi-tenant deployment a browser can join", async ({ request }) => {
  const response = await request.get(`${cloudGateway}/api/auth/config`)
  expect(response.ok()).toBe(true)
  const config = (await response.json()) as {
    deploymentMode: string
    oidc?: { socialProviders: { provider: string }[] }
    collaboration?: { serviceUrl: string; webOrigin?: string }
  }
  expect(config.deploymentMode).toBe("multi-tenant")
  expect(config.oidc?.socialProviders.map((provider) => provider.provider)).toEqual(
    expect.arrayContaining(["github"])
  )
  // A browser reaches the collaboration plane on the web origin, not on the
  // compose network address the brain uses.
  expect(config.collaboration?.serviceUrl).toBe(`${webOrigin}/collab`)
  expect(config.collaboration?.webOrigin).toBe(webOrigin)
})

test("a first owner claims the deployment through GitHub, then invites a second person", async ({
  browser,
}) => {
  const credential = required(bootstrapCredential, "COGNIA_REAL_BOOTSTRAP_CREDENTIAL")

  const ownerContext = await contextFor(browser, "e2e-owner")
  const owner = await ownerContext.newPage()
  await createBrowserAccount(owner, "Cloud Owner")
  await signInWithGitHub(ownerContext, owner)
  await expect(owner.getByTestId("cloud-sign-in-person")).toContainText("Ada Owner")

  await owner.getByTestId("cloud-sign-in-credential").fill(credential)
  await owner.getByTestId("cloud-sign-in-org-name").fill("E2E Org")
  await owner.getByTestId("cloud-sign-in-claim-submit").click()
  await passedTheGate(owner)

  const ownerToken = await fixtureToken("e2e-owner")
  const ownerMemberships = await memberships(ownerToken)
  expect(ownerMemberships).toHaveLength(1)
  const orgId = ownerMemberships[0]!.orgId
  expect(orgId).toMatch(/^org_/)
  const invitation = await mintInvitation(ownerToken, orgId)
  await ownerContext.close()

  const bobContext = await contextFor(browser, "e2e-bob")
  const bob = await bobContext.newPage()
  await createBrowserAccount(bob, "Cloud Member")
  await signInWithGitHub(bobContext, bob)
  await expect(bob.getByTestId("cloud-sign-in-person")).toContainText("Bob Member")
  await bob.getByTestId("cloud-sign-in-token").fill(invitation)
  await bob.getByTestId("cloud-sign-in-redeem-submit").click()
  await passedTheGate(bob)

  const bobMemberships = await memberships(await fixtureToken("e2e-bob"))
  expect(bobMemberships).toHaveLength(1)
  expect(bobMemberships[0]!.orgId).toBe(orgId)
  expect(bobMemberships[0]!.userId).not.toBe(ownerMemberships[0]!.userId)
  await bobContext.close()
})
