/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
jest.mock("@/hooks/plugins/use-cogsets", () => ({
  useCogsetDisplayName: () => (c: { name: string }) => c.name,
  useInstalledPluginSummaries: () => ({ plugins: [], byId: new Map(), loading: false }),
}))
const request = jest.fn()
jest.mock("@/components/plugins/cogsets/use-cogset-switch", () => ({
  useCogsetSwitch: () => ({ request, retry: jest.fn(), element: null }),
}))
const getCogset = jest.fn(async (id: string) => ({ id, name: "Imported" }))
jest.mock("@/lib/db/plugin-cogsets", () => ({ getCogset: (id: string) => getCogset(id) }))
let dialogProps:
  { file: { name: string; bytes: Uint8Array } | null; onSwitch: (id: string) => void } | undefined
jest.mock("./cogpack-import-dialog", () => ({
  CogpackImportDialog: (props: typeof dialogProps) => {
    dialogProps = props
    return null
  },
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { useEffect } from "react"
import { act, render, waitFor } from "@testing-library/react"

import { useCogpackImport, type CogpackImportController } from "./use-cogpack-import"

const holder: { current?: CogpackImportController } = {}
function Harness() {
  const controller = useCogpackImport()
  useEffect(() => {
    holder.current = controller
  })
  return <>{controller.element}</>
}

describe("useCogpackImport", () => {
  it("picks a .cogpack, opens the review with its bytes, and switches to the result", async () => {
    const inputs: HTMLInputElement[] = []
    const create = document.createElement.bind(document)
    const spy = jest.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = create(tag)
      if (tag === "input") {
        inputs.push(element as HTMLInputElement)
        ;(element as HTMLInputElement).click = () => {}
      }
      return element
    })
    render(<Harness />)
    act(() => holder.current!.pick())
    spy.mockRestore()
    const input = inputs[0]
    expect(input.accept).toBe(".cogpack,application/vnd.cognia.cogpack+zip,application/zip")
    const chosen = {
      name: "writer.cogpack",
      arrayBuffer: async () => new Uint8Array([7, 8]).buffer,
    }
    Object.defineProperty(input, "files", { value: [chosen] })
    await act(async () => {
      input.onchange?.(new Event("change"))
    })
    await waitFor(() => expect(dialogProps?.file?.name).toBe("writer.cogpack"))
    expect([...dialogProps!.file!.bytes]).toEqual([7, 8])

    act(() => dialogProps!.onSwitch("c1"))
    await waitFor(() => expect(request).toHaveBeenCalledWith({ id: "c1", name: "Imported" }))
  })
})
