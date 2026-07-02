import type { ReactNode } from "react"
import { render, screen } from "@testing-library/react"

const listProtocolAdapters = jest.fn()
jest.mock("@cognia/provider-core/providers/protocol-adapter-registry", () => ({
  listProtocolAdapters: () => listProtocolAdapters(),
}))

// Echo translation keys so assertions don't depend on message contents, and
// passthrough the Select primitives so we can inspect the option set without
// Radix's portal/measurement machinery.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/ui/select", () => ({
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <div data-testid={`item-${value}`}>{children}</div>
  ),
}))

import { ProtocolSelectContent } from "./protocol-select-content"

beforeEach(() => {
  listProtocolAdapters.mockReset().mockReturnValue([])
})

describe("ProtocolSelectContent", () => {
  it("renders the three built-in protocol options", () => {
    render(<ProtocolSelectContent />)
    expect(screen.getByTestId("item-openai")).toBeInTheDocument()
    expect(screen.getByTestId("item-anthropic")).toBeInTheDocument()
    expect(screen.getByTestId("item-gemini")).toBeInTheDocument()
  })

  it("appends plugin-registered protocol adapters after the built-ins", () => {
    listProtocolAdapters.mockReturnValue([
      { id: "myplug:proto", label: "My Proto", pluginId: "myplug" },
    ])
    render(<ProtocolSelectContent />)
    expect(screen.getByTestId("item-myplug:proto")).toBeInTheDocument()
    expect(screen.getByText("My Proto")).toBeInTheDocument()
  })
})
