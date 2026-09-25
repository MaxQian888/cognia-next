/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import type { AdapterInstanceRow } from "@/lib/db/connector-types"

// Each bespoke dialog renders only when open, so the dispatcher's job is
// visible from the ids alone: exactly one is open, and the right one.
// Telegram's mock also seeds state from `row` at mount, like the real forms,
// and counts its mounts — the remount-per-open contract is observable there.
let mockTelegramMounts = 0
jest.mock("@/components/settings/connections/forms/telegram-config", () => ({
  TelegramConfigDialog: function MockTelegram(p: { open: boolean; row: { id?: string } | null }) {
    const [seeded] = jest.requireActual<typeof import("react")>("react").useState(() => {
      mockTelegramMounts += 1
      return p.row?.id ?? "none"
    })
    return p.open ? (
      <div
        data-testid="telegram-config-dialog"
        data-row={String(Boolean(p.row))}
        data-seeded={seeded}
      />
    ) : null
  },
}))
jest.mock("@/components/settings/connections/forms/lark-config", () => ({
  LarkConfigDialog: (p: { open: boolean }) =>
    p.open ? <div data-testid="lark-config-dialog" /> : null,
}))
jest.mock("@/components/settings/connections/forms/discord-config", () => ({
  DiscordConfigDialog: (p: { open: boolean }) =>
    p.open ? <div data-testid="discord-config-dialog" /> : null,
}))
jest.mock("@/components/settings/connections/forms/slack-config", () => ({
  SlackConfigDialog: (p: { open: boolean }) =>
    p.open ? <div data-testid="slack-config-dialog" /> : null,
}))
jest.mock("@/components/settings/connections/forms/onebot-config", () => ({
  OneBotConfigDialog: (p: { open: boolean }) =>
    p.open ? <div data-testid="onebot-config-dialog" /> : null,
}))
jest.mock("@/components/settings/connections/forms/wecom-config", () => ({
  WeComConfigDialog: (p: { open: boolean }) =>
    p.open ? <div data-testid="wecom-config-dialog" /> : null,
}))
jest.mock("@/components/settings/connections/forms/wechat-personal-config", () => ({
  WeChatPersonalConfigDialog: (p: { open: boolean }) =>
    p.open ? <div data-testid="wechat-personal-config-dialog" /> : null,
}))
jest.mock("@/components/settings/connections/forms/matrix-config", () => ({
  MatrixConfigDialog: (p: { open: boolean }) =>
    p.open ? <div data-testid="matrix-config-dialog" /> : null,
}))
jest.mock("@/components/settings/connections/forms/qq-official-config", () => ({
  QQOfficialConfigDialog: (p: { open: boolean }) =>
    p.open ? <div data-testid="qq-official-config-dialog" /> : null,
}))
jest.mock("@/components/settings/connections/forms/wechat-oa-config", () => ({
  WechatOaConfigDialog: (p: { open: boolean }) =>
    p.open ? <div data-testid="wechat-oa-config-dialog" /> : null,
}))
jest.mock("@/components/settings/connections/forms/dingtalk-config", () => ({
  DingTalkConfigDialog: (p: { open: boolean }) =>
    p.open ? <div data-testid="dingtalk-config-dialog" /> : null,
}))
jest.mock("@/components/settings/connections/forms/plugin-connector-config", () => ({
  PluginConnectorConfigDialog: (p: { kind: string; onCreated?: unknown }) => (
    <div
      data-testid="plugin-connector-dialog"
      data-kind={p.kind}
      data-has-oncreated={String(Boolean(p.onCreated))}
    />
  ),
}))

import {
  AdapterConfigDialog,
  CONFIGURABLE_KINDS,
  isConfigurableKind,
} from "./adapter-config-dialog"

const row = { id: "a1", type: "telegram" } as AdapterInstanceRow

it("opens nothing when no kind is active", () => {
  render(<AdapterConfigDialog kind={null} row={null} onOpenChange={jest.fn()} />)
  expect(document.querySelectorAll("[data-testid$='-config-dialog']")).toHaveLength(0)
  expect(screen.queryByTestId("plugin-connector-dialog")).not.toBeInTheDocument()
})

