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

function deps(
  row: unknown = { id: "lark-1", type: "lark", settings: {}, lastWhoamiResult: WHOAMI }
) {
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

  describe("oauth-begin", () => {
    const AUTHORIZED = {
      authorizeUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize?x=1",
      state: "lark:lark-1:nonce",
      redirectUri: "https://cognia.example/connectors/oauth/lark/callback",
    }

    function oauthDeps(overrides: Record<string, unknown> = {}) {
      return {
        ...deps(),
        beginOAuth: jest.fn(async () => AUTHORIZED) as never,
        publicBase: (() => "https://cognia.example") as never,
        isDesktop: (() => false) as never,
        ...overrides,
      }
    }

    it("derives the relay redirect from the deployment's public base", async () => {
      const d = oauthDeps()
      const outcome = await runPrincipalAdminIntent({ adapterId: "lark-1", op: "oauth-begin" }, d)
      // `kind` rides along so the CLI can name the right developer console.
      expect(outcome).toEqual({ ok: true, result: { kind: "lark", ...AUTHORIZED } })
      // `/connectors` nest + the relay path — the address the Feishu console
      // must have registered for a self-hosted install.
      expect(d.beginOAuth).toHaveBeenCalledWith({
        adapterId: "lark-1",
        redirectUri: "https://cognia.example/connectors/oauth/lark/callback",
      })
    })

    it("routes a Slack adapter to the Slack begin, on the Slack relay path", async () => {
      // The wire frame only carries `adapterId`; the platform comes from the
      // adapter's own row, so an operator cannot point the wrong begin at it.
      const beginSlack = jest.fn(async () => ({
        authorizeUrl: "https://slack.com/oauth/v2/authorize?x=1",
        state: "slack:sl-1:nonce",
        redirectUri: "https://cognia.example/connectors/oauth/connector/slack/callback",
      }))
      const d = oauthDeps({
        ...deps({ id: "sl-1", type: "slack", settings: {} }),
        beginSlackOAuth: beginSlack as never,
      })

      const outcome = await runPrincipalAdminIntent({ adapterId: "sl-1", op: "oauth-begin" }, d)

      expect(beginSlack).toHaveBeenCalledWith({
        adapterId: "sl-1",
        // Slack gets the generic connector relay; Lark keeps its own path.
        redirectUri: "https://cognia.example/connectors/oauth/connector/slack/callback",
      })
      expect(d.beginOAuth).not.toHaveBeenCalled()
      expect(outcome).toMatchObject({ ok: true, result: { kind: "slack" } })
    })

    it("refuses a platform with no OAuth handler", async () => {
      const d = oauthDeps(deps({ id: "tg-1", type: "telegram", settings: {} }))
      expect(await runPrincipalAdminIntent({ adapterId: "tg-1", op: "oauth-begin" }, d)).toEqual({
        ok: false,
        error: "oauth_unsupported_for_kind",
      })
      expect(d.beginOAuth).not.toHaveBeenCalled()
    })

    it("refuses when the adapter row is gone", async () => {
      const d = oauthDeps(deps(null))
      expect(await runPrincipalAdminIntent({ adapterId: "gone", op: "oauth-begin" }, d)).toEqual({
        ok: false,
        error: "adapter_not_found",
      })
    })

    it("lets an explicit redirect win over the derived one", async () => {
      const d = oauthDeps()
      await runPrincipalAdminIntent(
        {
          adapterId: "lark-1",
          op: "oauth-begin",
          redirectUri: "  https://proxy.example/cognia/oauth/lark/callback  ",
        },
        d
      )
      expect(d.beginOAuth).toHaveBeenCalledWith({
        adapterId: "lark-1",
        redirectUri: "https://proxy.example/cognia/oauth/lark/callback",
      })
    })

    it("refuses when neither an explicit nor a derivable redirect exists", async () => {
      const d = oauthDeps({ publicBase: (() => undefined) as never })
      expect(await runPrincipalAdminIntent({ adapterId: "lark-1", op: "oauth-begin" }, d)).toEqual({
        ok: false,
        error: "redirect_uri_unresolved",
      })
      expect(d.beginOAuth).not.toHaveBeenCalled()
    })

    it("has nothing to derive on a desktop host without a tunnel", async () => {
      // The desktop reaches the internet through cloudflared; with no tunnel
      // there is no public relay, and the settings dialog says so already.
      const d = oauthDeps({ isDesktop: (() => true) as never })
      expect(await runPrincipalAdminIntent({ adapterId: "lark-1", op: "oauth-begin" }, d)).toEqual({
        ok: false,
        error: "redirect_uri_unresolved",
      })
    })

    it("reads the public base off the environment by default", async () => {
      // The default deps are what the brain actually runs with; overriding
      // them in every test would leave that wiring unexercised.
      const previous = process.env.COGNIA_LARK_PUBLIC_BASE
      process.env.COGNIA_LARK_PUBLIC_BASE = "https://env.example"
      try {
        const beginOAuth = jest.fn(async () => AUTHORIZED)
        await runPrincipalAdminIntent(
          { adapterId: "lark-1", op: "oauth-begin" },
          { ...deps(), beginOAuth: beginOAuth as never }
        )
        expect(beginOAuth).toHaveBeenCalledWith({
          adapterId: "lark-1",
          redirectUri: "https://env.example/connectors/oauth/lark/callback",
        })
      } finally {
        if (previous === undefined) delete process.env.COGNIA_LARK_PUBLIC_BASE
        else process.env.COGNIA_LARK_PUBLIC_BASE = previous
      }
    })

    it("passes a begin failure through as a short stable reason", async () => {
      const d = oauthDeps({
        beginOAuth: jest.fn(async () => {
          throw new Error("app_id_missing")
        }) as never,
      })
      expect(await runPrincipalAdminIntent({ adapterId: "lark-1", op: "oauth-begin" }, d)).toEqual({
        ok: false,
        error: "app_id_missing",
      })
    })
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

  it("rebinds a principal to another account-local user", async () => {
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    const principal = await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_1",
      openId: "ou_1",
      cogniaAccountId: "acct_a",
      cogniaUserId: "acct_a",
    })

    const outcome = await runPrincipalAdminIntent(
      { adapterId: "lark-1", op: "rebind", principalId: principal.id, cogniaUserId: "user_7" },
      deps()
    )

    expect(outcome).toEqual({
      ok: true,
      result: { principalId: principal.id, cogniaUserId: "user_7", version: 2 },
    })
  })

  it("requires both a principal and a target user to rebind", async () => {
    expect(await runPrincipalAdminIntent({ adapterId: "lark-1", op: "rebind" }, deps())).toEqual({
      ok: false,
      error: "principal_required",
    })
    expect(
      await runPrincipalAdminIntent(
        { adapterId: "lark-1", op: "rebind", principalId: "fp_1" },
        deps()
      )
    ).toEqual({ ok: false, error: "user_required" })
  })
})
