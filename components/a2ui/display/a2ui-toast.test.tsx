import React from "react"
import { render } from "@testing-library/react"
import { toast } from "sonner"
import { A2UIToast, type A2UIToastComponent } from "./a2ui-toast"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

jest.mock("sonner", () => {
  const m = Object.assign(jest.fn(), {
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
    loading: jest.fn(),
  })
  return { toast: m }
})

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

describe("A2UIToast", () => {
  const cp = (c: A2UIToastComponent): A2UIComponentProps<A2UIToastComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  })

  beforeEach(() => {
    const t = toast as unknown as jest.Mock & {
      success: jest.Mock
      error: jest.Mock
      warning: jest.Mock
      info: jest.Mock
      loading: jest.Mock
    }
    t.mockClear()
    t.success.mockClear()
    t.error.mockClear()
    t.warning.mockClear()
    t.info.mockClear()
    t.loading.mockClear()
  })

  it("calls sonner toast with message", () => {
    render(<A2UIToast {...cp({ id: "t1", component: "Toast", message: "Hello" })} />)
    expect(toast).toHaveBeenCalledWith("Hello", expect.objectContaining({ description: undefined }))
  })

  it("calls toast.success for success variant", () => {
    render(
      <A2UIToast {...cp({ id: "t2", component: "Toast", message: "Done", variant: "success" })} />
    )
    expect((toast as unknown as { success: jest.Mock }).success).toHaveBeenCalledWith(
      "Done",
      expect.any(Object)
    )
  })

  it("calls toast.error with description", () => {
    render(
      <A2UIToast
        {...cp({
          id: "t3",
          component: "Toast",
          message: "Fail",
          variant: "error",
          description: "Something went wrong",
        })}
      />
    )
    expect((toast as unknown as { error: jest.Mock }).error).toHaveBeenCalledWith(
      "Fail",
      expect.objectContaining({ description: "Something went wrong" })
    )
  })
})
