import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TemplateScopeControl, templateScopeBlocker } from "./template-scope-control"

describe("templateScopeBlocker", () => {
  it("lets a user move only what their own library owns", () => {
    expect(templateScopeBlocker("mine", "ws_1")).toBeUndefined()
    expect(templateScopeBlocker("workspace", "ws_1")).toBeUndefined()
    // Overlay rows are not stored locally, so `putLocal` would change nothing.
    expect(templateScopeBlocker("builtin", "ws_1")).toBe("sharedSource")
    expect(templateScopeBlocker("plugin", "ws_1")).toBe("sharedSource")
    expect(templateScopeBlocker("marketplace", "ws_1")).toBe("sharedSource")
  })

  it("separates 'not yet' from 'never'", () => {
    // No workspace is the store still hydrating, which is a different answer
    // from a template that can never be confined.
    expect(templateScopeBlocker("mine", null)).toBe("noWorkspace")
    expect(templateScopeBlocker("mine", undefined)).toBe("noWorkspace")
  })
})

describe("<TemplateScopeControl />", () => {
  /**
   * The gap this closes: `TemplateService.setDefinitionWorkspace` shipped with
   * no production caller, so a template could be confined to a workspace only
   * at the instant it was forked and never shared again.
   */
  it("confines a shared template to the active workspace", () => {
    const onChange = jest.fn()
    render(<TemplateScopeControl tier="mine" activeWorkspaceId="ws_1" onChange={onChange} />)

    expect(screen.getByTestId("template-scope-reason")).toHaveTextContent("explain.shared")
    fireEvent.click(screen.getByTestId("template-scope-workspace"))
    expect(onChange).toHaveBeenCalledWith("ws_1")
  })

  it("shares a confined template again with null", () => {
    const onChange = jest.fn()
    render(
      <TemplateScopeControl
        tier="workspace"
        ownerWorkspaceId="ws_1"
        activeWorkspaceId="ws_1"
        onChange={onChange}
      />
    )

    expect(screen.getByTestId("template-scope-reason")).toHaveTextContent("explain.workspace")
    fireEvent.click(screen.getByTestId("template-scope-shared"))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it("reports no change when the current answer is clicked again", () => {
    const onChange = jest.fn()
    render(<TemplateScopeControl tier="mine" activeWorkspaceId="ws_1" onChange={onChange} />)

    fireEvent.click(screen.getByTestId("template-scope-shared"))
    expect(onChange).not.toHaveBeenCalled()
  })

  /**
   * Rendered and disabled with the reason rather than hidden. A control that is
   * simply absent merges "shared by construction" with "yours to decide".
   */
  it("says why a built-in cannot be confined instead of hiding the control", () => {
    const onChange = jest.fn()
    render(<TemplateScopeControl tier="builtin" activeWorkspaceId="ws_1" onChange={onChange} />)

    expect(screen.getByTestId("template-scope-control")).toHaveAttribute(
      "data-blocked",
      "sharedSource"
    )
    expect(screen.getByTestId("template-scope-reason")).toHaveTextContent("blocked.sharedSource")
    fireEvent.click(screen.getByTestId("template-scope-workspace"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("waits for a workspace rather than offering a confinement with no target", () => {
    const onChange = jest.fn()
    render(<TemplateScopeControl tier="mine" activeWorkspaceId={null} onChange={onChange} />)

    expect(screen.getByTestId("template-scope-reason")).toHaveTextContent("blocked.noWorkspace")
    fireEvent.click(screen.getByTestId("template-scope-workspace"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("stops taking taps while a write is in flight", () => {
    const onChange = jest.fn()
    render(<TemplateScopeControl tier="mine" activeWorkspaceId="ws_1" busy onChange={onChange} />)

    fireEvent.click(screen.getByTestId("template-scope-workspace"))
    expect(onChange).not.toHaveBeenCalled()
  })
})
