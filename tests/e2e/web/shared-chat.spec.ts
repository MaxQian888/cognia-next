import { expect, test, type Page, type Route } from "@/tests/e2e/fixtures/test"

const ORG_ID = "org_e2e000000000000000000"
const USER_ID = "usr_e2e000000000000000000"
const GUEST_ID = "usr_guest00000000000000000"
const WORKSPACE_ID = "default"
const BASE_URL = "https://collab-e2e.test"

interface CollabScenario {
  session: Record<string, unknown> | null
  sequence: number
  invites: Array<Record<string, unknown>>
  members: Array<Record<string, unknown>>
  approvals: Array<Record<string, unknown>>
  queue: Array<Record<string, unknown>>
  requests: Array<{ method: string; pathname: string; body: unknown }>
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

async function installCollabScenario(page: Page): Promise<CollabScenario> {
  const now = Date.now()
  const scenario: CollabScenario = {
    session: null,
    sequence: 0,
    invites: [],
    members: [
      {
        sessionId: "shared-e2e",
        userId: USER_ID,
        displayName: "E2E Owner",
        role: "owner",
        approver: true,
        guest: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        sessionId: "shared-e2e",
        userId: GUEST_ID,
        displayName: "External Reviewer",
        role: "member",
        approver: false,
        guest: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    approvals: [
      {
        id: "approval-e2e",
        sessionId: "shared-e2e",
        runId: "run-e2e",
        action: "delete production artifact",
        risk: "high",
        requestedByUserId: GUEST_ID,
        status: "pending",
        expiresAt: now + 60_000,
        createdAt: now,
        revision: 1,
      },
    ],
    queue: [
      {
        id: "queue-e2e",
        sessionId: "shared-e2e",
        requestedByUserId: GUEST_ID,
        payload: { text: "queued follow-up" },
        status: "queued",
        position: 1,
        createdAt: now,
      },
    ],
    requests: [],
  }

  await page.addInitScript(
    ({ orgId, userId, baseUrl }) => {
      window.__cogniaCollabE2EContext = {
        orgId,
        userId,
        baseUrl,
        accessToken: "e2e-access-token",
      }
    },
    { orgId: ORG_ID, userId: USER_ID, baseUrl: BASE_URL }
  )

  await page.route(`${BASE_URL}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const body = request.postData() ? request.postDataJSON() : null
    scenario.requests.push({ method, pathname: url.pathname, body })

    if (url.pathname.endsWith("/grants")) {
      return json(route, {
        grant: "e2e-grant",
        userId: USER_ID,
        orgId: ORG_ID,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      })
    }
    if (url.pathname.endsWith("/memberships/me")) {
      return json(route, {
        userId: USER_ID,
        orgId: ORG_ID,
        orgRole: "owner",
        workspaces: [{ workspaceId: WORKSPACE_ID, role: "owner" }],
      })
    }
    if (method === "POST" && url.pathname.endsWith("/chat-sessions")) {
      scenario.session = {
        id: "shared-e2e",
        orgId: ORG_ID,
        workspaceId: WORKSPACE_ID,
        title: (body as { title: string }).title,
        status: "importing",
        createdBy: { kind: "human", id: USER_ID, displayName: "E2E Owner" },
        createdAt: now,
        updatedAt: now,
        revision: 1,
        policyRevision: 1,
      }
      return json(route, scenario.session, 201)
    }
    if (method === "PATCH" && /\/chat-sessions\/shared-e2e$/.test(url.pathname)) {
      scenario.session = {
        ...scenario.session,
        status: (body as { status?: string }).status ?? "active",
        revision: 2,
        updatedAt: Date.now(),
      }
      return json(route, scenario.session)
    }
    if (method === "GET" && /\/chat-sessions\/shared-e2e$/.test(url.pathname)) {
      return json(route, scenario.session)
    }
    if (url.pathname.endsWith("/events") && method === "POST") {
      scenario.sequence += 1
      const input = body as { kind: string; payload: Record<string, unknown>; operationId: string }
      return json(
        route,
        {
          id: `event-${scenario.sequence}`,
          sessionId: "shared-e2e",
          sequence: scenario.sequence,
          kind: input.kind,
          actor: { kind: "human", id: USER_ID },
          payload: input.payload,
          createdAt: Date.now(),
          operationId: input.operationId,
        },
        201
      )
    }
    if (url.pathname.endsWith("/members") && method === "GET") {
      return json(route, scenario.members)
    }
    if (/\/members\/[^/]+$/.test(url.pathname) && method === "DELETE") {
      const userId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "")
      scenario.members = scenario.members.filter((member) => member.userId !== userId)
      return json(route, {})
    }
    if (url.pathname.endsWith("/invites") && method === "GET") {
      return json(route, scenario.invites)
    }
    if (url.pathname.endsWith("/invites") && method === "POST") {
      const input = body as { role: string; guest?: boolean; expiresAt: number }
      const invite = {
        id: "invite-e2e",
        sessionId: "shared-e2e",
        role: input.role,
        approver: false,
        guest: Boolean(input.guest),
        expiresAt: input.expiresAt,
        status: "pending",
        createdByUserId: USER_ID,
        createdAt: Date.now(),
      }
      scenario.invites = [invite]
      return json(route, { invite, token: "invite-secret-visible-once" }, 201)
    }
    if (url.pathname.endsWith("/approvals") && method === "GET") {
      return json(route, scenario.approvals)
    }
    if (/\/approvals\/[^/]+$/.test(url.pathname) && method === "PATCH") {
      scenario.approvals = []
      return json(route, { ...(scenario.approvals[0] ?? {}), status: "approved", revision: 2 })
    }
    if (url.pathname.endsWith("/run-leases") && method === "GET") return json(route, null)
    if (url.pathname.endsWith("/queue") && method === "GET") return json(route, scenario.queue)
    if (/\/queue\/[^/]+$/.test(url.pathname) && method === "DELETE") {
      scenario.queue = []
      return json(route, { id: "queue-e2e", status: "cancelled" })
    }
    if (url.pathname.endsWith("/audit") && method === "GET") return json(route, [])
    return json(route, { error: `Unhandled E2E route ${method} ${url.pathname}` }, 500)
  })

  return scenario
}

async function configureStandaloneChat(page: Page) {
  await page.goto("/")
  const createAccount = page.getByRole("form", { name: "Create local account" })
  const needsAccount = await createAccount
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (needsAccount) {
    await createAccount.getByRole("textbox", { name: "Account name" }).fill("Shared Chat E2E")
    await createAccount.getByLabel("Password").fill("Shared-chat-E2E-2026!")
    await createAccount.getByRole("button", { name: "Create account" }).click()
  }
  await expect(page.getByRole("textbox", { name: /message/i }).first()).toBeVisible({
    timeout: 30_000,
  })
}

test.describe("web — shared AI chat", () => {
  test.beforeEach(async ({ page }) => {
    await installCollabScenario(page)
    await configureStandaloneChat(page)
  })

  test("@critical imports full history only after explicit confirmation", async ({ page }) => {
    await page.getByRole("button", { name: "Open private conversation controls" }).click()
    await expect(page.getByText(/0 messages and 0 attachments/i)).toBeVisible()
    await expect(page.getByText(/invitees can read the complete history/i)).toBeVisible()
    await page.getByRole("button", { name: /convert and share/i }).click()
    await expect(page.getByText(/conversation is now shared/i)).toBeVisible()

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(
      page.getByRole("button", { name: "Open shared conversation controls" })
    ).toBeVisible()
  })

  test("@critical manages Guest, queue, and high-risk approval from the shared drawer", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Open private conversation controls" }).click()
    await page.getByRole("button", { name: /convert and share/i }).click()
    await page.reload({ waitUntil: "domcontentloaded" })

    await page.getByRole("button", { name: "Open shared conversation controls" }).click()
    await expect(page.getByText("External Reviewer")).toBeVisible()
    await expect(page.getByText("External guest")).toBeVisible()
    await expect(page.getByText(/#1 queued by/)).toBeVisible()
    await expect(page.getByText("delete production artifact")).toBeVisible()

    await page.getByRole("button", { name: "Approve" }).click()
    await expect(page.getByText("delete production artifact")).toHaveCount(0)

    await page.getByRole("checkbox", { name: "External guest" }).check()
    await page.getByRole("button", { name: /create invite/i }).click()
    await expect(page.getByRole("button", { name: "Copy one-time invite token" })).toBeVisible()

    const guestRow = page.getByText("External Reviewer").locator("../..")
    await guestRow.getByRole("button", { name: "Remove" }).click()
    await expect(page.getByText("External Reviewer")).toHaveCount(0)
  })
})
