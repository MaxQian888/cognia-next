import { LarkAccessError } from "@/lib/connectors/adapters/lark/authed-api"
import { LarkApiError } from "@/lib/connectors/adapters/lark/auth-retry"
import { LarkIngestError } from "@/lib/twin/ingest/lark-doc-fetcher"
import { DocsProviderError } from "@/lib/docs-providers/types"
import { toDocsProviderError } from "./errors"

describe("toDocsProviderError", () => {
  it("passes an existing DocsProviderError through untouched", () => {
    const original = new DocsProviderError("rateLimited", { account: "Acme" })
    expect(toDocsProviderError(original)).toBe(original)
  })

  it.each([
    ["browserUnsupported", "hostUnsupported"],
    ["noAccount", "notConfigured"],
    ["notAuthorized", "notAuthorized"],
  ] as const)("maps access failure %s to %s", (accessCode, expected) => {
    expect(toDocsProviderError(new LarkAccessError(accessCode, "Acme"))).toMatchObject({
      code: expected,
    })
  })

  it.each([
    ["larkInvalidUrl", "invalidRef"],
    ["larkNoAccount", "notConfigured"],
    ["larkNotAuthorized", "notAuthorized"],
    ["larkNoPermission", "noPermission"],
    ["larkNotFound", "notFound"],
    ["larkUnsupportedType", "unsupportedType"],
    ["larkRateLimited", "rateLimited"],
    ["larkEmptyDoc", "empty"],
    ["larkBrowserUnsupported", "hostUnsupported"],
    ["larkCliUnavailable", "notConfigured"],
    ["larkNetwork", "network"],
  ] as const)("maps ingest code %s to %s", (ingestCode, expected) => {
    expect(toDocsProviderError(new LarkIngestError(ingestCode))).toMatchObject({ code: expected })
  })

  it("keeps the ingest error's params so the UI can name the account or doc", () => {
    const mapped = toDocsProviderError(new LarkIngestError("larkNoPermission", { account: "Acme" }))
    expect(mapped.params).toEqual({ account: "Acme" })
  })

  it("routes a raw Lark API error through the shared business-code table", () => {
    expect(
      toDocsProviderError(new LarkApiError({ status: 403, code: 1254302, message: "no" }), "Acme")
    ).toMatchObject({ code: "noPermission" })
    expect(
      toDocsProviderError(new LarkApiError({ status: 429, code: null, message: "slow" }))
    ).toMatchObject({ code: "rateLimited" })
  })

  it("falls back to network for an unrecognized failure", () => {
    expect(toDocsProviderError(new Error("socket hang up"))).toMatchObject({
      code: "network",
      params: { reason: "socket hang up" },
    })
  })
})
