import { deriveMemberActivity } from "./member-activity"

const tool = (name: string, state: string, input?: Record<string, unknown>) => ({
  type: `tool-${name}`,
  toolCallId: `${name}-${state}`,
  state,
  ...(input ? { input } : {}),
})

it("names the newest tool still running, with its target", () => {
  const messages = [
    { role: "user", parts: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      parts: [
        tool("Read", "output-available", { file_path: "/a/done.ts" }),
        tool("Bash", "input-available", { command: "pnpm test" }),
      ],
    },
  ]
  expect(deriveMemberActivity(messages)).toBe("Bash · pnpm test")
})

it("clears once the running tool has its result", () => {
  const messages = [
    { role: "assistant", parts: [tool("Read", "output-available", { file_path: "/a/b.ts" })] },
  ]
  expect(deriveMemberActivity(messages)).toBeNull()
  expect(deriveMemberActivity([])).toBeNull()
})

it("reports a tool awaiting approval and a streaming one, and ignores user turns", () => {
  expect(
    deriveMemberActivity([{ role: "assistant", parts: [tool("Write", "approval-requested")] }])
  ).toBe("Write")
  expect(
    deriveMemberActivity([{ role: "assistant", parts: [tool("Grep", "input-streaming")] }])
  ).toBe("Grep")
  expect(
    deriveMemberActivity([{ role: "user", parts: [tool("Grep", "input-streaming")] }])
  ).toBeNull()
})

it("treats dynamic tools like named ones and skips malformed parts", () => {
  expect(
    deriveMemberActivity([
      {
        role: "assistant",
        parts: [
          null,
          { type: "text", text: "x" },
          { type: "dynamic-tool", toolName: "lookup", state: "input-available" },
        ],
      },
    ])
  ).toBe("Lookup")
})
