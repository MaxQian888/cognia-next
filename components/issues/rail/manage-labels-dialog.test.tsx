/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

let editorProps: Record<string, unknown> = {}
jest.mock("@/components/labels/label-catalogue-editor", () => ({
  LabelCatalogueEditor: (props: Record<string, unknown>) => {
    editorProps = props
    return <div data-testid="editor-stub" />
  },
}))

import { render, screen } from "@testing-library/react"
import type { LabelRow } from "@/types/labels"
import { ManageLabelsDialog } from "./manage-labels-dialog"

const label: LabelRow = {
  id: "l1",
  scope: "issue",
  name: "bug",
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => {
  editorProps = {}
})

describe("ManageLabelsDialog", () => {
  it("renders nothing while shut", () => {
    render(<ManageLabelsDialog open={false} onOpenChange={jest.fn()} labels={[label]} />)
    expect(screen.queryByTestId("manage-labels-dialog")).not.toBeInTheDocument()
  })

  it("hosts the shared editor rather than a second implementation", () => {
    render(<ManageLabelsDialog open onOpenChange={jest.fn()} labels={[label]} />)
    expect(screen.getByTestId("editor-stub")).toBeInTheDocument()
  })

  it("scopes the editor to issue labels", () => {
    render(<ManageLabelsDialog open onOpenChange={jest.fn()} labels={[label]} />)
    expect(editorProps.scope).toBe("issue")
    expect(editorProps.labels).toEqual([label])
  })

  it("uses the palette, because issue labels are oklch tokens not free hex", () => {
    render(<ManageLabelsDialog open onOpenChange={jest.fn()} labels={[]} />)
    expect(editorProps.colorMode).toBe("palette")
  })

  it("passes localized strings, keeping the editor free of any one namespace", () => {
    render(<ManageLabelsDialog open onOpenChange={jest.fn()} labels={[]} />)
    const strings = editorProps.strings as Record<string, unknown>
    expect(strings.title).toBe("manageTitle")
    expect((strings.deleteAria as (n: string) => string)("bug")).toBe("deleteAria:bug")
  })
})
