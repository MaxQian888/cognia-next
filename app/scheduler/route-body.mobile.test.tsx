import { render } from "@testing-library/react"
import RouteBody from "./route-body.mobile"

const replace = jest.fn()
let search = new URLSearchParams()
const router = { replace }
jest.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => search }))

beforeEach(() => {
  replace.mockClear()
  search = new URLSearchParams()
})

it("redirects the mobile scheduler entry while retaining item, run and filter parameters", () => {
  search = new URLSearchParams("item=task-1&run=run-2&filter=waiting")
  const view = render(<RouteBody />)
  expect(replace).toHaveBeenLastCalledWith("/me/scheduler?item=task-1&run=run-2&filter=waiting")
  search = new URLSearchParams()
  view.rerender(<RouteBody />)
  expect(replace).toHaveBeenLastCalledWith("/me/scheduler")
})
