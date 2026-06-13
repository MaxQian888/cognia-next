/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { CustomLimitsSource } from "@/types/subscription"

// next-intl is globally mocked against en.json in jest.setup.ts.

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const saveMock = jest.fn(async (_patch: Record<string, unknown>) => {})
let storeSettings: { customLimitsSources?: CustomLimitsSource[] }
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ settings: storeSettings, save: saveMock }),
    { getState: () => ({ settings: storeSettings, save: saveMock }) }
  ),
}))

const authedGetMock = jest.fn(async (_url: string, _headers?: Record<string, string>) => "{}")
jest.mock("@/lib/subscription/core/transport", () => ({
  authedGet: (url: string, headers?: Record<string, string>) => authedGetMock(url, headers),
}))

// Replace the Radix Select with a native <select> so onValueChange is drivable
// in jsdom. SelectItem → <option>; the trigger/value chrome render nothing.
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react")
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string
      onValueChange: (v: string) => void
      children: React.ReactNode
    }) =>
      React.createElement(
        "select",
        {
          role: "combobox",
          value,
          onChange: (e: { target: { value: string } }) => onValueChange(e.target.value),
        },
        children
      ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => children,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) =>
      React.createElement("option", { value }, children),
  }
})

import { CustomSourcesCard } from "./custom-sources-card"

function source(over: Partial<CustomLimitsSource> = {}): CustomLimitsSource {
  return {
    id: "relay1",
    name: "My Relay",
    baseUrl: "https://relay.example.com/v1",
    token: "tok",
    request: { path: "/balance" },
    extract: { kind: "balance", remainingPath: "data.balance", unit: "USD" },
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  storeSettings = {}
})

