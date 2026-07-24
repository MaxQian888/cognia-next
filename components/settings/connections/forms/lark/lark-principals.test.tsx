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
import { LarkPrincipals } from "./lark-principals"

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

  it("disables and re-enables a registered tenant", async () => {
    await seedAdapter()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    const user = userEvent.setup({ delay: null })
    render(<LarkPrincipals adapterId={ADAPTER_ID} />)

    await user.click(await screen.findByTestId("lark-tenant-toggle"))
    await waitFor(async () => {
      expect((await getFeishuTenant("tk_a", "cli_1"))?.status).toBe("disabled")
    })

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

  async function seedBoundPrincipal() {
    await seedAdapter()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    return createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_1",
      cogniaAccountId: "acct_a",
      cogniaUserId: "acct_a",
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
})
