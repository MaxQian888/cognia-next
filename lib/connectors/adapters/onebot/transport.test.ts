import { assertOneBotSuccess, oneBotMessageId } from "./transport"
import type { OneBotRpcResponse } from "./transport"

it("requires both success status and zero retcode", () => {
  expect(() =>
    assertOneBotSuccess({ status: "ok", retcode: 0 } as OneBotRpcResponse, "delete_msg")
  ).not.toThrow()
  for (const response of [
    { status: "async", retcode: 1 },
    { status: "ok", retcode: 1 },
    {},
    { status: "failed", retcode: 0 },
  ]) {
    expect(() => assertOneBotSuccess(response as OneBotRpcResponse, "send_msg")).toThrow(
      expect.objectContaining({ code: "delivery_unknown", retryable: false })
    )
  }
})

it("preserves an explicit rejection and its platform diagnostic", () => {
  expect(() =>
    assertOneBotSuccess(
      { status: "failed", retcode: 1400, wording: "permission denied" } as OneBotRpcResponse,
      "delete_msg"
    )
  ).toThrow(
    expect.objectContaining({
      code: "platform_4xx",
      message: expect.stringContaining("permission denied"),
      retryable: false,
    })
  )
})

it("accepts numeric and string message IDs but refuses missing delivery receipts", () => {
  for (const id of [0, 123, "message-1"])
    expect(
      oneBotMessageId(
        { status: "ok", retcode: 0, data: { message_id: id } } as OneBotRpcResponse,
        "send_msg"
      )
    ).toBe(String(id))
  for (const id of [null, undefined, "", {}, true])
    expect(() =>
      oneBotMessageId(
        { status: "ok", retcode: 0, data: { message_id: id } } as OneBotRpcResponse,
        "send_msg"
      )
    ).toThrow(expect.objectContaining({ code: "delivery_unknown" }))
})
