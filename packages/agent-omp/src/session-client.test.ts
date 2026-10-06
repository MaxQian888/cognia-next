import { OmpSessionClient, type OmpSessionClientPorts } from "./session-client"

function setup() {
  const request = jest.fn(async () => ({ marker: true }))
  const ticket = {
    id: "ticket",
    ack: Promise.resolve(undefined),
    result: Promise.resolve({
      type: "prompt_result" as const,
      agentInvoked: true,
      sessionSettled: true,
      status: "completed" as const,
    }),
  }
  const prompt = jest.fn(() => ticket)
  const client = new OmpSessionClient({
    request: request as OmpSessionClientPorts["request"],
    prompt,
  })
  return { client, request, prompt, ticket }
}

test("routes typed queries and advanced actions through the injected request dispatcher", async () => {
  const h = setup()
  expect(await h.client.getState()).toEqual({ marker: true })
  await h.client.setEventFilter({ events: ["agent_start"], messageUpdates: "delta" })
  await h.client.steerSubagent({ subagentId: "child", message: "finish" })
  await h.client.getMessagesPage({ limit: 32, cursor: "cursor" })
  expect(h.request.mock.calls).toEqual([
    ["get_state"],
    ["set_event_filter", { events: ["agent_start"], messageUpdates: "delta" }],
    ["steer_subagent", { subagentId: "child", message: "finish" }],
    ["get_messages_page", { limit: 32, cursor: "cursor" }],
  ])
})

test("routes all session transitions through the host-owned dispatcher", async () => {
  const h = setup()
  await h.client.newSession()
  await h.client.openSession({ sessionDir: "/workspace/thread" })
  await h.client.switchSession({ sessionPath: "/workspace/thread/session.jsonl" })
  await h.client.fork({ entryId: "entry" })
  expect(h.request.mock.calls).toEqual([
    ["new_session", {}],
    ["open_session", { sessionDir: "/workspace/thread" }],
    ["switch_session", { sessionPath: "/workspace/thread/session.jsonl" }],
    ["fork", { entryId: "entry" }],
  ])
})

test("prompt methods preserve both ticket promises and use the prompt dispatcher", () => {
  const h = setup()
  expect(h.client.prompt({ message: "start" })).toBe(h.ticket)
  expect(h.client.abortAndPrompt({ message: "replace" })).toBe(h.ticket)
  expect(h.prompt.mock.calls).toEqual([
    [{ message: "start" }, "prompt"],
    [{ message: "replace" }, "abort_and_prompt"],
  ])
  expect(h.request).not.toHaveBeenCalled()
})

test("forwards host gate rejection without catching or replaying", async () => {
  const h = setup()
  const failure = new Error("Host denied execution")
  h.request.mockRejectedValueOnce(failure)
  await expect(h.client.bash({ command: "echo denied" })).rejects.toBe(failure)
  expect(h.request).toHaveBeenCalledTimes(1)
})
