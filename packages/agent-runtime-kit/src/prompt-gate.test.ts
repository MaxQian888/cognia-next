import { randomBytes } from "node:crypto"

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
      message: {
        ...prompt,
        content: [
          { type: "text", text: "hi" },
          {
            type: "file",
            path: "notes.md",
            encoding: "base64",
            content: "[base64 data, ~12 bytes]",
          },
        ],
      },
      metadata: { turn: 1 },
      decodedTextContent: ["decoded body"],
    })
  })

  it("hands a message with no base64 payload over as it is", () => {
    const gate = jest.fn(() => true)
    const prompt = message([{ type: "text", text: "hi" }])
    promptInputPassesGate(prompt, gate)
    expect(gate.mock.calls[0]?.[0]).toMatchObject({ message: prompt })
    expect((gate.mock.calls[0]?.[0] as { message: unknown }).message).toBe(prompt)
  })

  it("never scans binary payloads as text, so random image bytes cannot trip the gate", () => {
    // The real deep detector, not a stand-in: raw base64 used to trip it by
    // chance on roughly one photo in twenty.
    const { hasNoLeakingPiiDeep } =
      jest.requireActual<typeof import("@cognia/redact")>("@cognia/redact")
    const gate = (payload: unknown) => hasNoLeakingPiiDeep(payload)
    const blocks: ExternalAgentMessage["content"] = []
    for (let i = 0; i < 40; i++) {
      const data = randomBytes(300_000).toString("base64")
      blocks.push({ type: "image", source: { type: "base64", mediaType: "image/png", data } })
    }
    blocks.push({
      type: "audio",
      data: "data:audio/wav;base64,YWxpY2VAZXhhbXBsZS5jb20=",
      mimeType: "audio/wav",
    })
    expect(promptInputPassesGate(message(blocks), gate)).toBe(true)
    // …while the text around them is still scanned.
    expect(
      promptInputPassesGate(message([...blocks, { type: "text", text: "alice@example.com" }]), gate)
    ).toBe(false)
  })

  it("replaces every base64 transport field, leaving the original message untouched", () => {
    const gate = jest.fn(() => true)
    const prompt = message([
      { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } },
      { type: "image", source: { type: "url", mediaType: "image/png", url: "https://x/y.png" } },
      { type: "audio", data: "AAAAAAAA", mimeType: "audio/wav" },
      {
        type: "resource",
        resource: { uri: "file:///a.bin", mimeType: "application/zip", blob: "AAAA" },
      },
    ])
    promptInputPassesGate(prompt, gate)
    const scanned = (gate.mock.calls[0]?.[0] as { message: ExternalAgentMessage }).message
    expect(scanned.content).toEqual([
      {
        type: "image",
        source: { type: "base64", mediaType: "image/png", data: "[base64 image/png, ~3 bytes]" },
      },
      { type: "image", source: { type: "url", mediaType: "image/png", url: "https://x/y.png" } },
      { type: "audio", data: "[base64 audio/wav, ~6 bytes]", mimeType: "audio/wav" },
      {
        type: "resource",
        resource: {
          uri: "file:///a.bin",
          mimeType: "application/zip",
          blob: "[base64 application/zip, ~3 bytes]",
        },
      },
    ])
    expect(prompt.content[0]).toEqual({
      type: "image",
      source: { type: "base64", mediaType: "image/png", data: "AAAA" },
    })
  })

  it("returns the gate's refusal", () => {
    expect(promptInputPassesGate(message([{ type: "text", text: "x" }]), () => false)).toBe(false)
  })
})
