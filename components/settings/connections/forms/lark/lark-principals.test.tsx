/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    t.has = () => true
    return t
  },
}))

import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  createBindRequest,
  createFeishuPrincipal,
  getFeishuPrincipal,
  getFeishuTenant,
  upsertFeishuTenant,
} from "@/lib/db/feishu-principals"
import { linkExternalIdentity, putWorkspaceMembership, upsertUser } from "@/lib/db/identity"
import { CogniaAccountRegistryDB } from "@/lib/accounts/account-db"
import { UserBindingRegistry } from "@/lib/identity/user-binding"
import { getActiveRuntimeAccountId } from "@/lib/connectors/principal/resolve"
import { LarkPrincipals } from "./lark-principals"

async function signInAsOwner() {
  await new UserBindingRegistry().bind({
    localAccountId: getActiveRuntimeAccountId(),
    userId: "usr_owner",
    logtoSubject: "sub_owner",
    logtoIssuer: "https://id.example/oidc",
    displayName: "Owner",
  })
}

const ADAPTER_ID = "lark-admin-1"
const WHOAMI = { botName: "bot", appId: "cli_1", openId: "ou_bot", tenantKey: "tk_a" }

async function seedAdapter(whoami: Record<string, unknown> | undefined = WHOAMI) {
  await getDb().adapterInstances.put({
    id: ADAPTER_ID,
    type: "lark",
    displayName: "Admin Bot",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    settings: {},
    ...(whoami ? { lastWhoamiResult: whoami } : {}),
  } as never)
}

