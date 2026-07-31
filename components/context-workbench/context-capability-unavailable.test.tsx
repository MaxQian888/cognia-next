import { render, screen } from "@testing-library/react"
import { ContextCapabilityUnavailable } from "./context-capability-unavailable"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

it("explains an unsupported capability instead of presenting a fake implementation", () => {
  render(<ContextCapabilityUnavailable capability="comments" />)
  expect(screen.getByText("comments.title")).toBeInTheDocument()
  expect(screen.getByText("comments.description")).toBeInTheDocument()
})
