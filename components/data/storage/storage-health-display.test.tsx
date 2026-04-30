import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { StorageHealthDisplay } from "./storage-health-display"
import type { StorageHealth } from "@/lib/storage"

const messages = {
  settings: {
    data: {
      health: {
        healthy: "Healthy",
        warning: "Warning",
        critical: "Critical",
        used: "used",
        issues: "Issues",
        recommendations: "Recommendations",
        allGood: "All good.",
        potentialSavings: "Potential savings",
      },
    },
  },
}

function renderHealth(health: StorageHealth | null, onAction?: (a: string) => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StorageHealthDisplay
        health={health}
        formatBytes={(n) => `${n} B`}
        onActionClick={onAction}
      />
    </NextIntlClientProvider>
  )
}

describe("StorageHealthDisplay", () => {
  it("returns null when health is null", () => {
    const { container } = renderHealth(null)
    expect(container.firstChild).toBeNull()
  })

  it("renders the healthy badge + 'all good' message", () => {
    renderHealth({
      status: "healthy",
      usagePercent: 12.345,
      issues: [],
      recommendations: [],
    })
    expect(screen.getByText("Healthy")).toBeInTheDocument()
    expect(screen.getByText("All good.")).toBeInTheDocument()
    expect(screen.getByText("12.3% used")).toBeInTheDocument()
  })

  it("renders issue + recommendation items", () => {
    renderHealth({
      status: "warning",
      usagePercent: 80,
      issues: [
        { severity: "medium", message: "Storage filling up", suggestedAction: "Run cleanup" },
      ],
      recommendations: [
        { action: "Clear chats", description: "Lots of messages", estimatedSavings: 1024 },
      ],
    })
    expect(screen.getByText("Storage filling up")).toBeInTheDocument()
    expect(screen.getByText("Run cleanup")).toBeInTheDocument()
    expect(screen.getByText("Clear chats")).toBeInTheDocument()
    expect(screen.getByText(/Potential savings/i)).toBeInTheDocument()
  })

  it("invokes onActionClick when the recommendation chevron is pressed", () => {
    const onAction = jest.fn()
    renderHealth(
      {
        status: "critical",
        usagePercent: 95,
        issues: [],
        recommendations: [
          { action: "Clear something", description: "Reason", estimatedSavings: 0 },
        ],
      },
      onAction
    )
    const buttons = screen.getAllByRole("button")
    fireEvent.click(buttons[0])
    expect(onAction).toHaveBeenCalledWith("Clear something")
  })
})
