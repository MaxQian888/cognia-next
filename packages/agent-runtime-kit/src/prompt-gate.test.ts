import type { ExternalAgentMessage } from "@cognia/agent-contracts/external-agent"

import { promptInputPassesGate } from "./prompt-gate"

/** Stands in for the host's PII gate: refuses any payload naming the address. */
const noEmail = (payload: unknown) => !JSON.stringify(payload).includes("alice@example.com")

function message(content: ExternalAgentMessage["content"]): ExternalAgentMessage {
  return { id: "m", role: "user", timestamp: new Date(), content }
}

describe("promptInputPassesGate", () => {
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
    expect(promptInputPassesGate(message([content]), noEmail)).toBe(false)
  })

  it("does not interpret binary image bytes as text", () => {
    expect(
      promptInputPassesGate(
        message([
          {
            type: "image",
            source: { type: "base64", mediaType: "image/png", data: "YWxpY2VAZXhhbXBsZS5jb20=" },
          },
        ]),
        noEmail
      )
    ).toBe(true)
  })

  it("hands the gate the message, its metadata and the decoded text in one payload", () => {
    const gate = jest.fn(() => true)
    const prompt = message([
      { type: "text", text: "hi" },
      {
        type: "file",
        path: "notes.md",
        encoding: "base64",
        content: Buffer.from("decoded body").toString("base64"),
      },
    ])
    expect(promptInputPassesGate(prompt, gate, { turn: 1 })).toBe(true)
    expect(gate).toHaveBeenCalledWith({
      message: prompt,
      metadata: { turn: 1 },
      decodedTextContent: ["decoded body"],
    })
  })

  it("returns the gate's refusal", () => {
    expect(promptInputPassesGate(message([{ type: "text", text: "x" }]), () => false)).toBe(false)
  })
})
