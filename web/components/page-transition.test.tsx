import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

const received: Array<Record<string, unknown>> = []

function loadWith(viewTransition: unknown) {
  jest.resetModules()
  jest.doMock("react", () => ({ ...jest.requireActual("react"), ViewTransition: viewTransition }))
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./page-transition") as typeof import("./page-transition")
}

afterEach(() => {
  received.length = 0
  jest.dontMock("react")
  jest.resetModules()
})

describe("PageTransition", () => {
  it("wraps the page in a ViewTransition classed for the page fade when React has one", () => {
    const { PageTransition } = loadWith(
      ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => {
        received.push(props)
        return <div data-testid="view-transition">{children}</div>
      }
    )
    render(
      <PageTransition>
        <p>page body</p>
      </PageTransition>
    )
    expect(screen.getByTestId("view-transition")).toContainElement(screen.getByText("page body"))
    expect(received).toEqual([{ default: "page-fade" }])
  })

  it("renders the page as it is when the running React has no ViewTransition", () => {
    const { PageTransition } = loadWith(undefined)
    const { container } = render(
      <PageTransition>
        <p>page body</p>
      </PageTransition>
    )
    expect(container.innerHTML).toBe("<p>page body</p>")
  })
})
