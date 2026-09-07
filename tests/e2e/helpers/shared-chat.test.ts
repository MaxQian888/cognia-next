import type { Page, Route } from "@playwright/test"
import { installCollabScenario, BASE_URL } from "./shared-chat"

test("mock collaboration retains cursor history and separates messages from AI requests", async () => {
  let handler!: (route: Route) => Promise<unknown>
  const page = {
    addInitScript: jest.fn(),
    routeWebSocket: jest.fn(),
    route: jest.fn((_url, callback) => {
      handler = callback
    }),
  } as unknown as Page
  const scenario = await installCollabScenario(page)
  async function request(path: string, method = "GET", body?: unknown) {
    const fulfill = jest.fn().mockResolvedValue(undefined)
    await handler({
      request: () => ({
        url: () => `${BASE_URL}${path}`,
        method: () => method,
        postData: () => (body ? JSON.stringify(body) : null),
        postDataJSON: () => body,
      }),
      fulfill,
    } as unknown as Route)
    return JSON.parse(fulfill.mock.calls[0][0].body)
  }
  await request("/chat-sessions", "POST", { title: "Shared" })
  expect(await request("/chat-sessions")).toHaveLength(1)
  expect((await request("/health")).features).toContain("shared-chat-execution-v2")
  const event = await request("/events", "POST", {
    kind: "message.created",
    operationId: "once",
    payload: { messageId: "message", parts: [{ type: "text", text: "hello" }] },
  })
  expect(await request("/events?afterSequence=0")).toEqual([event])
  expect(await request("/events?afterSequence=1")).toEqual([])
  const before = scenario.queue.length
  await request("/queue", "POST", { payload: { messageId: "message" }, operationId: "request" })
  expect(scenario.queue).toHaveLength(before + 1)
  expect(scenario.events).toHaveLength(1)
})
