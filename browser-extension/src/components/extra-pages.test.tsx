/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { BrowserApi, PermissionRequest } from "@ext/src/lib/browser-api"
import type { CapturedPage } from "@ext/src/lib/panel-state"

import { ExtraPages } from "./extra-pages"

function fakeApi(grant: (request: PermissionRequest) => boolean = () => true) {
  const requests: PermissionRequest[] = []
  const api = {
    message: (key: string, subs?: string[]) => (subs ? `${key}:${subs.join("/")}` : key),
    requestPermissions: async (request: PermissionRequest) => {
      requests.push(request)
      return grant(request)
    },
    listTabs: async () => [
      { id: 1, url: "https://a.test/x", title: "A" },
      { id: 2, url: "https://b.test/y", title: "B" },
      { id: 3, url: "chrome://settings", title: "Settings" },
    ],
  } as unknown as BrowserApi
  return { api, requests }
}

const PAGE: CapturedPage = {
  tabId: 9,
  title: "Nine",
  url: "https://n.test/",
  rawUrl: "https://n.test/",
  selection: null,
  readableText: null,
  capturedAt: 1,
  strippedQuery: false,
}

function renderPages(api: BrowserApi, overrides: Partial<Parameters<typeof ExtraPages>[0]> = {}) {
  const props = {
    api,
    pages: [] as CapturedPage[],
    maxExtra: 9,
    usedTabIds: [1],
    totalBytes: 0,
    budgetBytes: 512 * 1024,
    onAdd: jest.fn(async () => undefined),
    onRemove: jest.fn(),
    ...overrides,
  }
  render(<ExtraPages {...props} />)
  return props
}

describe("ExtraPages", () => {
  it("asks for tabs, offers other web tabs, then asks for the picked tab's origin", async () => {
    const { api, requests } = fakeApi()
    const props = renderPages(api)
    fireEvent.click(screen.getByTestId("extra-pages-add"))
    await screen.findByTestId("extra-pages-picker")
    expect(screen.queryByTestId("extra-pages-tab-1")).toBeNull()
    expect(screen.queryByTestId("extra-pages-tab-3")).toBeNull()
    fireEvent.click(screen.getByTestId("extra-pages-tab-2"))
    await waitFor(() =>
      expect(props.onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }))
    )
    expect(requests).toEqual([{ permissions: ["tabs"] }, { origins: ["https://b.test/*"] }])
    await waitFor(() => expect(screen.queryByTestId("extra-pages-picker")).toBeNull())
  })

  it("says so when a permission is refused", async () => {
    const { api } = fakeApi((request) => !request.origins)
    const props = renderPages(api)
    fireEvent.click(screen.getByTestId("extra-pages-add"))
    fireEvent.click(await screen.findByTestId("extra-pages-tab-2"))
    expect(await screen.findByTestId("extra-pages-error")).toHaveTextContent("pagesOriginDenied")
    expect(props.onAdd).not.toHaveBeenCalled()

    const denied = fakeApi(() => false)
    renderPages(denied.api)
    fireEvent.click(screen.getAllByTestId("extra-pages-add")[1]!)
    expect(await screen.findByText("pagesTabsDenied")).toBeInTheDocument()
  })

  it("lists added pages, removes them, and shows the budget", () => {
    const { api } = fakeApi()
    const props = renderPages(api, { pages: [PAGE], totalBytes: 600 * 1024, maxExtra: 1 })
    expect(screen.getByTestId("extra-page-0")).toHaveTextContent("pagesPageLabel:2 Nine")
    expect(screen.getByTestId("extra-pages-budget")).toHaveTextContent("pagesBudget:600.0/512")
    expect(screen.getByTestId("extra-pages-over")).toBeInTheDocument()
    expect(screen.getByTestId("extra-pages-add")).toBeDisabled()
    fireEvent.click(screen.getByTestId("extra-page-remove-0"))
    expect(props.onRemove).toHaveBeenCalledWith(0)
  })

  it("reports a tab that could not be read", async () => {
    const { api } = fakeApi()
    renderPages(api, { onAdd: jest.fn(async () => Promise.reject(new Error("no"))) })
    fireEvent.click(screen.getByTestId("extra-pages-add"))
    fireEvent.click(await screen.findByTestId("extra-pages-tab-2"))
    expect(await screen.findByTestId("extra-pages-error")).toHaveTextContent("pagesReadFailed")
  })
})
