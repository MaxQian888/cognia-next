/** @jest-environment jsdom */
/**
 * Covers EntityEditorDialog: open/closed render, valid submit shape, empty-name
 * validation, PII gate blocking, pinned:true on add vs preserved on edit.
 */

import React from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// Stub the Select primitives as a plain <select> so userEvent.selectOptions works.
jest.mock("@/components/ui/select", () => {
  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => {
    const options: Array<{ value: string; label: React.ReactNode }> = []
    const collect = (nodes: React.ReactNode) => {
      React.Children.forEach(nodes, (child) => {
        if (!React.isValidElement(child)) return
        const typed = child as React.ReactElement<{ value?: string; children?: React.ReactNode }>
        const props = typed.props
        if (typeof props.value === "string") {
          options.push({ value: props.value, label: props.children })
          return
        }
        collect(props.children)
      })
    }
    collect(children)
    return (
      <select
        data-testid="entity-editor-role"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {typeof opt.label === "string" ? opt.label : opt.value}
          </option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
  }
})

// Control PII outcomes: default to clean; individual tests override.
const mockAssertFieldsClean = jest.fn()
jest.mock("@/lib/twin/distill/draft-pii-guard", () => {
  const { DraftPiiError } = jest.requireActual<typeof import("@/lib/twin/distill/draft-pii-guard")>(
    "@/lib/twin/distill/draft-pii-guard"
  )
  return {
    DraftPiiError,
    assertFieldsClean: (...args: unknown[]) => mockAssertFieldsClean(...args),
  }
})

import { EntityEditorDialog } from "./entity-editor-dialog"
import type { ProfileEntity } from "@/types/twin"
import { DraftPiiError } from "@/lib/twin/distill/draft-pii-guard"

function makeEntity(overrides: Partial<ProfileEntity> = {}): ProfileEntity {
  return {
    name: "Alice",
    role: "person",
    aliases: ["alicia"],
    relation: "colleague",
    firstSeenChunkId: "chunk-1",
    pinned: false,
    ...overrides,
  }
}

beforeEach(() => {
  mockAssertFieldsClean.mockReset()
  // Default: PII gate passes
  mockAssertFieldsClean.mockReturnValue(undefined)
})

describe("EntityEditorDialog — closed", () => {
  it("renders nothing when open=false", () => {
    render(
      <EntityEditorDialog open={false} onOpenChange={jest.fn()} entity={null} onSave={jest.fn()} />
    )
    expect(screen.queryByTestId("entity-editor-dialog")).toBeNull()
  })
})

describe("EntityEditorDialog — add mode", () => {
  it("renders the dialog and shows Add title when open=true and entity=null", () => {
    render(
      <EntityEditorDialog open={true} onOpenChange={jest.fn()} entity={null} onSave={jest.fn()} />
    )
    expect(screen.getByTestId("entity-editor-dialog")).toBeInTheDocument()
    // en.json: entity.titleAdd = "Add entity"
    expect(screen.getByText("Add entity")).toBeInTheDocument()
  })

  it("calls onSave with correct shape and pinned:true on a clean add", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <EntityEditorDialog open={true} onOpenChange={jest.fn()} entity={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("entity-editor-name"), "Bob")
    await userEvent.type(screen.getByTestId("entity-editor-aliases"), "robert, rob")
    await userEvent.type(screen.getByTestId("entity-editor-relation"), "ex-colleague")
    await userEvent.click(screen.getByTestId("entity-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const saved = onSave.mock.calls[0][0] as ProfileEntity
    expect(saved.name).toBe("Bob")
    expect(saved.aliases).toEqual(["robert", "rob"])
    expect(saved.relation).toBe("ex-colleague")
    expect(saved.role).toBe("person")
    expect(saved.firstSeenChunkId).toBe("manual")
    expect(saved.pinned).toBe(true)
  })

  it("surfaces inline error and blocks onSave when name is empty", async () => {
    const onSave = jest.fn()
    render(
      <EntityEditorDialog open={true} onOpenChange={jest.fn()} entity={null} onSave={onSave} />
    )
    // Name field left blank
    await userEvent.click(screen.getByTestId("entity-editor-save"))

    await waitFor(() => expect(screen.getByTestId("entity-editor-error")).toBeInTheDocument())
    expect(onSave).not.toHaveBeenCalled()
    // en.json: entity.nameRequired = "Name is required."
    expect(screen.getByTestId("entity-editor-error")).toHaveTextContent("Name is required.")
  })

  it("surfaces PII error and blocks save when assertFieldsClean throws", async () => {
    mockAssertFieldsClean.mockImplementation(() => {
      throw new DraftPiiError([{ field: "description" as "name", message: "PII found" }])
    })
    const onSave = jest.fn()
    render(
      <EntityEditorDialog open={true} onOpenChange={jest.fn()} entity={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("entity-editor-name"), "Eve")
    await userEvent.type(
      screen.getByTestId("entity-editor-relation"),
      "email me at eve@example.com"
    )
    await userEvent.click(screen.getByTestId("entity-editor-save"))

    await waitFor(() => expect(screen.getByTestId("entity-editor-error")).toBeInTheDocument())
    expect(onSave).not.toHaveBeenCalled()
    // en.json piiError: "Cannot save — content contains PII: {fields}…"
    expect(screen.getByTestId("entity-editor-error")).toHaveTextContent("description")
  })

  it("updates role via the select", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <EntityEditorDialog open={true} onOpenChange={jest.fn()} entity={null} onSave={onSave} />
    )
    await userEvent.type(screen.getByTestId("entity-editor-name"), "Backend Service")
    await userEvent.selectOptions(screen.getByTestId("entity-editor-role"), "system")
    await userEvent.click(screen.getByTestId("entity-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as ProfileEntity).role).toBe("system")
  })
})

describe("EntityEditorDialog — edit mode", () => {
  it("renders Edit title and pre-populates fields", () => {
    const entity = makeEntity({ name: "Alice", role: "team", aliases: ["ali"], pinned: false })
    render(
      <EntityEditorDialog open={true} onOpenChange={jest.fn()} entity={entity} onSave={jest.fn()} />
    )
    // en.json: entity.titleEdit = "Edit entity"
    expect(screen.getByText("Edit entity")).toBeInTheDocument()
    expect(screen.getByTestId("entity-editor-name")).toHaveValue("Alice")
    expect(screen.getByTestId("entity-editor-aliases")).toHaveValue("ali")
  })

  it("preserves pinned:false from existing entity on edit", async () => {
    const entity = makeEntity({ name: "Alice", pinned: false })
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <EntityEditorDialog open={true} onOpenChange={jest.fn()} entity={entity} onSave={onSave} />
    )
    await userEvent.click(screen.getByTestId("entity-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    // pinned should equal the original entity's pinned (false), NOT forced to true
    expect((onSave.mock.calls[0][0] as ProfileEntity).pinned).toBe(false)
  })

  it("preserves pinned:true from existing entity on edit", async () => {
    const entity = makeEntity({ name: "Alice", pinned: true })
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(
      <EntityEditorDialog open={true} onOpenChange={jest.fn()} entity={entity} onSave={onSave} />
    )
    await userEvent.click(screen.getByTestId("entity-editor-save"))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as ProfileEntity).pinned).toBe(true)
  })

  it("surfaces onSave rejection as an inline error", async () => {
    const entity = makeEntity({ name: "Alice" })
    const onSave = jest.fn().mockRejectedValue(new Error("network failure"))
    render(
      <EntityEditorDialog open={true} onOpenChange={jest.fn()} entity={entity} onSave={onSave} />
    )
    await userEvent.click(screen.getByTestId("entity-editor-save"))

    await waitFor(() =>
      expect(screen.getByTestId("entity-editor-error")).toHaveTextContent("network failure")
    )
  })
})

describe("EntityEditorDialog — busy state", () => {
  it("disables all inputs and buttons when busy=true", () => {
    render(
      <EntityEditorDialog
        open={true}
        onOpenChange={jest.fn()}
        entity={null}
        onSave={jest.fn()}
        busy={true}
      />
    )
    expect(screen.getByTestId("entity-editor-name")).toBeDisabled()
    expect(screen.getByTestId("entity-editor-save")).toBeDisabled()
  })
})
