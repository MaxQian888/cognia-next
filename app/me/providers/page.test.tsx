/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const setProviderConfig = jest.fn(async (): Promise<void> => undefined)
const setDefaultProvider = jest.fn(async (): Promise<void> => undefined)

const settingsRef: { current: Record<string, unknown> } = {
  current: { defaultProvider: "anthropic", providerSettings: {} },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: {
      settings: Record<string, unknown>
      setProviderConfig: typeof setProviderConfig
      setDefaultProvider: typeof setDefaultProvider
    }) => unknown
  ) =>
    selector({
      settings: settingsRef.current,
      setProviderConfig,
      setDefaultProvider,
    }),
}))

// Render Radix Select as a native <select> so onValueChange is drivable.
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react")
  const collect = (nodes: unknown, items: unknown[]) => {
    React.Children.forEach(
      nodes,
      (child: { type?: { __isItem?: boolean }; props?: Record<string, unknown> }) => {
        if (!child || typeof child !== "object" || !child.props) return
        if (child.type?.__isItem) items.push(child)
        else if (child.props.children) collect(child.props.children, items)
      }
    )
  }
  const Select = ({ value, onValueChange, children }: Record<string, unknown>) => {
    const items: { props: { value: string; children: unknown } }[] = []
    collect(children, items as unknown[])
    return React.createElement(
      "select",
      {
        "data-testid": "byok-provider",
        value: value as string,
        onChange: (e: { target: { value: string } }) =>
          (onValueChange as (v: string) => void)(e.target.value),
      },
      items.map((it) =>
        React.createElement(
          "option",
          { key: it.props.value, value: it.props.value },
          it.props.value
        )
      )
    )
  }
  const Item = ({ value, children }: Record<string, unknown>) =>
    React.createElement(React.Fragment, null, children ?? value)
  Item.__isItem = true
  const passthrough = ({ children }: { children?: unknown }) =>
    React.createElement(React.Fragment, null, children)
  return {
    Select,
    SelectItem: Item,
    SelectTrigger: passthrough,
    SelectValue: passthrough,
    SelectContent: passthrough,
  }
})

import MobileProvidersPage from "./page"

beforeEach(() => {
  settingsRef.current = { defaultProvider: "anthropic", providerSettings: {} }
  jest.clearAllMocks()
})

describe("MobileProvidersPage (BYOK)", () => {
  it("saves the entered key via setProviderConfig and makes it the default provider", async () => {
    render(<MobileProvidersPage />)
    fireEvent.change(screen.getByTestId("byok-api-key"), { target: { value: " sk-ant-123 " } })
    fireEvent.click(screen.getByTestId("byok-save"))
    expect(setProviderConfig).toHaveBeenCalledWith("anthropic", {
      enabled: true,
      apiKey: "sk-ant-123",
      baseURL: undefined,
    })
    await waitFor(() => expect(setDefaultProvider).toHaveBeenCalledWith("anthropic"))
  })

  it("disables save until a key or base URL is entered", () => {
    render(<MobileProvidersPage />)
    expect(screen.getByTestId("byok-save")).toBeDisabled()
    fireEvent.change(screen.getByTestId("byok-api-key"), { target: { value: "k" } })
    expect(screen.getByTestId("byok-save")).not.toBeDisabled()
  })

  it("loads the stored key when switching providers", () => {
    settingsRef.current = {
      defaultProvider: "anthropic",
      providerSettings: { openai: { apiKey: "sk-oai" } },
    }
    render(<MobileProvidersPage />)
    fireEvent.change(screen.getByTestId("byok-provider"), { target: { value: "openai" } })
    expect(screen.getByTestId("byok-api-key")).toHaveValue("sk-oai")
  })
})
