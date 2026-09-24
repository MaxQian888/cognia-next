import { collectPages, isOperation, isPage, type Page } from "./companion-paging"

describe("companion paging (ADR-0175 B3)", () => {
  it("preserves an empty opaque token and refuses truncation at an item bound", async () => {
    const fetchPage = jest.fn(async (token?: string): Promise<Page<number>> =>
      token === undefined ? { items: [1], nextPageToken: "" } : { items: [2] }
    )
    await expect(collectPages(fetchPage, { requireComplete: true })).resolves.toEqual([1, 2])
    expect(fetchPage.mock.calls).toEqual([[undefined], [""]])
    await expect(collectPages(fetchPage, { maxItems: 1, requireComplete: true })).rejects.toThrow(
      "item limit"
    )
    const repeated = jest.fn(async () => ({ items: [], nextPageToken: "" }))
    await expect(collectPages(repeated, { requireComplete: true })).rejects.toThrow(
      "repeated page token"
    )
    expect(repeated).toHaveBeenCalledTimes(2)
  })

  it("refuses incomplete authority data and stops repeated tokens immediately", async () => {
    const fetchPage = jest.fn(async () => ({ items: [1], nextPageToken: "same" }))
    await expect(collectPages(fetchPage, { requireComplete: true })).rejects.toThrow(
      "repeated page token"
    )
    expect(fetchPage).toHaveBeenCalledTimes(2)
    await expect(collectPages(fetchPage, { maxPages: 1, requireComplete: true })).rejects.toThrow(
      "page limit"
    )
    await expect(collectPages(fetchPage, { maxItems: 1, requireComplete: true })).rejects.toThrow(
      "item limit"
    )
  })

  it("recognises the page envelope and the operation document", () => {
    expect(isPage({ items: [] })).toBe(true)
    expect(isPage({ items: [1], nextPageToken: "t" })).toBe(true)
    expect(isPage({ items: [1], nextPageToken: 5 })).toBe(false)
    expect(isPage({ rows: [] })).toBe(false)
    expect(isPage(null)).toBe(false)
    expect(
      isOperation({
        id: "op",
        done: false,
        status: "running",
        metadata: { createdAt: 1, updatedAt: 1 },
      })
    ).toBe(true)
    expect(isOperation({ operationId: "op", status: "running" })).toBe(false)
  })

  it("walks pages to the end, hands each token back unchanged, and stops at the bound", async () => {
    const pages: Record<string, Page<number>> = {
      first: { items: [1, 2], nextPageToken: "second" },
      second: { items: [3, 4], nextPageToken: "third" },
      third: { items: [5] },
    }
    const seen: Array<string | undefined> = []
    const fetchPage = async (token: string | undefined) => {
      seen.push(token)
      return pages[token ?? "first"]
    }
    await expect(collectPages(fetchPage)).resolves.toEqual([1, 2, 3, 4, 5])
    expect(seen).toEqual([undefined, "second", "third"])

    await expect(collectPages(fetchPage, { maxItems: 3 })).resolves.toEqual([1, 2, 3])
    await expect(collectPages(fetchPage, { maxPages: 1 })).resolves.toEqual([1, 2])
  })
})
