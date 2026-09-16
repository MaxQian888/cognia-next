import { render, screen } from "@testing-library/react"

const replace = jest.fn()
let searchParams = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
}))

let compact = false
jest.mock("@/hooks/ui/use-compact-layout", () => ({
  useCompactLayout: () => compact,
}))

let consoleProps: Record<string, unknown> = {}
jest.mock("@/components/bots/bot-console", () => ({
  BotConsole: (props: Record<string, unknown>) => {
    consoleProps = props
    return <div data-testid="bot-console-stub" />
  },
}))
let mobileProps: Record<string, unknown> = {}
jest.mock("@/components/mobile/bots/bots-mobile-body", () => ({
  BotsMobileBody: (props: Record<string, unknown>) => {
    mobileProps = props
    return <div data-testid="bots-mobile-stub" />
  },
}))

import BotsPage from "./page"

beforeEach(() => {
  replace.mockReset()
  searchParams = new URLSearchParams()
  compact = false
  consoleProps = {}
  mobileProps = {}
})

describe("BotsPage", () => {
  it("renders the desktop console with the deep link passed through", () => {
    searchParams = new URLSearchParams("bot=boti_1&install=1")
    render(<BotsPage />)
    expect(screen.getByTestId("bot-console-stub")).toBeInTheDocument()
    expect(screen.queryByTestId("bots-mobile-stub")).not.toBeInTheDocument()
    expect(consoleProps.selectedId).toBe("boti_1")
    expect(consoleProps.installParam).toBe("1")
  })

  it("swaps in the list-first mobile body on a compact viewport", () => {
    compact = true
    searchParams = new URLSearchParams("bot=boti_1")
    render(<BotsPage />)
    expect(screen.getByTestId("bots-mobile-stub")).toBeInTheDocument()
    expect(screen.queryByTestId("bot-console-stub")).not.toBeInTheDocument()
    expect(mobileProps.selectedId).toBe("boti_1")
  })

  it("writes ?bot= on select and drops the consumed ?install= param", () => {
    searchParams = new URLSearchParams("install=1")
    render(<BotsPage />)
    ;(consoleProps.onSelect as (id: string) => void)("boti_2")
    expect(replace).toHaveBeenCalledWith("/bots?bot=boti_2")
  })

  it("keeps unrelated params when selecting", () => {
    searchParams = new URLSearchParams("theme=dark")
    render(<BotsPage />)
    ;(consoleProps.onSelect as (id: string) => void)("boti_2")
    expect(replace).toHaveBeenCalledWith("/bots?theme=dark&bot=boti_2")
  })

  it("clears only ?bot= on deselect", () => {
    searchParams = new URLSearchParams("bot=boti_1&theme=dark")
    render(<BotsPage />)
    ;(consoleProps.onDeselect as () => void)()
    expect(replace).toHaveBeenCalledWith("/bots?theme=dark")
  })

  it("returns to the bare route when the deselected param was the only one", () => {
    searchParams = new URLSearchParams("bot=boti_1")
    render(<BotsPage />)
    ;(consoleProps.onDeselect as () => void)()
    expect(replace).toHaveBeenCalledWith("/bots")
  })
})
