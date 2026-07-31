/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { UnknownPartCard } from "./unknown-part-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
jest.mock("@/components/ui/collapsible")
jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
}))

describe("UnknownPartCard", () => {
  it("names the unknown part type and dumps its JSON", () => {
    render(<UnknownPartCard part={{ type: "mystery", payload: { a: 1 } }} />)
    const card = screen.getByTestId("unknown-part-card")
    expect(card.dataset.partType).toBe("mystery")
    expect(screen.getByText(/unknownPart.*mystery/)).toBeInTheDocument()
    expect(screen.getByTestId("code-block").textContent).toContain('"payload"')
  })

  it("falls back to 'unknown' when the part has no type", () => {
    render(<UnknownPartCard part={{ foo: "bar" }} />)
    expect(screen.getByTestId("unknown-part-card").dataset.partType).toBe("unknown")
  })

  it("survives a non-serializable part without throwing", () => {
    const circular: Record<string, unknown> = { type: "loopy" }
    circular.self = circular
    render(<UnknownPartCard part={circular} />)
    expect(screen.getByTestId("unknown-part-card").dataset.partType).toBe("loopy")
    expect(screen.getByTestId("code-block")).toBeInTheDocument()
  })
})
