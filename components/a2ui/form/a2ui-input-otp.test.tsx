import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIInputOTP, type A2UIInputOTPComponent } from "./a2ui-input-otp"
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

describe("A2UIInputOTP", () => {
  const cp = (c: A2UIInputOTPComponent): A2UIComponentProps<A2UIInputOTPComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  })

  it("renders correct number of slots", () => {
    const { container } = render(
      <A2UIInputOTP {...cp({ id: "o1", component: "InputOTP", value: "", maxLength: 4 })} />
    )
    expect(container.querySelectorAll('[data-slot="input-otp-slot"]').length).toBe(4)
  })

  it("renders default 6 slots", () => {
    const { container } = render(
      <A2UIInputOTP {...cp({ id: "o2", component: "InputOTP", value: "" })} />
    )
    expect(container.querySelectorAll('[data-slot="input-otp-slot"]').length).toBe(6)
  })

  it("renders with label", () => {
    render(
      <A2UIInputOTP
        {...cp({ id: "o3", component: "InputOTP", value: "", label: "Verification code" })}
      />
    )
    expect(screen.getByText("Verification code")).toBeInTheDocument()
  })
})
