/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  clearPermissionRequests,
  requestPluginPermission,
} from "@/lib/plugin/security/permission-requests"

import { PluginPermissionRequestHost } from "./plugin-permission-request-host"

beforeEach(() => {
  clearPermissionRequests()
})

/**
 * `subscribePermissionRequests` and `resolvePluginPermission` had zero callers
 * outside their own module, so `ctx.permissions.requestPermission()` awaited a
 * promise nothing could settle and the calling plugin hung for the session.
 */
describe("PluginPermissionRequestHost", () => {
  it("renders nothing while no plugin is asking", () => {
    const { container } = render(<PluginPermissionRequestHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it("settles the plugin's promise with true when the user allows", async () => {
    render(<PluginPermissionRequestHost />)
    let settled: boolean | undefined
    act(() => {
      void requestPluginPermission({
        pluginId: "acme.widgets",
        permission: "clipboard:read",
        kind: "api",
      }).then((granted) => {
        settled = granted
      })
    })
    await userEvent.click(await screen.findByTestId("plugin-permission-allow"))
    await act(async () => {})
    expect(settled).toBe(true)
  })

  it("settles with false when the user denies", async () => {
    render(<PluginPermissionRequestHost />)
    let settled: boolean | undefined
    act(() => {
      void requestPluginPermission({
        pluginId: "acme.widgets",
        permission: "clipboard:read",
        kind: "manifest",
      }).then((granted) => {
        settled = granted
      })
    })
    await userEvent.click(await screen.findByText("deny"))
    await act(async () => {})
    expect(settled).toBe(false)
  })

  // Leaving the promise pending on dismissal is the exact hang this host is
  // here to end, so closing has to resolve.
  it("treats a dismissal as a denial", async () => {
    render(<PluginPermissionRequestHost />)
    let settled: boolean | undefined
    act(() => {
      void requestPluginPermission({
        pluginId: "acme.widgets",
        permission: "fs:read",
        kind: "api",
      }).then((granted) => {
        settled = granted
      })
    })
    await screen.findByTestId("plugin-permission-request")
    await userEvent.keyboard("{Escape}")
    await act(async () => {})
    expect(settled).toBe(false)
  })

  it("walks the queue one request at a time", async () => {
    render(<PluginPermissionRequestHost />)
    const settled: boolean[] = []
    act(() => {
      void requestPluginPermission({ pluginId: "a", permission: "p1", kind: "api" }).then((g) =>
        settled.push(g)
      )
      void requestPluginPermission({ pluginId: "b", permission: "p2", kind: "api" }).then((g) =>
        settled.push(g)
      )
    })
    expect(await screen.findByTestId("plugin-permission-queued")).toHaveTextContent("1")

    await userEvent.click(screen.getByTestId("plugin-permission-allow"))
    await act(async () => {})
    // The second request takes the prompt over rather than being dropped.
    expect(screen.getByTestId("plugin-permission-request")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-permission-queued")).toBeNull()

    await userEvent.click(screen.getByTestId("plugin-permission-allow"))
    await act(async () => {})
    expect(settled).toEqual([true, true])
  })
})
