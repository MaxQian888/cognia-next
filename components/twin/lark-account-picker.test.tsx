import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { LarkAccountPicker } from "./lark-account-picker"

jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstancesByType: jest.fn(),
}))

import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"

const listMock = listAdapterInstancesByType as jest.Mock

function larkRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "lark",
    displayName: `Lark ${id}`,
    enabled: true,
    settings: {},
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("LarkAccountPicker", () => {
  it("shows the empty state with a settings link when nothing is bound", async () => {
    listMock.mockResolvedValue([larkRow("cai_off", { enabled: false })])
    render(<LarkAccountPicker value={null} onChange={() => {}} />)

    const empty = await screen.findByTestId("twin-lark-picker-empty")
    expect(empty).toHaveTextContent(/No Feishu account/i)
    const link = screen.getByRole("link")
    expect(link).toHaveAttribute("href", "/settings?section=connections")
  })

  it("auto-selects the only bound account", async () => {
    listMock.mockResolvedValue([larkRow("cai_solo")])
    const onChange = jest.fn()
    render(<LarkAccountPicker value={null} onChange={onChange} />)

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("cai_solo"))
  })

  it("lists accounts with the connected user's name and picks on click", async () => {
    listMock.mockResolvedValue([
      larkRow("cai_a", { settings: { connectedUser: { openId: "ou_1", name: "Alice" } } }),
      larkRow("cai_b"),
    ])
    const onChange = jest.fn()
    const user = userEvent.setup()
    render(<LarkAccountPicker value="cai_a" onChange={onChange} />)

    const trigger = await screen.findByRole("combobox", { name: /account/i })
    expect(trigger).toHaveTextContent("Lark cai_a · Alice")

    await user.click(trigger)
    await user.click(await screen.findByRole("option", { name: "Lark cai_b" }))
    expect(onChange).toHaveBeenCalledWith("cai_b")
  })

  it("hints when the selected account has no connected user", async () => {
    listMock.mockResolvedValue([larkRow("cai_a"), larkRow("cai_b")])
    render(<LarkAccountPicker value="cai_a" onChange={() => {}} />)

    expect(await screen.findByTestId("twin-lark-picker-app-only")).toBeInTheDocument()
  })

  it("does not auto-select when multiple accounts exist", async () => {
    listMock.mockResolvedValue([larkRow("cai_a"), larkRow("cai_b")])
    const onChange = jest.fn()
    render(<LarkAccountPicker value={null} onChange={onChange} />)

    await screen.findByTestId("twin-lark-picker")
    expect(onChange).not.toHaveBeenCalled()
  })
})
