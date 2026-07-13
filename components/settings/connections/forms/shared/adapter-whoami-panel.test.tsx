/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { AdapterWhoamiPanel } from "./adapter-whoami-panel"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

jest.mock("@/lib/connectors/whoami/telegram-whoami", () => ({
  probeTelegramIdentity: jest.fn(),
  TelegramWhoamiError: class extends Error {},
}))
jest.mock("@/lib/connectors/whoami/discord-whoami", () => ({
  probeDiscordIdentity: jest.fn(),
  DiscordWhoamiError: class extends Error {},
}))
jest.mock("@/lib/connectors/whoami/slack-whoami", () => ({
  probeSlackIdentity: jest.fn(),
  SlackWhoamiError: class extends Error {},
}))
jest.mock("@/lib/connectors/whoami/matrix-whoami", () => ({
  probeMatrixIdentity: jest.fn(),
  MatrixWhoamiError: class extends Error {},
}))
jest.mock("@/lib/connectors/whoami/qq-official-whoami", () => ({
  probeQQOfficialIdentity: jest.fn(),
  QQOfficialWhoamiError: class extends Error {},
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
}))

import { probeTelegramIdentity } from "@/lib/connectors/whoami/telegram-whoami"
import { probeDiscordIdentity } from "@/lib/connectors/whoami/discord-whoami"
import { probeSlackIdentity } from "@/lib/connectors/whoami/slack-whoami"
import { probeMatrixIdentity } from "@/lib/connectors/whoami/matrix-whoami"
import { probeQQOfficialIdentity } from "@/lib/connectors/whoami/qq-official-whoami"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  ;(probeTelegramIdentity as jest.Mock).mockReset()
  ;(probeDiscordIdentity as jest.Mock).mockReset()
  ;(probeSlackIdentity as jest.Mock).mockReset()
  ;(probeMatrixIdentity as jest.Mock).mockReset()
  ;(probeQQOfficialIdentity as jest.Mock).mockReset()
})

function seed(
  id: string,
  type: AdapterInstanceRow["type"],
  overrides: Partial<AdapterInstanceRow> = {}
) {
  return getDb().adapterInstances.put({
    id,
    type,
    displayName: "x",
    enabled: true,
    transportMode: type === "onebot" ? "reverse-ws" : "webhook",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
    trigger: {
      rules: [{ kind: "private-default" }],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    },
    defaultMode: "auto",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  })
}

