import type { ZodTypeAny } from "zod"

import * as schemas from "./provider-operation-schemas"
import { PROVIDER_OPERATION_IDS } from "./provider-operations"

function exportNameFor(id: string, suffix: "Input" | "Output"): string {
  const parts = id.split(/[.-]/)
  return (
    parts[0] +
    parts
      .slice(1)
      .map((p) => p[0]!.toUpperCase() + p.slice(1))
      .join("") +
    suffix
  )
}

describe("provider operation schemas", () => {
  it("exports an input and an output schema for every operation id", () => {
    const exported = schemas as Record<string, unknown>
    for (const id of PROVIDER_OPERATION_IDS) {
      for (const suffix of ["Input", "Output"] as const) {
        const name = exportNameFor(id, suffix)
        const schema = exported[name] as ZodTypeAny | undefined
        expect(schema && typeof schema.safeParse === "function").toBe(true)
      }
    }
  })

  it("validates a language request and rejects an empty one", () => {
    expect(
      schemas.languageGenerateInput.safeParse({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }).success
    ).toBe(true)
    expect(schemas.languageGenerateInput.safeParse({ model: "m", messages: [] }).success).toBe(
      false
    )
  })

  it("requires the full ownership tuple on a resource handle", () => {
    const handle = {
      kind: "file",
      id: "file_1",
      providerId: "openai",
      deploymentRef: "dep_1",
      accountRef: "acct_1",
      credentialAffinity: "fp_1",
    }
    expect(schemas.filesGetInput.safeParse({ handle }).success).toBe(true)
    const { accountRef: _dropped, ...withoutAccount } = handle
    expect(schemas.filesGetInput.safeParse({ handle: withoutAccount }).success).toBe(false)
  })

  it("types a token count by its method", () => {
    expect(schemas.tokensCountOutput.parse({ inputTokens: 3, method: "estimate" }).method).toBe(
      "estimate"
    )
  })
})
