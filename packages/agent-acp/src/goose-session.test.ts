import { createGooseSessionControls, gooseSessionExtension } from "./goose-session"

function fixture() {
  const child = {
    id: "child",
    parent_session_id: "parent",
    name: "Work",
    conversation: [] as unknown[],
  }
  const request = jest.fn(async (_method: string, params: Record<string, unknown>) => ({
    data:
      params.format === "markdown"
        ? "# Child progress"
        : JSON.stringify(
            params.sessionId === "parent"
              ? {
                  id: "parent",
                  conversation: [
                    {
                      content: [
                        {
                          type: "toolResponse",
                          toolResult: {
                            status: "success",
                            value: {
                              _meta: { subagent_session_id: "child" },
                            },
                          },
                        },
                      ],
                    },
                  ],
                }
              : child
          ),
  }))
  const isBusy = jest.fn(() => false)
  const controls = createGooseSessionControls({
    request: request as never,
    hasParent: (id) => id === "parent",
    isBusy,
    outboundGate: (payload) => !JSON.stringify(payload).includes("sensitive-child"),
  })
  return { controls, request, child, isBusy }
}

it("lists and passively exports an owned child without loading a live session", async () => {
  const { controls, request } = fixture()
  expect(await controls.listChildren("parent")).toEqual(["child"])
  expect(await controls.inspect("parent", "child")).toMatchObject({
    id: "child",
    parentId: "parent",
    transcript: "# Child progress",
    completed: false,
  })
  expect(request.mock.calls.every(([method]) => method === "_goose/unstable/session/export")).toBe(
    true
  )
  expect(await controls.recoveryPrompt("parent", "child")).toContain('"resume":"child"')
})

it("rejects unknown parents, foreign children and active parent turns", async () => {
  const { controls, child, isBusy } = fixture()
  await expect(controls.inspect("unknown", "child")).rejects.toThrow("Unknown Goose parent")
  child.parent_session_id = "other"
  await expect(controls.inspect("parent", "child")).rejects.toThrow("another parent")
  isBusy.mockReturnValue(true)
  await expect(controls.recoveryPrompt("parent", "child")).rejects.toThrow("finish")
})

it("refuses completed children using Goose's paired final-output success contract", async () => {
  const { controls, child } = fixture()
  child.conversation = [
    {
      content: [
        {
          type: "toolRequest",
          id: "f",
          toolCall: { status: "success", value: { name: "recipe__final_output" } },
        },
        {
          type: "toolResponse",
          id: "f",
          toolResult: {
            status: "success",
            value: { content: [{ type: "text", text: "Final output successfully collected." }] },
          },
        },
      ],
    },
  ]
  await expect(controls.recoveryPrompt("parent", "child")).rejects.toThrow("Completed")
  expect(gooseSessionExtension.resolve({} as never)).toBeUndefined()
})

it("rejects mismatched and oversized exports before showing transcript", async () => {
  const { controls, request, child } = fixture()
  child.id = "other"
  await expect(controls.inspect("parent", "child")).rejects.toThrow("identity")
  request.mockResolvedValue({ data: "x".repeat(8 * 1024 * 1024 + 1) })
  await expect(controls.listChildren("parent")).rejects.toThrow("oversized")
})

it("gates the saved child context before preparing a parent recovery prompt", async () => {
  const { controls, child } = fixture()
  child.conversation = [{ content: [{ type: "text", text: "sensitive-child" }] }]
  await expect(controls.recoveryPrompt("parent", "child")).rejects.toThrow("PII gate")
})
