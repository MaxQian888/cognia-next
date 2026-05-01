/**
 * A2UI Accordion Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UIAccordion } from "./a2ui-accordion"
import type { A2UIAccordionComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock useA2UIKeyboard hook
const mockUseA2UIKeyboard = jest.fn()
jest.mock("@/hooks/a2ui/use-a2ui-keyboard", () => ({
  useA2UIKeyboard: (opts: unknown) => mockUseA2UIKeyboard(opts),
}))

// Mock A2UIChildRenderer
jest.mock("../a2ui-renderer", () => ({
  A2UIChildRenderer: ({ childIds }: { childIds: string[] }) => (
    <div data-testid="child-renderer">{childIds.join(",")}</div>
  ),
}))

describe("A2UIAccordion", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (
    component: A2UIAccordionComponent
  ): A2UIComponentProps<A2UIAccordionComponent> => ({
    component,
    surfaceId: "test-surface",
    dataModel: {},
    onAction: mockOnAction,
    onDataChange: mockOnDataChange,
    renderChild: mockRenderChild,
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should render accordion items with titles", () => {
    const component: A2UIAccordionComponent = {
      id: "accordion-1",
      component: "Accordion",
      items: [
        { id: "item1", title: "Section One", children: ["child-1"] },
        { id: "item2", title: "Section Two", children: ["child-2"] },
      ],
    }

    render(<A2UIAccordion {...createProps(component)} />)
    expect(screen.getByText("Section One")).toBeInTheDocument()
    expect(screen.getByText("Section Two")).toBeInTheDocument()
  })

  it("should render in single mode by default (collapsible)", () => {
    const component: A2UIAccordionComponent = {
      id: "accordion-2",
      component: "Accordion",
      items: [
        { id: "item1", title: "First", children: ["child-1"] },
        { id: "item2", title: "Second", children: ["child-2"] },
      ],
    }

    const { container } = render(<A2UIAccordion {...createProps(component)} />)
    // Single mode accordion should have data-orientation attribute
    const accordion = container.querySelector("[data-orientation]")
    expect(accordion).toBeInTheDocument()
  })

  it("should render in multiple mode when specified", () => {
    const component: A2UIAccordionComponent = {
      id: "accordion-3",
      component: "Accordion",
      multiple: true,
      items: [
        { id: "item1", title: "First", children: ["child-1"] },
        { id: "item2", title: "Second", children: ["child-2"] },
      ],
    }

    const { container } = render(<A2UIAccordion {...createProps(component)} />)
    const accordion = container.querySelector("[data-orientation]")
    expect(accordion).toBeInTheDocument()
  })

  it("should open items with defaultOpen set", () => {
    const component: A2UIAccordionComponent = {
      id: "accordion-4",
      component: "Accordion",
      items: [
        { id: "item1", title: "Closed", children: ["child-1"] },
        { id: "item2", title: "Open by Default", children: ["child-2"], defaultOpen: true },
      ],
    }

    render(<A2UIAccordion {...createProps(component)} />)
    expect(screen.getByText("Open by Default")).toBeInTheDocument()
    expect(screen.getByText("Closed")).toBeInTheDocument()
  })

  it("should apply custom className", () => {
    const component: A2UIAccordionComponent = {
      id: "accordion-5",
      component: "Accordion",
      className: "custom-class",
      items: [{ id: "item1", title: "Item", children: ["child-1"] }],
    }

    const { container } = render(<A2UIAccordion {...createProps(component)} />)
    const accordion = container.querySelector(".custom-class")
    expect(accordion).toBeInTheDocument()
  })

  describe("keyboard navigation", () => {
    it("should call useA2UIKeyboard with handlers", () => {
      const component: A2UIAccordionComponent = {
        id: "accordion-kb",
        component: "Accordion",
        items: [
          { id: "item1", title: "First", children: ["child-1"] },
          { id: "item2", title: "Second", children: ["child-2"] },
        ],
      }

      render(<A2UIAccordion {...createProps(component)} />)

      expect(mockUseA2UIKeyboard).toHaveBeenCalledWith(
        expect.objectContaining({
          onArrowUp: expect.any(Function),
          onArrowDown: expect.any(Function),
          onEnter: expect.any(Function),
          enabled: expect.any(Boolean),
        })
      )
    })

    it("should enable keyboard when container is focused", () => {
      const component: A2UIAccordionComponent = {
        id: "accordion-focus",
        component: "Accordion",
        items: [{ id: "item1", title: "Focus Item", children: ["child-1"] }],
      }

      const { container } = render(<A2UIAccordion {...createProps(component)} />)
      const wrapper = container.firstChild as HTMLElement

      // Initially not focused
      const initialCall =
        mockUseA2UIKeyboard.mock.calls[mockUseA2UIKeyboard.mock.calls.length - 1][0]
      expect(initialCall.enabled).toBe(false)

      // Focus the container
      fireEvent.focus(wrapper)

      // After focus, useA2UIKeyboard should be called with enabled: true
      const focusedCall =
        mockUseA2UIKeyboard.mock.calls[mockUseA2UIKeyboard.mock.calls.length - 1][0]
      expect(focusedCall.enabled).toBe(true)
    })

    it("should disable keyboard when container is blurred", () => {
      const component: A2UIAccordionComponent = {
        id: "accordion-blur",
        component: "Accordion",
        items: [{ id: "item1", title: "Blur Item", children: ["child-1"] }],
      }

      const { container } = render(<A2UIAccordion {...createProps(component)} />)
      const wrapper = container.firstChild as HTMLElement

      fireEvent.focus(wrapper)
      fireEvent.blur(wrapper)

      const blurCall = mockUseA2UIKeyboard.mock.calls[mockUseA2UIKeyboard.mock.calls.length - 1][0]
      expect(blurCall.enabled).toBe(false)
    })
  })
})