describe("LarkPrincipals", () => {
  beforeEach(async () => {
    await getDb().delete()
    await new CogniaAccountRegistryDB().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("explains the missing tenant scope instead of offering a broken register button", async () => {
    await seedAdapter(undefined)
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    expect(await screen.findByTestId("lark-tenant-unknown")).toBeInTheDocument()
    expect(screen.queryByTestId("lark-tenant-register")).not.toBeInTheDocument()
  })

  it("registers the adapter's own tenant scope", async () => {
    await seedAdapter()
    const user = userEvent.setup({ delay: null })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    await user.click(await screen.findByTestId("lark-tenant-register"))

    await waitFor(async () => {
      const tenant = await getFeishuTenant("tk_a", "cli_1")
      expect(tenant?.status).toBe("active")
    })
  })

  it("disables a registered tenant", async () => {
    await seedAdapter()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    const user = userEvent.setup({ delay: null })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    await user.click(await screen.findByTestId("lark-tenant-toggle"))

    await waitFor(async () => {
      expect((await getFeishuTenant("tk_a", "cli_1"))?.status).toBe("disabled")
    })
  })

  it("re-enables a disabled tenant", async () => {
    await seedAdapter()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    const tenant = await getFeishuTenant("tk_a", "cli_1")
    await getDb().feishuTenants.put({ ...tenant!, status: "disabled" })
    const user = userEvent.setup({ delay: null })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    await user.click(await screen.findByTestId("lark-tenant-toggle"))

    await waitFor(async () => {
      expect((await getFeishuTenant("tk_a", "cli_1"))?.status).toBe("active")
    })
  })

  it("approves a pending bind request into a live principal", async () => {
    await seedAdapter()
    const request = await createBindRequest({
      openId: "ou_new",
      adapterId: ADAPTER_ID,
      tenantKey: "tk_a",
      appId: "cli_1",
    })
    const user = userEvent.setup({ delay: null })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    await user.click(await screen.findByTestId(`lark-bind-approve-${request.id}`))

    await waitFor(async () => {
      const principal = await getFeishuPrincipal("tk_a", "cli_1", "ou_new")
      expect(principal?.status).toBe("active")
    })
    await waitFor(async () => {
      expect((await getDb().feishuPrincipalBindRequests.get(request.id))?.status).toBe("approved")
    })
  })

  it("rejects a pending bind request without minting a principal", async () => {
    await seedAdapter()
    const request = await createBindRequest({
      openId: "ou_no",
      adapterId: ADAPTER_ID,
      tenantKey: "tk_a",
      appId: "cli_1",
    })
    const user = userEvent.setup({ delay: null })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    await user.click(await screen.findByTestId(`lark-bind-reject-${request.id}`))

    await waitFor(async () => {
      expect((await getDb().feishuPrincipalBindRequests.get(request.id))?.status).toBe("rejected")
    })
    expect(await getFeishuPrincipal("tk_a", "cli_1", "ou_no")).toBeUndefined()
  })

  it("only lists bind requests belonging to this adapter", async () => {
    await seedAdapter()
    const mine = await createBindRequest({ openId: "ou_a", adapterId: ADAPTER_ID })
    const other = await createBindRequest({ openId: "ou_b", adapterId: "lark-other" })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    expect(await screen.findByTestId(`lark-bind-request-${mine.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`lark-bind-request-${other.id}`)).not.toBeInTheDocument()
  })

  async function seedBoundPrincipal(cogniaUserId = "usr_ada") {
    await seedAdapter()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    return createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_1",
      cogniaAccountId: "acct_a",
      cogniaUserId,
    })
  }

  it("disables a bound principal", async () => {
    const principal = await seedBoundPrincipal()
    // `delay: null` — the default inter-event delay plus a liveQuery
    // re-render round-trip pushes this past the 5 s budget on a loaded runner.
    const user = userEvent.setup({ delay: null })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    await user.click(await screen.findByTestId(`lark-principal-toggle-${principal.id}`))

    await waitFor(async () => {
      expect((await getDb().feishuPrincipals.get(principal.id))?.status).toBe("disabled")
    })
  })

  it("unlinks a bound principal", async () => {
    const principal = await seedBoundPrincipal()
    const user = userEvent.setup({ delay: null })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    await user.click(await screen.findByTestId(`lark-principal-unlink-${principal.id}`))

    await waitFor(async () => {
      expect((await getDb().feishuPrincipals.get(principal.id))?.status).toBe("unlinked")
    })
  })

  it("surfaces a failed action instead of swallowing it", async () => {
    await seedAdapter()
    // A request with no tenant scope cannot be approved — the operator must
    // see why rather than watch a button do nothing.
    const request = await createBindRequest({ openId: "ou_scopeless", adapterId: ADAPTER_ID })
    const user = userEvent.setup({ delay: null })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    await user.click(await screen.findByTestId(`lark-bind-approve-${request.id}`))

    const error = await screen.findByTestId("lark-principals-error")
    expect(error.textContent).toContain("lacks tenant scope")
  })

  it("names the person behind a principal instead of only their open_id", async () => {
    const principal = await seedBoundPrincipal()
    await upsertUser({ id: "usr_ada", displayName: "Ada Lovelace", createdAt: 1, updatedAt: 1 })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    // The name arrives on the live query's first resolution, one tick after
    // the fallback paints.
    await waitFor(async () => {
      expect(await screen.findByTestId(`lark-principal-person-${principal.id}`)).toHaveTextContent(
        "Ada Lovelace"
      )
    })
    // The open_id is still shown — it is what an operator matches against the
    // Feishu console — but it is no longer the only thing on the row.
    expect(await screen.findByTestId(`lark-principal-${principal.id}`)).toHaveTextContent("ou_1")
  })

  it("falls back to the raw id for a row bound before the identity plane existed", async () => {
    // Pre-Batch-5 rows hold a LocalProfile id here. A searchable id beats a
    // word that says nothing.
    const principal = await seedBoundPrincipal("acct_a")
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    expect(await screen.findByTestId(`lark-principal-person-${principal.id}`)).toHaveTextContent(
      "acct_a"
    )
  })

  it("reports what access the person actually has, which is usually none", async () => {
    const principal = await seedBoundPrincipal()
    await upsertUser({ id: "usr_ada", displayName: "Ada", createdAt: 1, updatedAt: 1 })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    // Being bound is permission to reach the agent, not membership of
    // anything — the badge is what stops those two reading as one grant.
    await waitFor(async () => {
      expect(
        await screen.findByTestId(`lark-principal-standing-${principal.id}`)
      ).toHaveTextContent("standing.unaffiliated")
    })

    await putWorkspaceMembership({
      workspaceId: "proj_1",
      orgId: "org_acme",
      userId: "usr_ada",
      role: "viewer",
      now: 2,
    })

    await waitFor(async () => {
      expect(
        await screen.findByTestId(`lark-principal-standing-${principal.id}`)
      ).toHaveTextContent("standing.guest")
    })
  })

  it("offers no 'this is me' approval on a profile nobody signed in on", async () => {
    await seedAdapter()
    const request = await createBindRequest({
      openId: "ou_new",
      unionId: "on_owner",
      adapterId: ADAPTER_ID,
      tenantKey: "tk_a",
      appId: "cli_1",
    })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    expect(await screen.findByTestId(`lark-bind-approve-${request.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`lark-bind-approve-as-me-${request.id}`)).not.toBeInTheDocument()
    expect(screen.queryByTestId(`lark-bind-matches-${request.id}`)).not.toBeInTheDocument()
  })

  it("labels the request that matches the sign-in, and approving it as me confirms the owner", async () => {
    await seedAdapter()
    await signInAsOwner()
    await linkExternalIdentity({
      userId: "usr_owner",
      provider: "lark",
      subject: "on_owner",
      tenant: "tk_a",
    })
    const mine = await createBindRequest({
      openId: "ou_owner",
      unionId: "on_owner",
      adapterId: ADAPTER_ID,
      tenantKey: "tk_a",
      appId: "cli_1",
    })
    const stranger = await createBindRequest({
      openId: "ou_stranger",
      unionId: "on_stranger",
      adapterId: ADAPTER_ID,
      tenantKey: "tk_a",
      appId: "cli_1",
    })
    const user = userEvent.setup({ delay: null })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    expect(await screen.findByTestId(`lark-bind-matches-${mine.id}`)).toHaveTextContent(
      "requestMatchesSignIn"
    )
    expect(screen.queryByTestId(`lark-bind-matches-${stranger.id}`)).not.toBeInTheDocument()
    // The label does not approve anything by itself.
    expect(await getFeishuPrincipal("tk_a", "cli_1", "ou_owner")).toBeUndefined()

    await user.click(screen.getByTestId(`lark-bind-approve-as-me-${mine.id}`))

    await waitFor(async () => {
      const principal = await getFeishuPrincipal("tk_a", "cli_1", "ou_owner")
      expect(principal?.cogniaUserId).toBe("usr_owner")
      expect(principal?.ownerConfirmedAt).toBeDefined()
      expect(principal?.logtoSubject).toBe("sub_owner")
    })
    expect(await screen.findByText("principalOwnerConfirmed")).toBeInTheDocument()
  })

  it("marks principals a self-bind admitted", async () => {
    await seedAdapter()
    const principal = await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_owner",
      cogniaAccountId: "acct_a",
      cogniaUserId: "usr_owner",
      selfBoundAt: 5,
    })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    expect(
      await screen.findByTestId(`lark-principal-self-bound-${principal.id}`)
    ).toHaveTextContent("principalSelfBound")
    expect(screen.queryByTestId(`lark-principal-confirmed-${principal.id}`)).not.toBeInTheDocument()
  })
})
