/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

import { TooltipProvider } from "@/components/ui/tooltip"
import { SingleExportTrigger } from "./single-export-trigger"

const session = { id: "session-1", title: "Example" } as ChatSession

describe("SingleExportTrigger", () => {
  it("renders no action without a session", () => {
    const { container } = render(
      <TooltipProvider>
        <SingleExportTrigger session={null} />
      </TooltipProvider>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it.each(["icon", "labeled"] as const)(
    "uses the animated download primitive for the %s action",
    (variant) => {
      const { container } = render(
        <TooltipProvider>
          <SingleExportTrigger session={session} variant={variant} />
        </TooltipProvider>
      )
      expect(container.querySelector('[data-slot="animated-action-icon"]')).toBeInTheDocument()
    }
  )

  it.each(["icon", "labeled"] as const)("forwards className to the %s trigger", (variant) => {
    render(
      <TooltipProvider>
        <SingleExportTrigger session={session} variant={variant} className="w-full" />
      </TooltipProvider>
    )
    expect(screen.getByRole("button")).toHaveClass("w-full")
  })
})
