/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

import { CodeServerErrorNotice } from "./code-server-error-notice"

const E = "projectEditor.proIde.errors"

it("explains a coded failure and its next step, without the host's raw text", () => {
  render(
    <CodeServerErrorNotice
      error="CODESERVER_HEALTH_TIMEOUT: port 4 did not answer within 30s"
      onRetry={jest.fn()}
      data-testid="notice"
    />
  )
  expect(screen.getByText("projectEditor.proIde.errorTitle")).toBeInTheDocument()
  expect(screen.getByText(`${E}.healthTimeout.message`)).toBeInTheDocument()
  expect(screen.getByText(`${E}.healthTimeout.hint`)).toBeInTheDocument()
  expect(screen.queryByText(/port 4/)).toBeNull()
  expect(screen.getByTestId("notice")).toHaveAttribute(
    "data-error-code",
    "CODESERVER_HEALTH_TIMEOUT"
  )
})

it("shows the raw text only for a failure nobody classified", () => {
  render(<CodeServerErrorNotice error={new Error("socket hang up")} onRetry={jest.fn()} />)
  expect(screen.getByText(`${E}.unknown.message`)).toBeInTheDocument()
  expect(screen.getByTestId("code-server-error-detail")).toHaveTextContent("socket hang up")
})

it("shows just the title and retry when the instance simply stopped", () => {
  render(<CodeServerErrorNotice error={null} onRetry={jest.fn()} data-testid="notice" />)
  expect(screen.getByText("projectEditor.proIde.errorTitle")).toBeInTheDocument()
  expect(screen.queryByText(new RegExp(`${E}\\.`))).toBeNull()
  expect(screen.getByTestId("notice")).not.toHaveAttribute("data-error-code")
})

it("retries", () => {
  const onRetry = jest.fn()
  render(<CodeServerErrorNotice error="CODESERVER_NOT_RUNNING" onRetry={onRetry} />)
  fireEvent.click(screen.getByRole("button", { name: /projectEditor.proIde.retry/ }))
  expect(onRetry).toHaveBeenCalledTimes(1)
})
