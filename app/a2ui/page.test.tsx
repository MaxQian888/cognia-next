import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

const replace = jest.fn()
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace, push: jest.fn() }),
}))

const appBuilder = {
  createCustomApp: jest.fn(),
  createFromTemplate: jest.fn(),
  deleteApp: jest.fn(async () => true),
  downloadApp: jest.fn(() => true),
  duplicateApp: jest.fn(),
  exportAllApps: jest.fn(() => "{}"),
  exportApp: jest.fn(() => "{}"),
  getAllApps: jest.fn(() => []),
  getTemplate: jest.fn(() => undefined),
  getTemplatesByCategory: jest.fn(() => []),
  hydratePersistedApps: jest.fn(async () => undefined),
  importAppFromFile: jest.fn(),
  searchTemplates: jest.fn(() => []),
  templates: [],
}

jest.mock("@/hooks/a2ui/use-app-builder", () => ({
  useA2UIAppBuilder: () => appBuilder,
}))
jest.mock("@/components/a2ui/a2ui-surface", () => ({
  A2UIInlineSurface: () => <div data-testid="surface" />,
}))
jest.mock("@/components/a2ui/app-detail-dialog", () => ({ AppDetailDialog: () => null }))
jest.mock("@/components/a2ui/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: () => null,
}))
jest.mock("@/components/a2ui/quick-app-builder/template-card", () => ({
  TemplateCard: ({ template }: { template: { name: string } }) => <div>{template.name}</div>,
}))
jest.mock("@/components/a2ui/workspace/a2ui-workspace", () => ({
  A2UIWorkspace: () => <div data-testid="workspace" />,
}))

import A2UIPage from "./page"

describe("A2UIPage", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders localized quick prompts and uses the selected prompt as generation input", () => {
    render(<A2UIPage />)
    fireEvent.click(screen.getByRole("button", { name: "Pomodoro Timer" }))
    expect(screen.getByPlaceholderText("e.g. Make a pomodoro timer...")).toHaveValue(
      "Pomodoro Timer"
    )
  })

  it("keeps the quick prompt keys complete in both locale catalogs", () => {
    expect(enMessages.a2ui.quickPromptPomodoro).toBe("Pomodoro Timer")
    expect(enMessages.a2ui.quickPromptConverter).toBe("Unit Converter")
    expect(zhMessages.a2ui.quickPromptPomodoro).toBe("番茄钟")
    expect(zhMessages.a2ui.quickPromptConverter).toBe("单位换算器")
  })
})
