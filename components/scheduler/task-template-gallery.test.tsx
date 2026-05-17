/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

// Mock the templates to a small deterministic set.
jest.mock("@/lib/scheduler/task-templates", () => ({
  TASK_TEMPLATES: [
    {
      id: "tmpl-1",
      name: "Backup",
      nameZh: "备份",
      description: "Daily backup",
      descriptionZh: "每日备份",
      icon: "💾",
      category: "data",
      taskType: "backup",
      triggerType: "cron",
      getInput: () => ({ name: "Backup task" }),
    },
    {
      id: "tmpl-2",
      name: "Notify",
      nameZh: "通知",
      description: "Send hello",
      descriptionZh: "发送你好",
      icon: "🔔",
      category: "communication",
      taskType: "chat",
      triggerType: "interval",
      getInput: () => ({ name: "Hello task" }),
    },
  ],
  TEMPLATE_CATEGORIES: [
    { id: "data", name: "Data", nameZh: "数据" },
    { id: "communication", name: "Communication", nameZh: "通讯" },
  ],
}))

// Stub Dialog + Tabs + ScrollArea to render inline.
jest.mock("@/components/ui/dialog")

jest.mock("@/components/ui/tabs", () => ({
  Tabs: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => (
    <div data-testid="tabs-stub" data-value={value} data-on-change={!!onValueChange}>
      {children}
      <button type="button" data-testid="tabs-set-data" onClick={() => onValueChange("data")}>
        set-data
      </button>
      <button type="button" data-testid="tabs-set-all" onClick={() => onValueChange("all")}>
        set-all
      </button>
    </div>
  ),
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <button type="button" data-tab-value={value}>
      {children}
    </button>
  ),
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/components/ui/scroll-area")

import { TaskTemplateGallery } from "./task-template-gallery"

describe("TaskTemplateGallery", () => {
  it("returns null when not open", () => {
    const { container } = render(
      <TaskTemplateGallery open={false} onOpenChange={jest.fn()} onSelect={jest.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders all templates by default", () => {
    render(<TaskTemplateGallery open={true} onOpenChange={jest.fn()} onSelect={jest.fn()} />)
    expect(screen.getByText("Backup")).toBeInTheDocument()
    expect(screen.getByText("Notify")).toBeInTheDocument()
  })

  it("filters templates by category", () => {
    render(<TaskTemplateGallery open={true} onOpenChange={jest.fn()} onSelect={jest.fn()} />)
    fireEvent.click(screen.getByTestId("tabs-set-data"))
    expect(screen.getByText("Backup")).toBeInTheDocument()
    expect(screen.queryByText("Notify")).toBeNull()
  })

  it("returns to all templates when 'all' is selected again", () => {
    render(<TaskTemplateGallery open={true} onOpenChange={jest.fn()} onSelect={jest.fn()} />)
    fireEvent.click(screen.getByTestId("tabs-set-data"))
    expect(screen.queryByText("Notify")).toBeNull()
    fireEvent.click(screen.getByTestId("tabs-set-all"))
    expect(screen.getByText("Notify")).toBeInTheDocument()
  })

  it("dispatches onSelect with the template input and closes the dialog", () => {
    const onSelect = jest.fn()
    const onOpenChange = jest.fn()
    render(<TaskTemplateGallery open={true} onOpenChange={onOpenChange} onSelect={onSelect} />)
    const useTemplateButtons = screen.getAllByText("templateGallery.useTemplate")
    fireEvent.click(useTemplateButtons[0]!)
    expect(onSelect).toHaveBeenCalledWith({ name: "Backup task" })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("renders a custom trigger when provided", () => {
    render(
      <TaskTemplateGallery
        open={true}
        onOpenChange={jest.fn()}
        onSelect={jest.fn()}
        trigger={<button data-testid="custom-trigger">Open</button>}
      />
    )
    expect(screen.getByTestId("custom-trigger")).toBeInTheDocument()
  })
})
