/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import { CreatePlacementProvider, useCreatePlacementSlot } from "./create-placement-slot"

function Probe() {
  const slot = useCreatePlacementSlot()
  return <div data-testid="probe">{slot ?? "none"}</div>
}

it("hands the provided choice to the form inside", () => {
  render(
    <CreatePlacementProvider slot={<span>runs on</span>}>
      <Probe />
    </CreatePlacementProvider>
  )
  expect(screen.getByTestId("probe")).toHaveTextContent("runs on")
})

it("is nothing outside a create dialog", () => {
  render(<Probe />)
  expect(screen.getByTestId("probe")).toHaveTextContent("none")
})
