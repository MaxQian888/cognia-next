import {
  agent,
  client,
  methods,
  type InitializeResponse,
  type RequestPermissionRequest,
  type SessionUpdate,
} from "@agentclientprotocol/sdk"

export interface AcpSdkHarnessTranscript {
  protocolVersion: number
  sessionId: string
  stopReason: string
  updates: SessionUpdate[]
  permissionRequests: RequestPermissionRequest[]
}

/**
 * Deterministic, in-process ACP v1 harness backed by the official SDK on both
 * sides. Its generated parsers validate every request/update before a handler
 * runs, which makes it suitable for contract fixtures without child-process or
 * socket timing.
 */
export async function runOfficialAcpSdkHarness(): Promise<AcpSdkHarnessTranscript> {
  const updates: SessionUpdate[] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const sessionId = "sdk-harness-session"

  const fakeAgent = agent({ name: "cognia-conformance-agent" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      const response: InitializeResponse = {
        protocolVersion: Math.min(params.protocolVersion, 1),
        agentCapabilities: {
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { close: {} },
        },
        authMethods: [],
        agentInfo: { name: "cognia-conformance-agent", version: "1" },
      }
      return response
    })
    .onRequest(methods.agent.session.new, () => ({ sessionId }))
    .onRequest(methods.agent.session.prompt, async ({ params, client: clientContext }) => {
      await clientContext.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-1",
          content: { type: "text", text: "conformant" },
        },
      })
      await clientContext.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "tool-1",
          title: "Read fixture",
          kind: "read",
          status: "pending",
          rawInput: { path: "/fixture" },
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      })
      return { stopReason: "end_turn" }
    })

  const fakeClient = client({ name: "cognia-conformance-client" })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update)
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissionRequests.push(params)
      return { outcome: { outcome: "selected", optionId: "allow" } }
    })

  return fakeClient.connectWith(fakeAgent, async (context) => {
    const initialized = await context.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true } },
      clientInfo: { name: "cognia-conformance-client", version: "1" },
    })
    const created = await context.request(methods.agent.session.new, {
      cwd: "/fixture",
      mcpServers: [],
    })
    const prompted = await context.request(methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    })
    return {
      protocolVersion: initialized.protocolVersion,
      sessionId: created.sessionId,
      stopReason: prompted.stopReason,
      updates,
      permissionRequests,
    }
  })
}
