import type { NormalizedInboundEvent } from "@/types/connectors/event"

jest.mock("./runtime", () => ({ notify: jest.fn().mockResolvedValue("id") }))
jest.mock("@/lib/connectors/bus", () => {
  const subscribeInbound = jest.fn(() => () => {})
  return { getBus: jest.fn(() => ({ subscribeInbound })) }
})
jest.mock("@/stores/inbox/active-conversation-store", () => ({
  isViewingConversation: jest.fn(() => false),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: jest.fn(() => ({ settings: { notificationPreferences: undefined } })),
  },
}))

import { notify } from "./runtime"
import { getBus } from "@/lib/connectors/bus"
import { isViewingConversation } from "@/stores/inbox/active-conversation-store"
import { useSettingsStore } from "@/stores/settings"
import {
  installConnectorNotificationBridge,
  __uninstallConnectorNotificationBridge,
  buildConnectorNotification,
} from "./inbound-connector"

const mockNotify = notify as jest.Mock
const mockSubscribe = getBus().subscribeInbound as jest.Mock
const mockIsViewing = isViewingConversation as jest.Mock
const mockGetState = useSettingsStore.getState as jest.Mock
function setPrefs(prefs: { connectorFocusAware?: boolean } | undefined) {
  mockGetState.mockReturnValue({ settings: { notificationPreferences: prefs } })
}

function event(over: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "tg",
    selfId: "self",
    messageId: "m1",
    conversationRef: { platform: "telegram", adapterId: "tg" },
    conversationKey: "telegram:tg:1",
    sender: {
      id: "u1",
      platform: "telegram",
      adapterId: "tg",
      remoteUserId: "u1",
      displayName: "Alice",
    },
    channel: { id: "c1", name: "General", kind: "group" },
    segments: [],
    plainText: "hello there",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 1,
    raw: {},
    ...over,
  } as NormalizedInboundEvent
}

function fireWith(ev: NormalizedInboundEvent) {
  installConnectorNotificationBridge()
  const observer = mockSubscribe.mock.calls.at(-1)![0] as (e: NormalizedInboundEvent) => void
  observer(ev)
}

beforeEach(() => {
  jest.clearAllMocks()
  setPrefs(undefined)
  mockIsViewing.mockReturnValue(false)
  __uninstallConnectorNotificationBridge()
})

describe("buildConnectorNotification", () => {
  it("composes title from sender + channel and marks DMs directed", () => {
    const out = buildConnectorNotification(
      event({ channel: { id: "c", name: "DM", kind: "private" } })
    )
    expect(out.title).toBe("Alice · DM")
    expect(out.directed).toBe(true)
    expect(out.href).toBe("/inbox/c?key=telegram%3Atg%3A1")
  })

  it("marks self-mentions directed and truncates long previews", () => {
    const long = "x".repeat(200)
    const out = buildConnectorNotification(
      event({ plainText: long, mentions: { selfMentioned: true, users: [] } })
    )
    expect(out.directed).toBe(true)
    expect(out.body.endsWith("…")).toBe(true)
    expect(out.body.length).toBeLessThanOrEqual(140)
  })
})

describe("installConnectorNotificationBridge", () => {
  it("notifies on a create message", () => {
    fireWith(event())
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "connector",
        title: "Alice · General",
        dedupeKey: "telegram:tg:1",
        groupKey: "telegram:tg:1",
      })
    )
  })

  it("skips edit/delete/system events", () => {
    fireWith(event({ kind: "edit" }))
    fireWith(event({ kind: "system", systemKind: "read_indicator" }))
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it("skips the bot's own echoes (sender === self)", () => {
    fireWith(
      event({ sender: { id: "self", platform: "telegram", adapterId: "tg", remoteUserId: "self" } })
    )
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it("skips empty-text events", () => {
    fireWith(event({ plainText: "   " }))
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it("suppresses OS (center+toast only) when viewing the conversation and focus-aware is on", () => {
    setPrefs({ connectorFocusAware: true })
    mockIsViewing.mockReturnValue(true)
    fireWith(event())
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ channels: ["center", "toast"] })
    )
  })

  it("leaves channels to preferences when not viewing", () => {
    setPrefs({ connectorFocusAware: true })
    mockIsViewing.mockReturnValue(false)
    fireWith(event())
    expect(mockNotify.mock.calls[0][0].channels).toBeUndefined()
  })

  it("is idempotent — subscribes once", () => {
    installConnectorNotificationBridge()
    installConnectorNotificationBridge()
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
  })
})
