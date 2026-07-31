import { render, screen } from "@testing-library/react"

let searchParams = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}))

const consoleProps = jest.fn()
jest.mock("@/components/pet/console/pet-console", () => ({
  PetConsole: (props: unknown) => {
    consoleProps(props)
    return <div data-testid="pet-console-stub" />
  },
}))

import PetPage from "./page"

beforeEach(() => {
  consoleProps.mockClear()
  searchParams = new URLSearchParams()
})

describe("PetPage", () => {
  it("renders the console with no initial tab by default", () => {
    render(<PetPage />)
    expect(screen.getByTestId("pet-console-stub")).toBeInTheDocument()
    expect(consoleProps).toHaveBeenCalledWith(expect.objectContaining({ initialTab: undefined }))
  })

  it("passes a valid ?tab= deep link through and drops an invalid one", () => {
    searchParams = new URLSearchParams("tab=shop")
    render(<PetPage />)
    expect(consoleProps).toHaveBeenCalledWith(expect.objectContaining({ initialTab: "shop" }))

    consoleProps.mockClear()
    searchParams = new URLSearchParams("tab=not-a-tab")
    render(<PetPage />)
    expect(consoleProps).toHaveBeenCalledWith(expect.objectContaining({ initialTab: undefined }))
  })
})
