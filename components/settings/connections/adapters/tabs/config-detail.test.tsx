/**
 * @jest-environment jsdom
 *
 * Unit tests for ConfigDetail — per-adapter credential display, platform badges,
 * and the Edit credentials button that opens the matching platform dialog.
 * Covers: all five platform branches (telegram/discord/slack/lark/onebot),
 * row metadata rendering, dialog open/close cycle, and publicUrl display.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

// ---------------------------------------------------------------------------
// Sub-component mocks — prevent rendering entire form dialogs + whoami panels
// ---------------------------------------------------------------------------

jest.mock("@/components/settings/connections/forms/lark-config", () => ({
  LarkConfigDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (v: boolean) => void
  }) =>
    open ? (
      <div data-testid="lark-config-dialog">
        <button onClick={() => onOpenChange(false)}>Close</button>
      </div>
    ) : null,
}))

jest.mock("@/components/settings/connections/forms/telegram-config", () => ({
  TelegramConfigDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (v: boolean) => void
  }) =>
    open ? (
      <div data-testid="telegram-config-dialog">
        <button onClick={() => onOpenChange(false)}>Close</button>
      </div>
    ) : null,
}))

jest.mock("@/components/settings/connections/forms/discord-config", () => ({
  DiscordConfigDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (v: boolean) => void
  }) =>
    open ? (
      <div data-testid="discord-config-dialog">
        <button onClick={() => onOpenChange(false)}>Close</button>
      </div>
    ) : null,
}))

jest.mock("@/components/settings/connections/forms/slack-config", () => ({
  SlackConfigDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (v: boolean) => void
  }) =>
    open ? (
      <div data-testid="slack-config-dialog">
        <button onClick={() => onOpenChange(false)}>Close</button>
      </div>
    ) : null,
}))

jest.mock("@/components/settings/connections/forms/onebot-config", () => ({
  OneBotConfigDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (v: boolean) => void
  }) =>
    open ? (
      <div data-testid="onebot-config-dialog">
        <button onClick={() => onOpenChange(false)}>Close</button>
      </div>
    ) : null,
}))

jest.mock("@/components/settings/connections/forms/lark/lark-whoami-panel", () => ({
  LarkWhoamiPanel: ({ adapterId }: { adapterId: string }) => (
    <div data-testid="lark-whoami-panel" data-adapter-id={adapterId} />
  ),
}))

jest.mock("@/components/settings/connections/forms/shared/adapter-whoami-panel", () => ({
  AdapterWhoamiPanel: ({ adapterId, platform }: { adapterId: string; platform: string }) => (
    <div data-testid="adapter-whoami-panel" data-adapter-id={adapterId} data-platform={platform} />
  ),
}))

jest.mock("@/components/settings/connections/forms/lark/lark-at-strategy", () => ({
  LarkAtStrategy: ({ adapterId }: { adapterId: string }) => (
    <div data-testid="lark-at-strategy" data-adapter-id={adapterId} />
  ),
}))

jest.mock("@/components/settings/connections/forms/lark/lark-whitelist-editor", () => ({
  LarkWhitelistEditor: ({ adapterId }: { adapterId: string }) => (
    <div data-testid="lark-whitelist-editor" data-adapter-id={adapterId} />
  ),
}))

jest.mock("@/components/settings/connections/forms/shared/send-test-message-section", () => ({
  SendTestMessageSection: ({ adapterId, platform }: { adapterId: string; platform: string }) => (
    <div
      data-testid="send-test-message-section"
      data-adapter-id={adapterId}
      data-platform={platform}
    />
  ),
}))

// ---------------------------------------------------------------------------
// Subject import (after all mocks)
// ---------------------------------------------------------------------------

import { ConfigDetail } from "./config-detail"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

// ---------------------------------------------------------------------------
// i18n messages
// ---------------------------------------------------------------------------

const messages = {
  settings: {
    connections: {
      adapters: {
        detail: {
          editCredentials: "Edit credentials",
        },
      },
    },
  },
}

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  )
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRow(
  type: AdapterInstanceRow["type"],
  overrides: Partial<AdapterInstanceRow> = {}
): AdapterInstanceRow {
  return {
    id: `${type}-1`,
    type,
    displayName: `My ${type} Bot`,
    enabled: true,
    transportMode: type === "lark" ? "webhook" : "longpoll",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["token"] },
    trigger: defaultPrivateChatPolicy(),
    defaultMode: "auto",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests — base rendering
// ---------------------------------------------------------------------------

describe("ConfigDetail — base rendering", () => {
  it("renders the config-detail wrapper", () => {
    render(withIntl(<ConfigDetail row={makeRow("telegram")} />))
    expect(screen.getByTestId("config-detail")).toBeInTheDocument()
  })

  it("shows the adapter displayName as the card title", () => {
    render(withIntl(<ConfigDetail row={makeRow("telegram")} />))
    expect(screen.getByText("My telegram Bot")).toBeInTheDocument()
  })

  it("renders the Edit credentials button", () => {
    render(withIntl(<ConfigDetail row={makeRow("telegram")} />))
    expect(screen.getByTestId("config-detail-edit")).toBeInTheDocument()
    expect(screen.getByTestId("config-detail-edit")).toHaveTextContent(/edit credentials/i)
  })

  it("shows type, transport, and mode in the metadata section", () => {
    render(withIntl(<ConfigDetail row={makeRow("telegram")} />))
    expect(screen.getByText("telegram")).toBeInTheDocument()
    expect(screen.getByText("longpoll")).toBeInTheDocument()
    expect(screen.getByText("auto")).toBeInTheDocument()
  })

  it("renders publicUrl when the row has one", () => {
    const row = makeRow("telegram", { publicUrl: "https://example.com/webhook/tg" })
    render(withIntl(<ConfigDetail row={row} />))
    expect(screen.getByText("https://example.com/webhook/tg")).toBeInTheDocument()
  })

  it("does not render the publicUrl section when missing", () => {
    const row = makeRow("telegram", { publicUrl: undefined })
    render(withIntl(<ConfigDetail row={row} />))
    expect(screen.queryByText(/publicUrl/)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests — whoami panel branching
// ---------------------------------------------------------------------------

describe("ConfigDetail — whoami panel", () => {
  it("renders LarkWhoamiPanel for lark rows", () => {
    render(withIntl(<ConfigDetail row={makeRow("lark")} />))
    expect(screen.getByTestId("lark-whoami-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("adapter-whoami-panel")).not.toBeInTheDocument()
  })

  it("renders AdapterWhoamiPanel for non-lark rows", () => {
    render(withIntl(<ConfigDetail row={makeRow("telegram")} />))
    expect(screen.getByTestId("adapter-whoami-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("lark-whoami-panel")).not.toBeInTheDocument()
  })

  it("passes platform type to AdapterWhoamiPanel", () => {
    render(withIntl(<ConfigDetail row={makeRow("discord")} />))
    expect(screen.getByTestId("adapter-whoami-panel")).toHaveAttribute("data-platform", "discord")
  })

  it("passes adapterId to LarkWhoamiPanel", () => {
    const row = makeRow("lark")
    render(withIntl(<ConfigDetail row={row} />))
    expect(screen.getByTestId("lark-whoami-panel")).toHaveAttribute("data-adapter-id", "lark-1")
  })
})

// ---------------------------------------------------------------------------
// Tests — shared sub-sections
// ---------------------------------------------------------------------------

describe("ConfigDetail — shared sub-sections", () => {
  it("renders LarkAtStrategy for every platform", () => {
    render(withIntl(<ConfigDetail row={makeRow("telegram")} />))
    expect(screen.getByTestId("lark-at-strategy")).toBeInTheDocument()
  })

  it("renders LarkWhitelistEditor for every platform", () => {
    render(withIntl(<ConfigDetail row={makeRow("slack")} />))
    expect(screen.getByTestId("lark-whitelist-editor")).toBeInTheDocument()
  })

  it("renders SendTestMessageSection with correct platform", () => {
    render(withIntl(<ConfigDetail row={makeRow("onebot")} />))
    const section = screen.getByTestId("send-test-message-section")
    expect(section).toHaveAttribute("data-platform", "onebot")
    expect(section).toHaveAttribute("data-adapter-id", "onebot-1")
  })
})

// ---------------------------------------------------------------------------
// Tests — dialog open/close per platform
// ---------------------------------------------------------------------------

describe("ConfigDetail — Telegram dialog", () => {
  it("opens TelegramConfigDialog when Edit credentials is clicked on a telegram row", async () => {
    render(withIntl(<ConfigDetail row={makeRow("telegram")} />))
    expect(screen.queryByTestId("telegram-config-dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("config-detail-edit"))
    await waitFor(() => {
      expect(screen.getByTestId("telegram-config-dialog")).toBeInTheDocument()
    })
  })

  it("closes TelegramConfigDialog when onOpenChange(false) is called", async () => {
    render(withIntl(<ConfigDetail row={makeRow("telegram")} />))
    fireEvent.click(screen.getByTestId("config-detail-edit"))
    await waitFor(() => screen.getByTestId("telegram-config-dialog"))
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    await waitFor(() => {
      expect(screen.queryByTestId("telegram-config-dialog")).not.toBeInTheDocument()
    })
  })

  it("does not open other platform dialogs for telegram row", async () => {
    render(withIntl(<ConfigDetail row={makeRow("telegram")} />))
    fireEvent.click(screen.getByTestId("config-detail-edit"))
    await waitFor(() => screen.getByTestId("telegram-config-dialog"))
    expect(screen.queryByTestId("discord-config-dialog")).not.toBeInTheDocument()
    expect(screen.queryByTestId("lark-config-dialog")).not.toBeInTheDocument()
    expect(screen.queryByTestId("slack-config-dialog")).not.toBeInTheDocument()
    expect(screen.queryByTestId("onebot-config-dialog")).not.toBeInTheDocument()
  })
})

describe("ConfigDetail — Discord dialog", () => {
  it("opens DiscordConfigDialog for a discord row", async () => {
    render(withIntl(<ConfigDetail row={makeRow("discord")} />))
    fireEvent.click(screen.getByTestId("config-detail-edit"))
    await waitFor(() => {
      expect(screen.getByTestId("discord-config-dialog")).toBeInTheDocument()
    })
  })

  it("closes DiscordConfigDialog when onOpenChange(false) fires", async () => {
    render(withIntl(<ConfigDetail row={makeRow("discord")} />))
    fireEvent.click(screen.getByTestId("config-detail-edit"))
    await waitFor(() => screen.getByTestId("discord-config-dialog"))
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    await waitFor(() => {
      expect(screen.queryByTestId("discord-config-dialog")).not.toBeInTheDocument()
    })
  })
})

describe("ConfigDetail — Slack dialog", () => {
  it("opens SlackConfigDialog for a slack row", async () => {
    render(withIntl(<ConfigDetail row={makeRow("slack")} />))
    fireEvent.click(screen.getByTestId("config-detail-edit"))
    await waitFor(() => {
      expect(screen.getByTestId("slack-config-dialog")).toBeInTheDocument()
    })
  })

  it("closes SlackConfigDialog when onOpenChange(false) fires", async () => {
    render(withIntl(<ConfigDetail row={makeRow("slack")} />))
    fireEvent.click(screen.getByTestId("config-detail-edit"))
    await waitFor(() => screen.getByTestId("slack-config-dialog"))
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    await waitFor(() => {
      expect(screen.queryByTestId("slack-config-dialog")).not.toBeInTheDocument()
    })
  })
})

describe("ConfigDetail — Lark dialog", () => {
  it("opens LarkConfigDialog for a lark row", async () => {
    render(withIntl(<ConfigDetail row={makeRow("lark")} />))
    fireEvent.click(screen.getByTestId("config-detail-edit"))
    await waitFor(() => {
      expect(screen.getByTestId("lark-config-dialog")).toBeInTheDocument()
    })
  })

  it("closes LarkConfigDialog when onOpenChange(false) fires", async () => {
    render(withIntl(<ConfigDetail row={makeRow("lark")} />))
    fireEvent.click(screen.getByTestId("config-detail-edit"))
    await waitFor(() => screen.getByTestId("lark-config-dialog"))
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    await waitFor(() => {
      expect(screen.queryByTestId("lark-config-dialog")).not.toBeInTheDocument()
    })
  })
})

describe("ConfigDetail — OneBot dialog", () => {
  it("opens OneBotConfigDialog for a onebot row", async () => {
    render(withIntl(<ConfigDetail row={makeRow("onebot")} />))
    fireEvent.click(screen.getByTestId("config-detail-edit"))
    await waitFor(() => {
      expect(screen.getByTestId("onebot-config-dialog")).toBeInTheDocument()
    })
  })

  it("closes OneBotConfigDialog when onOpenChange(false) fires", async () => {
    render(withIntl(<ConfigDetail row={makeRow("onebot")} />))
    fireEvent.click(screen.getByTestId("config-detail-edit"))
    await waitFor(() => screen.getByTestId("onebot-config-dialog"))
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    await waitFor(() => {
      expect(screen.queryByTestId("onebot-config-dialog")).not.toBeInTheDocument()
    })
  })
})
