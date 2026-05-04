import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import { StorageBreakdown } from "./storage-breakdown"
import type { StorageCategoryInfo } from "@/lib/storage"

const messages = {
  settings: {
    data: {
      breakdown: {
        viewDetails: "View details",
        clearCategory: "Clear category",
        other: "Other",
        noData: "No storage data",
      },
    },
  },
}

function renderBreakdown(props: React.ComponentProps<typeof StorageBreakdown>) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>
        <StorageBreakdown {...props} />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

const fmt = (n: number) => `${n} B`

const sample: StorageCategoryInfo[] = [
  {
    category: "session",
    displayName: "Sessions",
    itemCount: 10,
    totalSize: 200,
    sources: ["sessions"],
  },
  {
    category: "chat",
    displayName: "Messages",
    itemCount: 100,
    totalSize: 600,
    sources: ["messages"],
  },
  { category: "skill", displayName: "Skills", itemCount: 5, totalSize: 0, sources: ["skills"] },
]

describe("StorageBreakdown", () => {
  it("renders the no-data placeholder when all sizes are zero", () => {
    renderBreakdown({
      categories: [{ ...sample[0], totalSize: 0 }],
      totalSize: 0,
      formatBytes: fmt,
    })
    // Global jest mock pulls translations from `i18n/messages/en.json`.
    expect(screen.getByText("No storage data yet.")).toBeInTheDocument()
  })

  it("renders one bar segment per non-empty category", () => {
    renderBreakdown({
      categories: sample,
      totalSize: 800,
      formatBytes: fmt,
    })
    expect(screen.getByTestId("breakdown-bar-chat")).toBeInTheDocument()
    expect(screen.getByTestId("breakdown-bar-session")).toBeInTheDocument()
    expect(screen.queryByTestId("breakdown-bar-skill")).not.toBeInTheDocument()
  })

  it("invokes onClearCategory with the bucket key", () => {
    const onClear = jest.fn()
    renderBreakdown({
      categories: sample,
      totalSize: 800,
      formatBytes: fmt,
      onClearCategory: onClear,
    })
    fireEvent.click(screen.getByText("View details"))
    const clears = screen.getAllByRole("button", { name: /clear this category/i })
    fireEvent.click(clears[0])
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onClear).toHaveBeenCalledWith("chat")
  })
})
