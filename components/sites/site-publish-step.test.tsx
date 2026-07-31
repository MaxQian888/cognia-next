import { render, screen } from "@testing-library/react"

import { SitePublishStep } from "./site-publish-step"

function renderStep(props: Partial<React.ComponentProps<typeof SitePublishStep>> = {}) {
  return render(
    <SitePublishStep index={3} title="Build" state="idle" stateLabel="idle" {...props} />
  )
}

it("shows the 1-based index while idle", () => {
  renderStep({ state: "idle", stateLabel: "Not started" })
  expect(screen.getByText("3")).toBeInTheDocument()
  expect(screen.getByRole("img", { name: "Not started" })).toBeInTheDocument()
})

it("labels the status indicator for each state", () => {
  const { rerender } = renderStep({ state: "done", stateLabel: "Done" })
  expect(screen.getByRole("img", { name: "Done" })).toBeInTheDocument()

  rerender(<SitePublishStep index={3} title="Build" state="failed" stateLabel="Failed" />)
  expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument()

  rerender(<SitePublishStep index={3} title="Build" state="running" stateLabel="Running" />)
  expect(screen.getByRole("img", { name: "Running" })).toBeInTheDocument()
})

it("renders the live sub-status only while running", () => {
  const { rerender } = renderStep({
    state: "running",
    stateLabel: "Running",
    subStatus: "bundling assets",
  })
  expect(screen.getByRole("status")).toHaveTextContent("bundling assets")

  rerender(
    <SitePublishStep
      index={3}
      title="Build"
      state="done"
      stateLabel="Done"
      subStatus="bundling assets"
    />
  )
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
})

it("renders the description and action children", () => {
  renderStep({
    description: "Confined build then deploy",
    children: <button type="button">Build now</button>,
  })
  expect(screen.getByText("Confined build then deploy")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Build now" })).toBeInTheDocument()
})

it("exposes the state on the row for styling and assertions", () => {
  const { container } = renderStep({ state: "running", stateLabel: "Running" })
  expect(container.querySelector('[data-state="running"]')).not.toBeNull()
})
