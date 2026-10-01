/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
let state: { alwaysOn: string[] } | undefined = { alwaysOn: [] }
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => state }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))
const setPluginAlwaysOn = jest.fn(async (_id: string, _on: boolean) => undefined)
jest.mock("@/lib/plugin/cogset/actions", () => ({
  setPluginAlwaysOn: (id: string, on: boolean) => setPluginAlwaysOn(id, on),
}))
let mirrored = false
jest.mock("@/lib/plugin/core/mirrored-client", () => ({ isMirroredPluginClient: () => mirrored }))
const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu"

import { AlwaysOnMenuItem } from "./always-on-menu-item"

function renderItem() {
  return render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <AlwaysOnMenuItem pluginId="core" pluginName="Core" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  state = { alwaysOn: [] }
  mirrored = false
})

describe("AlwaysOnMenuItem", () => {
  it("adds a plugin to always on", () => {
    renderItem()
    expect(screen.getByText("add")).toBeTruthy()
    fireEvent.click(screen.getByTestId("plugin-row-always-on"))
    expect(setPluginAlwaysOn).toHaveBeenCalledWith("core", true)
  })

  it("removes a plugin that is always on", () => {
    state = { alwaysOn: ["core"] }
    renderItem()
    fireEvent.click(screen.getByText("remove"))
    expect(setPluginAlwaysOn).toHaveBeenCalledWith("core", false)
  })

  it("is disabled on a mirrored client and says where to change it", () => {
    mirrored = true
    renderItem()
    expect(screen.getByTestId("plugin-row-always-on").getAttribute("data-disabled")).not.toBeNull()
    expect(screen.getByText("mirrored")).toBeTruthy()
  })

  it("toasts a failure", async () => {
    setPluginAlwaysOn.mockRejectedValueOnce(new Error("nope"))
    renderItem()
    fireEvent.click(screen.getByTestId("plugin-row-always-on"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('failed:{"name":"Core"}', { description: "nope" })
    )
  })
})
