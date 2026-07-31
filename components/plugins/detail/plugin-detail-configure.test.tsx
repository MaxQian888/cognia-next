/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("./plugin-config-form", () => ({
  PluginConfigFormContent: ({ pluginId }: { pluginId: string }) => (
    <div data-testid="config-form-content" data-plugin-id={pluginId} />
  ),
}))

import { PluginDetailConfigure } from "./plugin-detail-configure"

describe("PluginDetailConfigure", () => {
  it("renders PluginConfigFormContent inline for the given pluginId", () => {
    render(<PluginDetailConfigure pluginId="alpha" />)
    const node = screen.getByTestId("config-form-content")
    expect(node.getAttribute("data-plugin-id")).toBe("alpha")
  })
})
