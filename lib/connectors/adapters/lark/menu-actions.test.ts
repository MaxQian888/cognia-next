import {
  handleMenuDisabledKey,
  handleMenuLink,
  handleMenuUnknownKey,
  type MenuActionDependencies,
} from "./menu-actions"
import { hashOpenId } from "@/lib/connectors/principal/resolve"

const ADAPTER_ID = "lark-menu-1"

function deps() {
  return {
    enqueue: jest.fn(async (_job: unknown) => ({ id: "job_1" })),
    audit: jest.fn(async (_entry: unknown) => undefined),
    resolvePrincipal: jest.fn(async () => ({ status: "legacy" as const })),
    buildConversationLink: jest.fn(async () => null),
    now: () => 1_700_000_000_000,
  } as unknown as Partial<MenuActionDependencies> & {
    enqueue: jest.Mock
    audit: jest.Mock
    resolvePrincipal: jest.Mock
    buildConversationLink: jest.Mock
  }
}

describe("handleMenuUnknownKey", () => {
  it("audits the hashed operator and replies with the fixed bilingual notice", async () => {
    const d = deps()
    await handleMenuUnknownKey(
      ADAPTER_ID,
      {
        kind: "unknown",
        openId: "ou_user_1",
        eventKey: "mystery",
        eventId: "evt_1",
        identityScope: { tenantKey: "tk_1", appId: "cli_1" },
      },
      d
    )

    expect(d.audit).toHaveBeenCalledTimes(1)
    const audit = d.audit.mock.calls[0][0] as Record<string, unknown>
    expect(audit).toMatchObject({
      adapterId: ADAPTER_ID,
      kind: "menu.unknown_key",
      reason: "unmapped_event_key",
    })
    const fields = audit.fields as Record<string, unknown>
    expect(fields.eventKey).toBe("mystery")
    expect(fields.tenantKey).toBe("tk_1")
    // The raw open_id never lands in the audit FIELDS — only as a hash.
    // (conversationKey is the p2p routing key and legitimately carries it,
    // same as every other lark:adapter:ou_… key in the system.)
    expect(fields.openIdHash).toBe(await hashOpenId("ou_user_1"))
    expect(JSON.stringify(fields)).not.toContain("ou_user_1")

    expect(d.enqueue).toHaveBeenCalledTimes(1)
    const job = d.enqueue.mock.calls[0][0] as {
      conversationKey: string
      request: {
        conversationRef: { channelId: string }
        segments: Array<{ type: string; text: string }>
        metadata: { idempotencyKey: string }
      }
    }
    expect(job.conversationKey).toBe(`lark:${ADAPTER_ID}:ou_user_1`)
    expect(job.request.conversationRef.channelId).toBe("ou_user_1")
    expect(job.request.segments[0].text).toContain("该菜单项尚未配置")
    expect(job.request.segments[0].text).toContain("isn't configured")
    expect(job.request.metadata.idempotencyKey).toBe(`menu-unknown:${ADAPTER_ID}:evt_1`)
  })
})

describe("handleMenuDisabledKey", () => {
  it("replies without recording an unmapped-key audit", async () => {
    const d = deps()
    await handleMenuDisabledKey(ADAPTER_ID, { openId: "ou_user_1", eventId: "evt_disabled" }, d)

    expect(d.audit).not.toHaveBeenCalled()
    expect(d.enqueue).toHaveBeenCalledTimes(1)
    const job = d.enqueue.mock.calls[0][0]
    expect(job.request.metadata.idempotencyKey).toBe(`menu-disabled:${ADAPTER_ID}:evt_disabled`)
    expect(job.request.segments[0].text).toMatch(/currently disabled/)
  })
})

