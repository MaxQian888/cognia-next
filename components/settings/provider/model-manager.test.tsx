/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { ModelManager } from "./model-manager"

jest.mock("./local-provider-settings", () => ({
  LocalProviderSettings: () => <div data-testid="local-provider-settings" />,
}))

describe("ModelManager", () => {
  it("uses the complete shared local-provider management surface", () => {
    render(<ModelManager />)
    expect(screen.getByTestId("local-provider-settings")).toBeInTheDocument()
  })
})
