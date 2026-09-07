import type { Page, Route, WebSocketRoute } from "@playwright/test"

export const ORG_ID = "org_e2e000000000000000000"
export const USER_ID = "usr_e2e000000000000000000"
export const GUEST_ID = "usr_guest00000000000000000"
const WORKSPACE_ID = "default"
export const BASE_URL = "https://collab-e2e.test"

export interface CollabScenario {
  session: Record<string, unknown> | null
  events: Array<Record<string, unknown>>
  sockets: Set<WebSocketRoute>
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

export async function installCollabScenario(
  page: Page,
  existing?: CollabScenario,
  userId = USER_ID
): Promise<CollabScenario> {
  const now = Date.now()
  const scenario: CollabScenario = existing ?? {
    events: [],
    sockets: new Set(),
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
    { orgId: ORG_ID, userId, baseUrl: BASE_URL }
  )

  await page.routeWebSocket("wss://collab-e2e.test/**", (socket) => {
    scenario.sockets.add(socket)
    socket.onClose(() => scenario.sockets.delete(socket))
  })
  await page.route(`${BASE_URL}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const body = request.postData() ? request.postDataJSON() : null
    scenario.requests.push({ method, pathname: url.pathname, body })

    if (url.pathname === "/health")
      return json(route, { status: "ok", features: ["shared-chat", "shared-chat-execution-v2"] })
    if (url.pathname.endsWith("/stream-tickets"))
      return json(route, { ticket: "test-ticket", expiresAt: Date.now() + 60_000 })
    if (url.pathname.endsWith("/chat-sessions") && method === "GET")
      return json(route, scenario.session ? [scenario.session] : [])
    if (url.pathname.endsWith("/events") && method === "GET")
      return json(
        route,
        scenario.events.filter(
          (event) => Number(event.sequence) > Number(url.searchParams.get("afterSequence") ?? 0)
        )
      )
    if (url.pathname.endsWith("/chat-invites/accept") && method === "POST")
      return json(route, {
        invite: { sessionId: "shared-e2e" },
        membership: scenario.members.find((member) => member.userId === userId),
      })
    if (url.pathname.endsWith("/queue") && method === "POST") {
      const input = body as { payload: unknown; operationId: string }
      const item = {
        id: `queue-${scenario.queue.length + 1}`,
        sessionId: "shared-e2e",
        requestedByUserId: userId,
        payload: input.payload,
        operationId: input.operationId,
        position: scenario.queue.length + 1,
        status: "queued",
        createdAt: Date.now(),
      }
      scenario.queue.push(item)
      return json(route, item, 201)
    }
    if (url.pathname.endsWith("/queue/claim"))
      return json(route, { code: "CONFLICT", message: "Executor unavailable" }, 409)
    if (/\/invites\/[^/]+$/.test(url.pathname) && method === "DELETE") {
      const invite = scenario.invites.find((item) => item.id === url.pathname.split("/").at(-1))
      if (invite) invite.status = "revoked"
      return json(route, invite)
    }
    if (url.pathname.endsWith("/grants")) {
      return json(route, {
        grant: "e2e-grant",
        userId,
        orgId: ORG_ID,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      })
    }
    if (url.pathname.endsWith("/memberships/me")) {
      return json(route, {
        userId,
        orgId: ORG_ID,
        orgRole: "owner",
        workspaces: [{ workspaceId: WORKSPACE_ID, role: "owner" }],
      })
    }
    if (method === "POST" && url.pathname.endsWith("/chat-sessions")) {
      scenario.session = {
        id: "shared-e2e",
        orgId: ORG_ID,
        workspaceId: decodeURIComponent(url.pathname.split("/").at(-2) ?? WORKSPACE_ID),
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
      const event = {
        id: `event-${scenario.sequence}`,
        sessionId: "shared-e2e",
        sequence: scenario.sequence,
        kind: input.kind,
        actor: { kind: "human", id: userId },
        payload: input.payload,
        createdAt: Date.now(),
        operationId: input.operationId,
      }
      scenario.events.push(event)
      for (const socket of scenario.sockets) socket.send(JSON.stringify(event))
      return json(route, event, 201)
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