describe("handleMenuLink", () => {
  const outcome = {
    kind: "link" as const,
    builtIn: true,
    eventKey: "cognia.open_workbench",
    command: {
      triggerKey: "cognia.open_workbench",
      label: "Open workbench / 打开工作台",
      action: { type: "link" as const, value: "/" },
    },
    openId: "ou_user_2",
    eventId: "evt_2",
  }

  it.each(["personal", "team", "both"])(
    "opens the stable workbench entry for %s mode with event deduplication",
    async (mode) => {
      const d = deps()
      const row = {
        settings: {
          webEntryBaseUrl: "https://cognia.example/deploy",
          larkWorkbenchMode: mode,
          larkWebSso: true,
        },
      }
      await handleMenuLink(ADAPTER_ID, row, outcome, d)
      await handleMenuLink(ADAPTER_ID, row, outcome, d)
      const first = d.enqueue.mock.calls[0][0]
      expect(first.request.segments[0].text).toBe(
        `Open workbench / 打开工作台\nhttps://cognia.example/deploy/lark/workbench?adapter_id=${ADAPTER_ID}`
      )
      expect(first.request.metadata.idempotencyKey).toBe(`menu-link:${ADAPTER_ID}:evt_2`)
      expect(d.enqueue.mock.calls[1][0].request.metadata.idempotencyKey).toBe(
        first.request.metadata.idempotencyKey
      )
      expect(d.resolvePrincipal).not.toHaveBeenCalled()
      expect(d.buildConversationLink).not.toHaveBeenCalled()
    }
  )

  it.each([
    { larkWorkbenchMode: "disabled", larkWebSso: true },
    { larkWorkbenchMode: "both", larkWebSso: false },
  ])(
    "preserves the authorized conversation link when workbench or SSO is disabled",
    async (settings) => {
      const d = deps()
      d.resolvePrincipal.mockResolvedValue({
        status: "resolved",
        principal: { id: "fp_1", tenantKey: "tk_1", appId: "cli_1" },
        accountId: "acct_1",
      })
      d.buildConversationLink.mockResolvedValue("https://cognia.example/lark/entry?entry=legacy")
      await handleMenuLink(
        ADAPTER_ID,
        { settings: { webEntryBaseUrl: "https://cognia.example", ...settings } },
        outcome,
        d
      )
      expect(d.enqueue.mock.calls[0][0].request.segments[0].text).toContain("entry=legacy")
      expect(d.buildConversationLink).toHaveBeenCalledTimes(1)
    }
  )

  it("leaves other link actions unchanged while workbench is enabled", async () => {
    const d = deps()
    await handleMenuLink(
      ADAPTER_ID,
      {
        settings: {
          webEntryBaseUrl: "https://cognia.example",
          larkWorkbenchMode: "both",
          larkWebSso: true,
        },
      },
      {
        ...outcome,
        eventKey: "custom.memory",
        command: {
          ...outcome.command,
          triggerKey: "custom.memory",
          action: { type: "link", value: "/memory" },
        },
      },
      d
    )
    expect(d.enqueue.mock.calls[0][0].request.segments[0].text).toContain(
      "https://cognia.example/memory"
    )
    expect(d.resolvePrincipal).toHaveBeenCalledTimes(1)
  })

  it("does not publish an invalid workbench base", async () => {
    const d = deps()
    await handleMenuLink(
      ADAPTER_ID,
      {
        settings: {
          webEntryBaseUrl: "https://operator:secret@cognia.example",
          larkWorkbenchMode: "both",
          larkWebSso: true,
        },
      },
      outcome,
      d
    )
    expect(d.enqueue.mock.calls[0][0].request.segments[0].text).toContain(
      "尚未配置 Cognia Web 入口"
    )
    expect(d.enqueue.mock.calls[0][0].request.segments[0].text).not.toContain("secret")
  })

  it("replies with the resolved web-entry URL when a base is configured", async () => {
    const d = deps()
    await handleMenuLink(
      ADAPTER_ID,
      { settings: { webEntryBaseUrl: "https://cognia.example" } },
      outcome,
      d
    )
    const job = d.enqueue.mock.calls[0][0] as {
      request: { segments: Array<{ text: string }>; metadata: { idempotencyKey: string } }
    }
    expect(job.request.segments[0].text).toContain("https://cognia.example")
    // Root path collapses to the bare base — no trailing slash artifacts.
    expect(job.request.segments[0].text).not.toContain("example//")
    expect(job.request.metadata.idempotencyKey).toBe(`menu-link:${ADAPTER_ID}:evt_2`)
  })

  it("appends non-root link paths to the base", async () => {
    const d = deps()
    await handleMenuLink(
      ADAPTER_ID,
      { settings: { webEntryBaseUrl: "https://cognia.example" } },
      {
        ...outcome,
        command: { ...outcome.command, action: { type: "link", value: "/memory" } },
      },
      d
    )
    const job = d.enqueue.mock.calls[0][0] as { request: { segments: Array<{ text: string }> } }
    expect(job.request.segments[0].text).toContain("https://cognia.example/memory")
  })

  it("prefers a personal authorized link when the principal resolves", async () => {
    const d = deps()
    d.resolvePrincipal.mockResolvedValueOnce({
      status: "resolved",
      principal: { id: "fp_1", tenantKey: "tk_a", appId: "cli_1" },
      tenant: { id: "ft_1" },
      accountId: "acct_a",
    })
    d.buildConversationLink.mockResolvedValueOnce("https://cognia.example/lark/entry?entry=tok.xyz")
    await handleMenuLink(
      ADAPTER_ID,
      { settings: { webEntryBaseUrl: "https://cognia.example", larkWebSso: true } },
      outcome,
      d
    )
    const minted = d.buildConversationLink.mock.calls[0][0] as Record<string, unknown>
    expect(minted).toMatchObject({
      adapterId: ADAPTER_ID,
      principalId: "fp_1",
      accountId: "acct_a",
      openId: "ou_user_2",
      entryType: "bot_menu",
      conversationKey: `lark:${ADAPTER_ID}:ou_user_2`,
    })
    const job = d.enqueue.mock.calls[0][0] as { request: { segments: Array<{ text: string }> } }
    expect(job.request.segments[0].text).toContain("entry=tok.xyz")
  })

  it("sends the explanatory notice when no web entry base is configured", async () => {
    const d = deps()
    await handleMenuLink(ADAPTER_ID, { settings: {} }, outcome, d)
    const job = d.enqueue.mock.calls[0][0] as { request: { segments: Array<{ text: string }> } }
    expect(job.request.segments[0].text).toContain("尚未配置 Cognia Web 入口")
    expect(job.request.segments[0].text).not.toContain("http")
  })

  it("degrades to the plain URL when principal resolution throws, and labels by path", async () => {
    const d = deps()
    d.resolvePrincipal.mockRejectedValueOnce(new Error("registry down"))
    await handleMenuLink(
      ADAPTER_ID,
      { settings: { webEntryBaseUrl: "https://cognia.example" } },
      { ...outcome, command: { ...outcome.command, label: undefined } },
      d
    )
    const job = d.enqueue.mock.calls[0][0] as { request: { segments: Array<{ text: string }> } }
    // Label falls back to the path; URL falls back to the bare base.
    expect(job.request.segments[0].text).toBe("/\nhttps://cognia.example")
  })
})

describe("handleMenuUnknownKey without identity scope", () => {
  it("omits tenantKey from the audit fields", async () => {
    const d = deps()
    await handleMenuUnknownKey(
      ADAPTER_ID,
      { kind: "unknown", openId: "ou_user_9", eventKey: "k9", eventId: "evt_9" },
      d
    )
    const fields = (d.audit.mock.calls[0][0] as { fields: Record<string, unknown> }).fields
    expect("tenantKey" in fields).toBe(false)
  })
})
