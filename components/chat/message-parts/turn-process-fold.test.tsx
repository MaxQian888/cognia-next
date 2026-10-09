/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { TurnProcessFold } from "./turn-process-fold"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  ReadingCollapse: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
}))

const fold = { toolCount: 3, failedCount: 0, reasoningCount: 1 }

describe("TurnProcessFold", () => {
  it("starts closed with the sealed duration and mounts nothing of the body", () => {
    render(
      <TurnProcessFold fold={fold} durationMs={788_000}>
        <p>process body</p>
      </TurnProcessFold>
    )
    expect(screen.getByTestId("turn-process-fold-label")).toHaveTextContent(
      'workedFor:{"duration":"13m 8s"}'
    )
    expect(screen.getByTestId("turn-process-fold-toggle")).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("process body")).toBeNull()
  })

  it("opens and closes the body on click", () => {
    render(
      <TurnProcessFold fold={fold} durationMs={5_000}>
        <p>process body</p>
      </TurnProcessFold>
    )
    const toggle = screen.getByTestId("turn-process-fold-toggle")
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("process body")).toBeInTheDocument()
    expect(toggle.getAttribute("aria-label")).toContain("collapse")
    fireEvent.click(toggle)
    expect(screen.queryByText("process body")).toBeNull()
  })

  it("falls back to a step count when the turn has no recorded duration", () => {
    render(
      <TurnProcessFold fold={fold}>
        <p>body</p>
      </TurnProcessFold>
    )
    expect(screen.getByTestId("turn-process-fold-label")).toHaveTextContent('worked:{"count":4}')
  })

  it("shows failed tool calls on the closed row", () => {
    render(
      <TurnProcessFold fold={{ ...fold, failedCount: 2 }} durationMs={1_000}>
        <p>body</p>
      </TurnProcessFold>
    )
    expect(screen.getByTestId("turn-process-fold-failed")).toHaveTextContent('failed:{"count":2}')
  })
})
