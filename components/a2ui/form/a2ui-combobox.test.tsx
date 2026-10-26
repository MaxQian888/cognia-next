import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { A2UICombobox, type A2UIComboboxComponent } from "./a2ui-combobox"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

jest.mock("../a2ui-context", () => ({
  useA2UIContext: () => ({
    surfaceId: "test",
    dataModel: {},
    catalog: undefined,
    emitAction: jest.fn(),
    setDataValue: jest.fn(),
    renderChild: jest.fn(),
  }),
  useA2UIData: () => ({
    resolveString: (v: unknown) => (typeof v === "string" ? v : ""),
    resolveNumber: (v: unknown) => (typeof v === "number" ? v : 0),
    resolveBoolean: (v: unknown) => (typeof v === "boolean" ? v : false),
    resolveArray: <T,>(v: unknown, d: T[] = []) => (Array.isArray(v) ? v : d),
  }),
}))

jest.mock("@/lib/a2ui/data-model", () => ({
  getBindingPath: (v: unknown) => {
    if (typeof v === "object" && v !== null && "path" in v) return (v as { path: string }).path
    return undefined
  },
}))

describe("A2UICombobox", () => {
  const cp = (c: A2UIComboboxComponent): A2UIComponentProps<A2UIComboboxComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  })

  it("keeps options closed until opened and filters by their labels", async () => {
    const props = cp({
      id: "search",
      component: "Combobox",
      options: [
        { value: "us", label: "United States" },
        { value: "cn", label: "China" },
      ],
      value: { path: "/country" },
      label: "Country",
      searchPlaceholder: "Find country",
    })
    render(<A2UICombobox {...props} />)
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("combobox", { name: "Country" }))
    const input = await screen.findByPlaceholderText("Find country")
    fireEvent.change(input, { target: { value: "China" } })
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: "United States" })).not.toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole("option", { name: "China" }))
    expect(props.onDataChange).toHaveBeenCalledWith("/country", "cn")
  })

  it("disables the trigger and prevents opening", () => {
    render(
      <A2UICombobox
        {...cp({
          id: "disabled",
          component: "Combobox",
          options: [{ value: "x", label: "Option" }],
          value: "",
          disabled: true,
          label: "Locked",
        })}
      />
    )
    expect(screen.getByRole("combobox", { name: "Locked" })).toBeDisabled()
  })

  it("renders with placeholder", () => {
    render(
      <A2UICombobox
        {...cp({
          id: "cb1",
          component: "Combobox",
          options: [],
          value: "",
          placeholder: "Choose...",
        })}
      />
    )
    expect(screen.getByText("Choose...")).toBeInTheDocument()
  })

  it("renders with label", () => {
    render(
      <A2UICombobox
        {...cp({ id: "cb2", component: "Combobox", options: [], value: "", label: "Country" })}
      />
    )
    expect(screen.getByText("Country")).toBeInTheDocument()
  })

  it("renders selected value label", () => {
    render(
      <A2UICombobox
        {...cp({
          id: "cb3",
          component: "Combobox",
          options: [{ value: "us", label: "United States" }],
          value: "us",
        })}
      />
    )
    expect(screen.getAllByText("United States").length).toBeGreaterThanOrEqual(1)
  })
})