// The invariant the two hand-written ladders existed to hold: exactly one form
// is open, so cross-platform state cannot leak between them.
it.each(CONFIGURABLE_KINDS)("opens only the %s dialog", (kind) => {
  render(<AdapterConfigDialog kind={kind} row={row} onOpenChange={jest.fn()} />)
  const open = Array.from(document.querySelectorAll("[data-testid$='-config-dialog']"))
  expect(open.map((el) => el.getAttribute("data-testid"))).toEqual([`${kind}-config-dialog`])
})

it("passes the row only to the dialog that is open", () => {
  render(<AdapterConfigDialog kind="telegram" row={row} onOpenChange={jest.fn()} />)
  expect(screen.getByTestId("telegram-config-dialog")).toHaveAttribute("data-row", "true")
})

// The detail panel's own copy of the ladder had no fallback, so a contributed
// adapter's Edit button opened nothing at all.
it("falls back to the schema-driven dialog for a contributed kind", () => {
  render(<AdapterConfigDialog kind={"acme" as never} row={null} onOpenChange={jest.fn()} />)
  expect(screen.getByTestId("plugin-connector-dialog")).toHaveAttribute("data-kind", "acme")
  expect(document.querySelectorAll("[data-testid$='-config-dialog']")).toHaveLength(0)
})

// Only the list creates, so only the list passes a handler. Forwarding an
// absent one as `undefined` would still count as "provided" to a dialog that
// spreads its props.
it("forwards onCreated only when the caller supplies one", () => {
  const { rerender } = render(
    <AdapterConfigDialog kind={"acme" as never} row={null} onOpenChange={jest.fn()} />
  )
  expect(screen.getByTestId("plugin-connector-dialog")).toHaveAttribute(
    "data-has-oncreated",
    "false"
  )
  rerender(
    <AdapterConfigDialog
      kind={"acme" as never}
      row={null}
      onOpenChange={jest.fn()}
      onCreated={jest.fn()}
    />
  )
  expect(screen.getByTestId("plugin-connector-dialog")).toHaveAttribute(
    "data-has-oncreated",
    "true"
  )
})

describe("isConfigurableKind", () => {
  it("accepts every kind with a bespoke form", () => {
    for (const kind of CONFIGURABLE_KINDS) expect(isConfigurableKind(kind)).toBe(true)
  })

  it("rejects a contributed kind, which is what routes it to the fallback", () => {
    expect(isConfigurableKind("acme" as never)).toBe(false)
  })
})

describe("each open seeds the form from the row it edits", () => {
  beforeEach(() => {
    mockTelegramMounts = 0
  })

  it("opens an existing adapter on its own values, not the mount-time blank", () => {
    // The dialogs stay mounted with `row: null`; a form that seeded then kept
    // the placeholder name and default settings, and Save wrote them back.
    const { rerender } = render(
      <AdapterConfigDialog kind={null} row={null} onOpenChange={jest.fn()} />
    )
    rerender(<AdapterConfigDialog kind="telegram" row={row} onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("telegram-config-dialog")).toHaveAttribute("data-seeded", "a1")
  })

  it("reseeds when the next open edits a different adapter", () => {
    const other = { id: "a2", type: "telegram" } as AdapterInstanceRow
    const { rerender } = render(
      <AdapterConfigDialog kind="telegram" row={row} onOpenChange={jest.fn()} />
    )
    rerender(<AdapterConfigDialog kind={null} row={null} onOpenChange={jest.fn()} />)
    rerender(<AdapterConfigDialog kind="telegram" row={other} onOpenChange={jest.fn()} />)
    expect(screen.getByTestId("telegram-config-dialog")).toHaveAttribute("data-seeded", "a2")
  })

  it("keeps the instance through the close, so the exit animation can play", () => {
    const { rerender } = render(
      <AdapterConfigDialog kind="telegram" row={row} onOpenChange={jest.fn()} />
    )
    const mountsWhileOpen = mockTelegramMounts
    rerender(<AdapterConfigDialog kind={null} row={null} onOpenChange={jest.fn()} />)
    expect(mockTelegramMounts).toBe(mountsWhileOpen)
  })
})
