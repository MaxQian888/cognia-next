/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))
jest.mock("@/components/connectivity/pair/add-host-form", () => ({
  AddHostForm: (props: { initialBaseUrl?: string }) => (
    <div data-testid="add-host-form" data-seeded={props.initialBaseUrl ?? ""} />
  ),
}))

import { AddHostSheet } from "./add-host-sheet"

it("mounts the shared pairing form and passes the seeded URL through", () => {
  render(<AddHostSheet open onOpenChange={() => {}} initialBaseUrl="https://box.example:27890" />)
  expect(screen.getByTestId("add-host-form")).toHaveAttribute(
    "data-seeded",
    "https://box.example:27890"
  )
})

it("renders nothing while closed", () => {
  render(<AddHostSheet open={false} onOpenChange={() => {}} />)
  expect(screen.queryByTestId("add-host-form")).toBeNull()
})
