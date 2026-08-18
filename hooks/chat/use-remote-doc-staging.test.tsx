import { renderHook } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import messages from "@/i18n/messages/en.json"

jest.mock("sonner", () => ({
  toast: {
    loading: jest.fn(() => "toast-1"),
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
  },
}))
jest.mock("@/lib/docs-providers", () => ({
  ...jest.requireActual("@/lib/docs-providers/types"),
  getDocsProvider: jest.fn(),
}))

import { toast } from "sonner"
import { DocsProviderError, getDocsProvider } from "@/lib/docs-providers"
import type { RemoteDocContent, RemoteDocRef } from "@/lib/docs-providers"
import { remoteDocFileName, remoteDocToFile, useRemoteDocStaging } from "./use-remote-doc-staging"

const getProviderMock = getDocsProvider as jest.Mock

const REF: RemoteDocRef = {
  providerId: "lark",
  kind: "doc",
  id: "doxcn1",
  title: "Q3 Plan",
}

function content(overrides: Partial<RemoteDocContent> = {}): RemoteDocContent {
  return { ref: REF, title: "Q3 Plan", text: "body text", format: "markdown", ...overrides }
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  )
}

/** jsdom's `File` has no `.text()`, so read it the way the browser API allows. */
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

function renderStaging(acceptFiles = jest.fn()) {
  const { result } = renderHook(() => useRemoteDocStaging({ acceptFiles }), { wrapper })
  return { stage: result.current, acceptFiles }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("remoteDocFileName", () => {
  it("keeps the title, dropping only characters a filesystem would reject", () => {
    expect(remoteDocFileName("Q3 Plan: v2/final", "id", "markdown")).toBe("Q3 Plan v2 final.md")
  })

  it("preserves CJK titles", () => {
    expect(remoteDocFileName("三季度计划", "id", "csv")).toBe("三季度计划.csv")
  })

  it("falls back to the document id when nothing usable survives", () => {
    expect(remoteDocFileName("///", "doxcn1", "text")).toBe("doxcn1.txt")
    expect(remoteDocFileName("   ", "doxcn1", "text")).toBe("doxcn1.txt")
  })

  it("bounds the length so the attachment chip stays readable", () => {
    expect(remoteDocFileName("a".repeat(500), "id", "markdown")).toHaveLength(120 + 3)
  })
})

describe("remoteDocToFile", () => {
  it("frames the body as untrusted external content", async () => {
    const body = await readFile(remoteDocToFile(content()))
    expect(body).toContain("Untrusted")
    expect(body).toContain("body text")
  })

  it.each([
    ["markdown", "text/markdown", ".md"],
    ["text", "text/plain", ".txt"],
    ["csv", "text/csv", ".csv"],
  ] as const)("routes %s to %s", (format, mime, ext) => {
    const file = remoteDocToFile(content({ format }))
    expect(file.type).toBe(mime)
    expect(file.name.endsWith(ext)).toBe(true)
  })
})

describe("useRemoteDocStaging", () => {
  it("fetches through the provider and stages the result as an attachment", async () => {
    const fetchDoc = jest.fn(async () => content())
    getProviderMock.mockReturnValue({ fetch: fetchDoc })
    const { stage, acceptFiles } = renderStaging()

    await stage({ providerId: "lark", accountId: "cai_1", doc: REF })

    expect(fetchDoc).toHaveBeenCalledWith(REF, { accountId: "cai_1" })
    expect(acceptFiles).toHaveBeenCalledTimes(1)
    const [staged] = acceptFiles.mock.calls[0][0] as File[]
    expect(staged.name).toBe("Q3 Plan.md")
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("Q3 Plan"), {
      id: "toast-1",
    })
  })

  it("warns separately when the provider had to truncate", async () => {
    getProviderMock.mockReturnValue({ fetch: async () => content({ truncated: true }) })
    const { stage } = renderStaging()
    await stage({ providerId: "lark", accountId: "cai_1", doc: REF })
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("truncated"))
  })

  it("does not warn when nothing was truncated", async () => {
    getProviderMock.mockReturnValue({ fetch: async () => content() })
    const { stage } = renderStaging()
    await stage({ providerId: "lark", accountId: "cai_1", doc: REF })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it("shows the localized reason for a typed provider failure and stages nothing", async () => {
    getProviderMock.mockReturnValue({
      fetch: async () => {
        throw new DocsProviderError("noPermission")
      },
    })
    const { stage, acceptFiles } = renderStaging()
    await stage({ providerId: "lark", accountId: "cai_1", doc: REF })
    expect(acceptFiles).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith("You do not have access to this document.", {
      id: "toast-1",
    })
  })

  it("falls back to the network message for an untyped failure", async () => {
    getProviderMock.mockReturnValue({
      fetch: async () => {
        throw new Error("socket hang up")
      },
    })
    const { stage } = renderStaging()
    await stage({ providerId: "lark", accountId: "cai_1", doc: REF })
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Could not reach"), {
      id: "toast-1",
    })
  })

  it("reports an unregistered provider instead of throwing", async () => {
    getProviderMock.mockReturnValue(undefined)
    const { stage, acceptFiles } = renderStaging()
    await expect(stage({ providerId: "ghost", accountId: "x", doc: REF })).resolves.toBeUndefined()
    expect(acceptFiles).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })
})