describe("CustomSourcesCard", () => {
  it("shows the web-mode hint outside Tauri", () => {
    isTauriMock.mockReturnValue(false)
    render(<CustomSourcesCard />)
    expect(screen.getByText(/Custom sources require the desktop build/i)).toBeInTheDocument()
  })

  it("renders the empty state with an add button", () => {
    render(<CustomSourcesCard />)
    expect(screen.getByText("No custom sources yet.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Add custom source/i })).toBeInTheDocument()
  })

  it("lists existing sources and removes one via save", async () => {
    storeSettings = { customLimitsSources: [source()] }
    render(<CustomSourcesCard />)
    expect(screen.getByTestId("custom-source-relay1")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Remove" }))
    expect(saveMock).toHaveBeenCalledWith({ customLimitsSources: [] })
  })

  it("adds a balance source and persists the normalized payload", async () => {
    render(<CustomSourcesCard />)
    await userEvent.click(screen.getByRole("button", { name: /Add custom source/i }))

    await userEvent.type(screen.getByLabelText("Name"), "Relay X")
    await userEvent.type(screen.getByLabelText("Base URL"), "https://x.example.com/v1/")
    await userEvent.type(screen.getByLabelText("Token"), "sk-x")
    await userEvent.type(screen.getByLabelText("Request path"), "/balance")
    await userEvent.type(screen.getByLabelText("Remaining field path"), "data.balance")

    const saveBtn = screen.getByRole("button", { name: "Save" })
    await waitFor(() => expect(saveBtn).toBeEnabled())
    await userEvent.click(saveBtn)

    expect(saveMock).toHaveBeenCalledTimes(1)
    const payload = saveMock.mock.calls[0][0] as unknown as {
      customLimitsSources: CustomLimitsSource[]
    }
    const added = payload.customLimitsSources[0]
    expect(added).toMatchObject({
      name: "Relay X",
      baseUrl: "https://x.example.com/v1", // trailing slash stripped
      token: "sk-x",
      request: { path: "/balance" },
    })
    expect(added.extract).toMatchObject({ kind: "balance", remainingPath: "data.balance" })
  })

  it("runs a live test and shows the resulting meter summary", async () => {
    authedGetMock.mockResolvedValue(JSON.stringify({ data: { balance: 7 } }))
    render(<CustomSourcesCard />)
    await userEvent.click(screen.getByRole("button", { name: /Add custom source/i }))

    await userEvent.type(screen.getByLabelText("Name"), "Relay X")
    await userEvent.type(screen.getByLabelText("Base URL"), "https://x.example.com/v1")
    await userEvent.type(screen.getByLabelText("Token"), "sk-x")
    await userEvent.type(screen.getByLabelText("Request path"), "/balance")
    await userEvent.type(screen.getByLabelText("Remaining field path"), "data.balance")

    const testBtn = screen.getByRole("button", { name: "Test" })
    await waitFor(() => expect(testBtn).toBeEnabled())
    await userEvent.click(testBtn)

    await waitFor(() =>
      expect(screen.getByTestId("custom-source-test-result")).toHaveTextContent("Got: 7")
    )
    expect(authedGetMock).toHaveBeenCalledWith(
      "https://x.example.com/v1/balance",
      expect.objectContaining({ Authorization: "Bearer sk-x" })
    )
  })

  async function fillCommon(name = "Relay X") {
    await userEvent.type(screen.getByLabelText("Name"), name)
    await userEvent.type(screen.getByLabelText("Base URL"), "https://x.example.com/v1")
    await userEvent.type(screen.getByLabelText("Token"), "sk-x")
    await userEvent.type(screen.getByLabelText("Request path"), "/usage")
  }

  it("saves a window source with raw auth + an extra header", async () => {
    render(<CustomSourcesCard />)
    await userEvent.click(screen.getByRole("button", { name: /Add custom source/i }))
    await fillCommon()

    const combos = screen.getAllByRole("combobox")
    // combos[0] = auth, combos[1] = reading type.
    await userEvent.selectOptions(combos[0], "raw")
    await userEvent.selectOptions(combos[1], "window")

    await userEvent.type(screen.getByLabelText("Extra header (name)"), "New-Api-User")
    await userEvent.type(screen.getByLabelText("Extra header (value)"), "4242")
    await userEvent.type(screen.getByLabelText("Window label"), "5h")
    await userEvent.type(
      screen.getByLabelText("Used-percent path"),
      "rate_limit.primary.used_percent"
    )

    const saveBtn = screen.getByRole("button", { name: "Save" })
    await waitFor(() => expect(saveBtn).toBeEnabled())
    await userEvent.click(saveBtn)

    const payload = saveMock.mock.calls[0][0] as unknown as {
      customLimitsSources: CustomLimitsSource[]
    }
    const added = payload.customLimitsSources[0]
    expect(added.request.headers).toMatchObject({
      Authorization: "{{token}}",
      "New-Api-User": "4242",
    })
    expect(added.extract).toMatchObject({ kind: "window" })
  })

  it("tests a window source and shows a percent summary", async () => {
    authedGetMock.mockResolvedValue(
      JSON.stringify({ rate_limit: { primary: { used_percent: 40 } } })
    )
    render(<CustomSourcesCard />)
    await userEvent.click(screen.getByRole("button", { name: /Add custom source/i }))
    await fillCommon()
    await userEvent.selectOptions(screen.getAllByRole("combobox")[1], "window")
    await userEvent.type(screen.getByLabelText("Window label"), "5h")
    await userEvent.type(
      screen.getByLabelText("Used-percent path"),
      "rate_limit.primary.used_percent"
    )
    const testBtn = screen.getByRole("button", { name: "Test" })
    await waitFor(() => expect(testBtn).toBeEnabled())
    await userEvent.click(testBtn)
    await waitFor(() =>
      expect(screen.getByTestId("custom-source-test-result")).toHaveTextContent("Got: 40%")
    )
  })

  it("shows a test error when the endpoint throws", async () => {
    authedGetMock.mockRejectedValue(new Error("HTTP 401"))
    render(<CustomSourcesCard />)
    await userEvent.click(screen.getByRole("button", { name: /Add custom source/i }))
    await fillCommon()
    await userEvent.type(screen.getByLabelText("Remaining field path"), "data.balance")
    const testBtn = screen.getByRole("button", { name: "Test" })
    await waitFor(() => expect(testBtn).toBeEnabled())
    await userEvent.click(testBtn)
    await waitFor(() =>
      expect(screen.getByTestId("custom-source-test-result")).toHaveTextContent(
        "Test failed: HTTP 401"
      )
    )
  })

  it("shows no-data when the response has no usable fields", async () => {
    authedGetMock.mockResolvedValue(JSON.stringify({ nope: 1 }))
    render(<CustomSourcesCard />)
    await userEvent.click(screen.getByRole("button", { name: /Add custom source/i }))
    await fillCommon()
    await userEvent.type(screen.getByLabelText("Remaining field path"), "data.balance")
    const testBtn = screen.getByRole("button", { name: "Test" })
    await waitFor(() => expect(testBtn).toBeEnabled())
    await userEvent.click(testBtn)
    await waitFor(() =>
      expect(screen.getByTestId("custom-source-test-result")).toHaveTextContent(
        "No usable data returned"
      )
    )
  })

  it("fills total/unit/scale and toggles kind+auth back to defaults", async () => {
    render(<CustomSourcesCard />)
    await userEvent.click(screen.getByRole("button", { name: /Add custom source/i }))
    await fillCommon()

    const combos = screen.getAllByRole("combobox")
    // Toggle kind to window then back to balance (covers both switch arms).
    await userEvent.selectOptions(combos[1], "window")
    await userEvent.selectOptions(combos[1], "balance")
    // Toggle auth to raw then back to bearer (covers the bearer/delete arm).
    await userEvent.selectOptions(combos[0], "raw")
    await userEvent.selectOptions(combos[0], "bearer")

    // Add then clear an extra header (covers the name-empty branch).
    await userEvent.type(screen.getByLabelText("Extra header (name)"), "X-Foo")
    await userEvent.clear(screen.getByLabelText("Extra header (name)"))

    await userEvent.type(screen.getByLabelText("Remaining field path"), "data.quota")
    await userEvent.type(screen.getByLabelText("Total field path"), "data.total")
    await userEvent.clear(screen.getByLabelText("Unit"))
    await userEvent.type(screen.getByLabelText("Unit"), "USD")
    await userEvent.clear(screen.getByLabelText("Scale"))
    await userEvent.type(screen.getByLabelText("Scale"), "0.001")

    // Test renders the balance-with-unit summary branch.
    authedGetMock.mockResolvedValue(JSON.stringify({ data: { quota: 5000, total: 10000 } }))
    const testBtn = screen.getByRole("button", { name: "Test" })
    await waitFor(() => expect(testBtn).toBeEnabled())
    await userEvent.click(testBtn)
    await waitFor(() =>
      expect(screen.getByTestId("custom-source-test-result")).toHaveTextContent("Got: 5 USD")
    )

    const saveBtn = screen.getByRole("button", { name: "Save" })
    await waitFor(() => expect(saveBtn).toBeEnabled())
    await userEvent.click(saveBtn)

    const payload = saveMock.mock.calls[0][0] as unknown as {
      customLimitsSources: CustomLimitsSource[]
    }
    const added = payload.customLimitsSources[0]
    expect(added.extract).toMatchObject({
      kind: "balance",
      remainingPath: "data.quota",
      totalPath: "data.total",
      unit: "USD",
      scale: 0.001,
    })
    // Bearer is the engine default → no Authorization header persisted.
    expect(added.request.headers?.Authorization).toBeUndefined()
  })

  it("edits an existing source (form pre-filled) and cancels", async () => {
    storeSettings = { customLimitsSources: [source({ name: "Old Name" })] }
    render(<CustomSourcesCard />)
    await userEvent.click(screen.getByRole("button", { name: "Edit" }))
    expect(screen.getByLabelText("Name")).toHaveValue("Old Name")
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByTestId("custom-source-form")).not.toBeInTheDocument()
  })

  it("closes the form when removing the source being edited", async () => {
    storeSettings = { customLimitsSources: [source()] }
    render(<CustomSourcesCard />)
    await userEvent.click(screen.getByRole("button", { name: "Edit" }))
    expect(screen.getByTestId("custom-source-form")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Remove" }))
    expect(saveMock).toHaveBeenCalledWith({ customLimitsSources: [] })
    expect(screen.queryByTestId("custom-source-form")).not.toBeInTheDocument()
  })

  it("falls back to the id when a source has no name", () => {
    storeSettings = { customLimitsSources: [source({ id: "noname", name: "" })] }
    render(<CustomSourcesCard />)
    const row = screen.getByTestId("custom-source-noname")
    expect(row).toHaveTextContent("noname")
  })
})