describe("AdapterWhoamiPanel", () => {
  it("renders the unknown empty state when no snapshot exists", async () => {
    await seed("tg-1", "telegram")
    render(<AdapterWhoamiPanel adapterId="tg-1" platform="telegram" />)
    await waitFor(() => {
      expect(screen.getByTestId("adapter-whoami-empty")).toBeInTheDocument()
    })
  })

  it("renders the cached whoami snapshot", async () => {
    await seed("dc-1", "discord", {
      lastWhoamiAt: 1,
      lastWhoamiResult: {
        botName: "Cognia",
        appId: "cogniabot",
        openId: "11111",
        botAvatar: "https://example.com/a.png",
      },
    })
    render(<AdapterWhoamiPanel adapterId="dc-1" platform="discord" />)
    await waitFor(() => {
      expect(screen.getByText("Cognia")).toBeInTheDocument()
      expect(screen.getByText("cogniabot")).toBeInTheDocument()
      expect(screen.getByText("11111")).toBeInTheDocument()
    })
  })

  it("dispatches to probeTelegramIdentity for telegram platform", async () => {
    await seed("tg-2", "telegram")
    ;(probeTelegramIdentity as jest.Mock).mockResolvedValue({
      botName: "@x",
      appId: "x",
      openId: "1",
    })
    render(<AdapterWhoamiPanel adapterId="tg-2" platform="telegram" />)
    await waitFor(() => screen.getByTestId("adapter-whoami-reprobe"))
    fireEvent.click(screen.getByTestId("adapter-whoami-reprobe"))
    await waitFor(() => {
      expect(probeTelegramIdentity).toHaveBeenCalledWith("tg-2")
    })
  })

  it("dispatches to probeDiscordIdentity for discord platform", async () => {
    await seed("dc-2", "discord")
    ;(probeDiscordIdentity as jest.Mock).mockResolvedValue({
      botName: "x",
      appId: "x",
      openId: "1",
    })
    render(<AdapterWhoamiPanel adapterId="dc-2" platform="discord" />)
    await waitFor(() => screen.getByTestId("adapter-whoami-reprobe"))
    fireEvent.click(screen.getByTestId("adapter-whoami-reprobe"))
    await waitFor(() => {
      expect(probeDiscordIdentity).toHaveBeenCalledWith("dc-2")
    })
  })

  it("dispatches to probeSlackIdentity for slack platform", async () => {
    await seed("sl-2", "slack")
    ;(probeSlackIdentity as jest.Mock).mockResolvedValue({
      botName: "x",
      appId: "x",
      openId: "1",
    })
    render(<AdapterWhoamiPanel adapterId="sl-2" platform="slack" />)
    await waitFor(() => screen.getByTestId("adapter-whoami-reprobe"))
    fireEvent.click(screen.getByTestId("adapter-whoami-reprobe"))
    await waitFor(() => {
      expect(probeSlackIdentity).toHaveBeenCalledWith("sl-2")
    })
  })

  it("dispatches to probeMatrixIdentity for matrix platform", async () => {
    await seed("mx-2", "matrix")
    ;(probeMatrixIdentity as jest.Mock).mockResolvedValue({
      botName: "bot",
      appId: "https://matrix.org",
      openId: "@bot:matrix.org",
    })
    render(<AdapterWhoamiPanel adapterId="mx-2" platform="matrix" />)
    await waitFor(() => screen.getByTestId("adapter-whoami-reprobe"))
    fireEvent.click(screen.getByTestId("adapter-whoami-reprobe"))
    await waitFor(() => {
      expect(probeMatrixIdentity).toHaveBeenCalledWith("mx-2")
    })
  })

  it("dispatches to probeQQOfficialIdentity for qq-official platform", async () => {
    await seed("qq-2", "qq-official")
    ;(probeQQOfficialIdentity as jest.Mock).mockResolvedValue({
      botName: "CogniaQQ",
      appId: "app-1",
      openId: "bot-open-id",
    })
    render(<AdapterWhoamiPanel adapterId="qq-2" platform="qq-official" />)
    await waitFor(() => screen.getByTestId("adapter-whoami-reprobe"))
    fireEvent.click(screen.getByTestId("adapter-whoami-reprobe"))
    await waitFor(() => {
      expect(probeQQOfficialIdentity).toHaveBeenCalledWith("qq-2")
    })
  })

  it("hides the probe button for OneBot and surfaces the selfBotUin fallback", async () => {
    await seed("ob-1", "onebot", { settings: { selfBotUin: "10001234" } })
    render(<AdapterWhoamiPanel adapterId="ob-1" platform="onebot" />)
    await waitFor(() => {
      expect(screen.queryByTestId("adapter-whoami-reprobe")).not.toBeInTheDocument()
      expect(screen.getByTestId("adapter-whoami-onebot-fallback")).toBeInTheDocument()
      expect(screen.getByText("10001234")).toBeInTheDocument()
    })
  })

  it("renders the connected OneBot identity snapshot without a mismatch warning when the UIN matches", async () => {
    await seed("ob-ident", "onebot", {
      settings: { selfBotUin: "10001234" },
      lastWhoamiAt: 1,
      lastWhoamiResult: { botName: "MyBot", appId: "10001234", openId: "10001234" },
    })
    render(<AdapterWhoamiPanel adapterId="ob-ident" platform="onebot" />)
    await waitFor(() => {
      expect(screen.getByText("MyBot")).toBeInTheDocument()
    })
    expect(screen.queryByTestId("adapter-whoami-onebot-mismatch")).not.toBeInTheDocument()
  })

  it("warns when the connected OneBot UIN differs from the configured selfBotUin", async () => {
    await seed("ob-mismatch", "onebot", {
      settings: { selfBotUin: "999" },
      lastWhoamiAt: 1,
      lastWhoamiResult: { botName: "MyBot", appId: "10001234", openId: "10001234" },
    })
    render(<AdapterWhoamiPanel adapterId="ob-mismatch" platform="onebot" />)
    await waitFor(() => {
      expect(screen.getByTestId("adapter-whoami-onebot-mismatch")).toBeInTheDocument()
    })
  })

  it.each([
    ["onebot"],
    ["dingtalk"],
    ["wechat-oa"],
    ["wecom"],
    ["wechat-personal"],
  ] as Array<[AdapterInstanceRow["type"]]>)(
    "hides the probe button and shows a no-probe reason for %s rows without a snapshot",
    async (platform) => {
      await seed(`${platform}-no-probe`, platform)
      render(<AdapterWhoamiPanel adapterId={`${platform}-no-probe`} platform={platform} />)

      await waitFor(() => {
        expect(screen.queryByTestId("adapter-whoami-reprobe")).not.toBeInTheDocument()
        expect(screen.getByTestId("adapter-whoami-no-probe")).toBeInTheDocument()
      })
    }
  )

  it("surfaces probe errors in a dedicated error panel", async () => {
    await seed("sl-3", "slack")
    ;(probeSlackIdentity as jest.Mock).mockRejectedValue(new Error("boom"))
    render(<AdapterWhoamiPanel adapterId="sl-3" platform="slack" />)
    await waitFor(() => screen.getByTestId("adapter-whoami-reprobe"))
    fireEvent.click(screen.getByTestId("adapter-whoami-reprobe"))
    await waitFor(() => {
      expect(screen.getByTestId("adapter-whoami-error")).toBeInTheDocument()
      expect(screen.getByText(/boom/)).toBeInTheDocument()
    })
  })
})
