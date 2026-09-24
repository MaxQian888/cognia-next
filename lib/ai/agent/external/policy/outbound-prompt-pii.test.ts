import type { ExternalAgentMessage } from "@/types/agent/external-agent"

import { hasNoLeakingExternalAgentPromptInput } from "./outbound-prompt-pii"

function message(content: ExternalAgentMessage["content"]): ExternalAgentMessage {
  return { id: "m", role: "user", timestamp: new Date(), content }
}

describe("hasNoLeakingExternalAgentPromptInput", () => {
  it.each([
    {
      type: "file" as const,
      path: "contacts.txt",
      mimeType: "text/plain",
      encoding: "base64" as const,
      content: Buffer.from("alice@example.com").toString("base64"),
    },
    {
      type: "resource" as const,
      resource: {
        uri: "file:///contacts.json",
        mimeType: "application/json",
        blob: Buffer.from('{"email":"alice@example.com"}').toString("base64"),
      },
    },
    {
      type: "image" as const,
      source: {
        type: "base64" as const,
        mediaType: "image/svg+xml",
        data: Buffer.from("<text>alice@example.com</text>").toString("base64"),
      },
    },
  ])("blocks PII encoded in a text-like $type block", (content) => {
    expect(hasNoLeakingExternalAgentPromptInput(message([content]))).toBe(false)
  })

  it("does not interpret binary image bytes as text", () => {
    expect(
      hasNoLeakingExternalAgentPromptInput(
        message([
          {
            type: "image",
            source: { type: "base64", mediaType: "image/png", data: "YWxpY2VAZXhhbXBsZS5jb20=" },
          },
        ])
      )
    ).toBe(true)
  })
})
