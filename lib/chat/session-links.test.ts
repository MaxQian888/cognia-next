import type { UIMessage } from "ai"

import { collectAssistantOutputFiles, collectSharedLinks } from "./session-links"

function message(role: "assistant" | "user", parts: unknown[]): UIMessage {
  return { id: `${role}-${parts.length}`, role, parts } as unknown as UIMessage
}

describe("collectAssistantOutputFiles", () => {
  it("keeps assistant file parts with an openable protocol, deduplicated by url", () => {
    const files = collectAssistantOutputFiles([
      message("user", [{ type: "file", url: "https://in.dev/upload.png", mediaType: "image/png" }]),
      message("assistant", [
        { type: "file", url: "https://out.dev/report.pdf", filename: "report.pdf" },
        { type: "file", url: "https://out.dev/report.pdf", filename: "report.pdf" },
        { type: "file", url: "file:///etc/passwd" },
        { type: "file", url: "not a url" },
        { type: "file", url: "data:text/plain;base64,aGk=", mediaType: "text/plain" },
      ]),
    ])
    expect(files).toEqual([
      { url: "https://out.dev/report.pdf", filename: "report.pdf", mediaType: undefined },
      { url: "data:text/plain;base64,aGk=", filename: undefined, mediaType: "text/plain" },
    ])
  })
})

describe("collectSharedLinks", () => {
  it("lists links from assistant text once, skipping user text and output files", () => {
    const messages = [
      message("user", [{ type: "text", text: "see https://user.dev/x" }]),
      message("assistant", [
        { type: "text", text: "Read https://docs.dev/a and https://docs.dev/a again." },
        { type: "text", text: "Download: https://out.dev/report.pdf" },
        { type: "file", url: "https://out.dev/report.pdf" },
      ]),
    ]
    const outputs = collectAssistantOutputFiles(messages)
    expect(collectSharedLinks(messages, outputs)).toEqual(["https://docs.dev/a"])
  })

  it("defaults to no output exclusions", () => {
    expect(
      collectSharedLinks([message("assistant", [{ type: "text", text: "https://a.dev/" }])])
    ).toEqual(["https://a.dev/"])
  })
})
