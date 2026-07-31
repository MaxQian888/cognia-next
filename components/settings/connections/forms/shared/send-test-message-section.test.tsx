/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const mockSendOutbound = jest.fn()

jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({ sendOutbound: mockSendOutbound }),
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

import { SendTestMessageSection } from "./send-test-message-section"

beforeEach(() => {
  mockSendOutbound.mockReset()
})

describe("SendTestMessageSection", () => {
  it("renders the chat-id input + send button", () => {
    render(<SendTestMessageSection adapterId="tg-1" platform="telegram" />)
    expect(screen.getByTestId("send-test-chat-id")).toBeInTheDocument()
    expect(screen.getByTestId("send-test-button")).toBeInTheDocument()
  })

  it("disables the send button until a chat id is entered", () => {
    render(<SendTestMessageSection adapterId="tg-1" platform="telegram" />)
    expect(screen.getByTestId("send-test-button")).toBeDisabled()
    fireEvent.change(screen.getByTestId("send-test-chat-id"), { target: { value: "12345" } })
    expect(screen.getByTestId("send-test-button")).not.toBeDisabled()
  })

  it("calls bus.sendOutbound with the right conversationRef and a text segment", async () => {
    mockSendOutbound.mockResolvedValue({ ok: true, platformMessageId: "msg-42" })
    render(<SendTestMessageSection adapterId="tg-1" platform="telegram" />)
    fireEvent.change(screen.getByTestId("send-test-chat-id"), { target: { value: "98765" } })
    fireEvent.click(screen.getByTestId("send-test-button"))
    await waitFor(() => {
      expect(mockSendOutbound).toHaveBeenCalledWith(
        "tg-1",
        expect.objectContaining({
          conversationRef: expect.objectContaining({
            platform: "telegram",
            adapterId: "tg-1",
            chatId: "98765",
            channelId: "98765",
          }),
          segments: [expect.objectContaining({ type: "text" })],
          metadata: expect.objectContaining({ idempotencyKey: expect.any(String) }),
        })
      )
    })
  })

  it("shows the success result when sendOutbound resolves ok", async () => {
    mockSendOutbound.mockResolvedValue({ ok: true, platformMessageId: "abc" })
    render(<SendTestMessageSection adapterId="dc-1" platform="discord" />)
    fireEvent.change(screen.getByTestId("send-test-chat-id"), { target: { value: "1234567890" } })
    fireEvent.click(screen.getByTestId("send-test-button"))
    await waitFor(() => {
      const result = screen.getByTestId("send-test-result")
      expect(result.textContent).toMatch(/abc/)
    })
  })

  it("shows the error result when sendOutbound returns ok: false", async () => {
    mockSendOutbound.mockResolvedValue({
      ok: false,
      error: { code: "platform_4xx", message: "Chat not found", retryable: false },
    })
    render(<SendTestMessageSection adapterId="sl-1" platform="slack" />)
    fireEvent.change(screen.getByTestId("send-test-chat-id"), { target: { value: "C-XXX" } })
    fireEvent.click(screen.getByTestId("send-test-button"))
    await waitFor(() => {
      const result = screen.getByTestId("send-test-result")
      expect(result.textContent).toMatch(/platform_4xx/)
      expect(result.textContent).toMatch(/Chat not found/)
    })
  })

  it("translates a thrown exception into an error result", async () => {
    mockSendOutbound.mockRejectedValue(new Error("bus offline"))
    render(<SendTestMessageSection adapterId="lk-1" platform="lark" />)
    fireEvent.change(screen.getByTestId("send-test-chat-id"), {
      target: { value: "oc_test" },
    })
    fireEvent.click(screen.getByTestId("send-test-button"))
    await waitFor(() => {
      const result = screen.getByTestId("send-test-result")
      expect(result.textContent).toMatch(/bus offline/)
    })
  })

  it("does not fire when only whitespace is in the chat id", () => {
    render(<SendTestMessageSection adapterId="tg-1" platform="telegram" />)
    fireEvent.change(screen.getByTestId("send-test-chat-id"), { target: { value: "   " } })
    expect(screen.getByTestId("send-test-button")).toBeDisabled()
  })

  it.each([
    [
      "onebot",
      "ob-1",
      "10001",
      {
        userId: "10001",
        chatKey: "p:10001",
      },
    ],
    [
      "wechat-oa",
      "wxoa-1",
      "openid-123",
      {
        openId: "openid-123",
      },
    ],
    [
      "qq-official",
      "qq-1",
      "group:group-openid-123",
      {
        scene: "group",
        sceneId: "group-openid-123",
      },
    ],
    [
      "dingtalk",
      "dt-1",
      "single:staff-123",
      {
        conversationType: "1",
        userId: "staff-123",
      },
    ],
    [
      "dingtalk",
      "dt-2",
      "group:cid-123",
      {
        conversationType: "2",
        openConversationId: "cid-123",
      },
    ],
    [
      "wecom",
      "wc-1",
      "group:chatid-123",
      {
        chatId: "chatid-123",
        chatType: "group",
      },
    ],
    // Matrix room ids contain a colon but their prefix is NOT a kind —
    // "!abcd" must not be stripped off as one (regression guard).
    [
      "matrix",
      "mx-1",
      "!abcd:matrix.org",
      {
        roomId: "!abcd:matrix.org",
      },
    ],
    // Unknown colon prefixes on other platforms pass through raw too.
    [
      "telegram",
      "tg-9",
      "weird:12345",
      {
        chatId: "weird:12345",
        channelId: "weird:12345",
      },
    ],
  ] as const)(
    "builds a %s conversationRef that its adapter runtime can address",
    async (platform, adapterId, target, expectedRef) => {
      mockSendOutbound.mockResolvedValue({ ok: true, platformMessageId: "msg-42" })
      render(<SendTestMessageSection adapterId={adapterId} platform={platform} />)

      fireEvent.change(screen.getByTestId("send-test-chat-id"), { target: { value: target } })
      fireEvent.click(screen.getByTestId("send-test-button"))

      await waitFor(() => {
        expect(mockSendOutbound).toHaveBeenCalledWith(
          adapterId,
          expect.objectContaining({
            conversationRef: expect.objectContaining({
              platform,
              adapterId,
              ...expectedRef,
            }),
          })
        )
      })
    }
  )

  it("disables proactive test sends for reply-only personal WeChat", () => {
    render(<SendTestMessageSection adapterId="wxp-1" platform="wechat-personal" />)
    fireEvent.change(screen.getByTestId("send-test-chat-id"), {
      target: { value: "user-123" },
    })

    expect(screen.getByTestId("send-test-button")).toBeDisabled()
    expect(mockSendOutbound).not.toHaveBeenCalled()
  })
})
