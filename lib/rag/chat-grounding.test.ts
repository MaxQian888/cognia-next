import type { SendOptions } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"

import { attachInteractiveGrounding, groundSendOptionsAnswer } from "./chat-grounding"

const base: UIMessage[] = [
  {
    id: "assistant",
    role: "assistant",
    parts: [
      { type: "text", text: "The workspace uses pnpm. Revenue doubled yesterday." },
      {
        type: "sources",
        sources: [
          {
            id: "project-file",
            title: "package.json",
            snippet: "The workspace uses pnpm.",
            origin: "project-knowledge",
          },
        ],
      } as unknown as UIMessage["parts"][number],
    ],
  },
]

describe("attachInteractiveGrounding", () => {
  it("persists exact unsupported-claim offsets after a retrieval-backed chat turn", () => {
    const next = attachInteractiveGrounding(base, {
      projectKnowledgeContext: { retrievedChunks: [], degraded: false },
    } as SendOptions)

    expect(next).not.toBe(base)
    expect(next[0].parts).toContainEqual(
      expect.objectContaining({
        type: "grounding",
        action: "annotate",
        claims: [
          expect.objectContaining({ id: "claim-1", supported: true }),
          expect.objectContaining({ id: "claim-2", supported: false, startOffset: 25 }),
        ],
      })
    )
  })

  it("does not manufacture grounding state for non-retrieval turns", () => {
    expect(attachInteractiveGrounding(base, {})).toBe(base)
  })

  it("is idempotent", () => {
    const options = {
      projectKnowledgeContext: { retrievedChunks: [], degraded: false },
    } as SendOptions
    const once = attachInteractiveGrounding(base, options)
    expect(attachInteractiveGrounding(once, options)).toBe(once)
  })

  it("blocks an externally sent answer below the grounding threshold", () => {
    const result = groundSendOptionsAnswer(
      "The workspace uses pnpm. Revenue doubled yesterday.",
      {
        projectKnowledgeContext: {
          retrievedChunks: [{ fileId: "package", content: "The workspace uses pnpm.", score: 1 }],
          degraded: false,
        },
      } as SendOptions,
      "external_send"
    )

    expect(result).toMatchObject({ blocked: true, action: "block" })
  })
})
