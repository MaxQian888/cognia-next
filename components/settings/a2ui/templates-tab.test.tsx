import React from "react"
import { render, screen, waitFor } from "@testing-library/react"
import { TemplatesTab } from "./templates-tab"

const getLocalizedTemplates = jest.fn((_locale: string) => [
  {
    id: "todo-list",
    name: "Todo List",
    description: "A localized template",
    category: "productivity",
    icon: "CheckSquare",
    tags: [],
    components: [],
    dataModel: {},
  },
])
const listTemplates = jest.fn(async () => [])

jest.mock("@/lib/a2ui/templates", () => ({
  getLocalizedTemplates: (locale: string) => getLocalizedTemplates(locale),
}))
jest.mock("@/lib/db/a2ui-templates", () => ({
  listTemplates: () => listTemplates(),
  upsertTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

describe("TemplatesTab", () => {
  it("renders the built-in catalog through the active locale projection", async () => {
    render(<TemplatesTab />)

    expect(screen.getByText("Todo List")).toBeInTheDocument()
    expect(screen.getByText("A localized template")).toBeInTheDocument()
    expect(getLocalizedTemplates).toHaveBeenCalledWith("en")
    await waitFor(() => expect(listTemplates).toHaveBeenCalled())
  })
})
