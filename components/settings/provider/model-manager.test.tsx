/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { ModelManager } from "./model-manager"

jest.mock("./local-provider-settings", () => ({
  LocalProviderSettings: ({ providerId }: { providerId: string }) => (
    <div data-testid="local-provider-settings" data-provider-id={providerId} />
  ),
}))

describe("ModelManager", () => {
  it("uses the complete shared local-provider management surface", () => {
    render(<ModelManager />)
    expect(screen.getByTestId("local-provider-settings")).toHaveAttribute(
      "data-provider-id",
      "ollama"
    )
  })
})
