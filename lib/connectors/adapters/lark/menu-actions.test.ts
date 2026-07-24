import { handleMenuLink, handleMenuUnknownKey, type MenuActionDependencies } from "./menu-actions"
import { hashOpenId } from "@/lib/connectors/principal/resolve"

const ADAPTER_ID = "lark-menu-1"

function deps() {
  return {
    enqueue: jest.fn(async (_job: unknown) => ({ id: "job_1" })),
    audit: jest.fn(async (_entry: unknown) => undefined),
    now: () => 1_700_000_000_000,
  } as unknown as Partial<MenuActionDependencies> & { enqueue: jest.Mock; audit: jest.Mock }
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

describe("handleMenuLink", () => {
  const outcome = {
    kind: "link" as const,
    command: {
      triggerKey: "cognia.open_workbench",
      label: "Open workbench / 打开工作台",
      action: { type: "link" as const, value: "/" },
    },
    openId: "ou_user_2",
    eventId: "evt_2",
  }

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

  it("sends the explanatory notice when no web entry base is configured", async () => {
    const d = deps()
    await handleMenuLink(ADAPTER_ID, { settings: {} }, outcome, d)
    const job = d.enqueue.mock.calls[0][0] as { request: { segments: Array<{ text: string }> } }
    expect(job.request.segments[0].text).toContain("尚未配置 Cognia Web 入口")
    expect(job.request.segments[0].text).not.toContain("http")
  })
})
