import { runOfficialAcpSdkHarness } from "./acp-sdk-conformance-harness"

describe("official ACP SDK conformance harness", () => {
  it("validates bidirectional requests, notifications, and responses", async () => {
    const transcript = await runOfficialAcpSdkHarness()
    expect(transcript).toMatchObject({
      protocolVersion: 1,
      sessionId: "sdk-harness-session",
      stopReason: "end_turn",
    })
    expect(transcript.updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "conformant" },
      },
    ])
    expect(transcript.permissionRequests[0]).toMatchObject({
      sessionId: "sdk-harness-session",
      toolCall: { toolCallId: "tool-1", kind: "read" },
    })
  })
})
