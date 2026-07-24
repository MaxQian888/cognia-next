/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createBindRequest,
  createFeishuPrincipal,
  getFeishuTenant,
  upsertFeishuTenant,
} from "@/lib/db/feishu-principals"
import { runPrincipalAdminIntent } from "./admin-intent"

const WHOAMI = { botName: "bot", appId: "cli_1", openId: "ou_bot", tenantKey: "tk_a" }

function deps(row: unknown = { id: "lark-1", settings: {}, lastWhoamiResult: WHOAMI }) {
  return { getAdapter: (async () => row) as never }
}

describe("runPrincipalAdminIntent", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("rejects an unknown op", async () => {
    expect(await runPrincipalAdminIntent({ adapterId: "lark-1", op: "nope" }, deps())).toEqual({
      ok: false,
      error: "op_unknown",
    })
  })

  it("lists tenant scope, pending requests and bound principals", async () => {
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_1",
      cogniaAccountId: "acct_a",
      cogniaUserId: "acct_a",
    })
    const request = await createBindRequest({ openId: "ou_2", adapterId: "lark-1" })

    const outcome = await runPrincipalAdminIntent({ adapterId: "lark-1", op: "list" }, deps())

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.tenant).toEqual({ tenantKey: "tk_a", appId: "cli_1" })
    expect(outcome.result.requests).toEqual([expect.objectContaining({ code: request.id })])
    expect(outcome.result.principals).toEqual([
      expect.objectContaining({ openId: "ou_1", status: "active" }),
    ])
  })

  it("lists with a null tenant when whoami has no tenant key yet", async () => {
    const outcome = await runPrincipalAdminIntent(
      { adapterId: "lark-1", op: "list" },
      deps({ id: "lark-1", settings: {}, lastWhoamiResult: { botName: "b", appId: "cli_1" } })
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.tenant).toBeNull()
    expect(outcome.result.principals).toEqual([])
  })

  it("approves a bind request", async () => {
    const request = await createBindRequest({
      openId: "ou_new",
      adapterId: "lark-1",
      tenantKey: "tk_a",
      appId: "cli_1",
    })
    const outcome = await runPrincipalAdminIntent(
      { adapterId: "lark-1", op: "approve", code: request.id },
      deps()
    )
    expect(outcome).toEqual({
      ok: true,
      result: { principalId: expect.any(String), openId: "ou_new", status: "active" },
    })
  })

  it("requires a code for approve and reject", async () => {
    expect(await runPrincipalAdminIntent({ adapterId: "lark-1", op: "approve" }, deps())).toEqual({
      ok: false,
      error: "code_required",
    })
    expect(await runPrincipalAdminIntent({ adapterId: "lark-1", op: "reject" }, deps())).toEqual({
      ok: false,
      error: "code_required",
    })
  })

  it("rejects a bind request", async () => {
    const request = await createBindRequest({ openId: "ou_x", adapterId: "lark-1" })
    const outcome = await runPrincipalAdminIntent(
      { adapterId: "lark-1", op: "reject", code: request.id },
      deps()
    )
    expect(outcome).toEqual({ ok: true, result: { code: request.id, status: "rejected" } })
  })

  it("validates principal id and status before writing", async () => {
    expect(
      await runPrincipalAdminIntent(
        { adapterId: "lark-1", op: "set-principal-status", status: "disabled" },
        deps()
      )
    ).toEqual({ ok: false, error: "principal_required" })
    expect(
      await runPrincipalAdminIntent(
        { adapterId: "lark-1", op: "set-principal-status", principalId: "fp_1", status: "bogus" },
        deps()
      )
    ).toEqual({ ok: false, error: "status_invalid" })
  })

  it("changes a principal status", async () => {
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    const principal = await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_1",
      cogniaAccountId: "acct_a",
      cogniaUserId: "acct_a",
    })
    const outcome = await runPrincipalAdminIntent(
      {
        adapterId: "lark-1",
        op: "set-principal-status",
        principalId: principal.id,
        status: "unlinked",
      },
      deps()
    )
    expect(outcome).toEqual({
      ok: true,
      result: { principalId: principal.id, status: "unlinked" },
    })
  })

  it("registers and disables the tenant from the adapter's own whoami scope", async () => {
    const registered = await runPrincipalAdminIntent(
      { adapterId: "lark-1", op: "register-tenant" },
      deps()
    )
    expect(registered).toEqual({
      ok: true,
      result: { tenantId: expect.any(String), tenantKey: "tk_a", appId: "cli_1", status: "active" },
    })

    const disabled = await runPrincipalAdminIntent(
      { adapterId: "lark-1", op: "set-tenant-status", status: "disabled" },
      deps()
    )
    expect(disabled.ok).toBe(true)
    expect((await getFeishuTenant("tk_a", "cli_1"))?.status).toBe("disabled")
  })

  it("refuses tenant operations when the scope is unknown", async () => {
    const noScope = deps({ id: "lark-1", settings: {}, lastWhoamiResult: undefined })
    expect(
      await runPrincipalAdminIntent({ adapterId: "lark-1", op: "register-tenant" }, noScope)
    ).toEqual({ ok: false, error: "tenant_scope_unknown" })
    expect(
      await runPrincipalAdminIntent(
        { adapterId: "lark-1", op: "set-tenant-status", status: "active" },
        noScope
      )
    ).toEqual({ ok: false, error: "tenant_scope_unknown" })
  })

  it("validates the tenant status value", async () => {
    expect(
      await runPrincipalAdminIntent(
        { adapterId: "lark-1", op: "set-tenant-status", status: "paused" },
        deps()
      )
    ).toEqual({ ok: false, error: "status_invalid" })
  })

  it("sweeps stale bind requests", async () => {
    await createBindRequest({ openId: "ou_old", adapterId: "lark-1", now: 0 })
    expect(await runPrincipalAdminIntent({ adapterId: "lark-1", op: "sweep" }, deps())).toEqual({
      ok: true,
      result: { expired: 1 },
    })
  })

  it("returns the operator-facing reason when the admin layer throws", async () => {
    const outcome = await runPrincipalAdminIntent(
      { adapterId: "lark-1", op: "approve", code: "fb_missing" },
      deps()
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain("not found")
  })
})
