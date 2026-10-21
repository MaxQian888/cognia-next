/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select"
import { getNativeSelect, selectOption } from "./select-option"

it("selects through the themed desktop picker and emits a native value", async () => {
  const onChange = jest.fn()
  render(
    <NativeSelect aria-label="Attempts" defaultValue="" onChange={onChange}>
      <NativeSelectOption value="">Off</NativeSelectOption>
      <NativeSelectOption value={3}>Best of 3</NativeSelectOption>
    </NativeSelect>
  )
  const control = screen.getByRole("combobox", { name: "Attempts" })
  expect(control.tagName).toBe("BUTTON")
  await selectOption(control, "3")
  expect(control).toHaveTextContent("Best of 3")
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange.mock.calls[0][0].target.value).toBe("3")
})

it("selects through a native mobile control", async () => {
  const onChange = jest.fn()
  render(
    <select aria-label="Attempts" defaultValue="" onChange={onChange}>
      <option value="">Off</option>
      <option value="3">Best of 3</option>
    </select>
  )
  await selectOption(screen.getByRole("combobox", { name: "Attempts" }), "3")
  expect(onChange.mock.calls[0][0].target.value).toBe("3")
})

it("supports editable fields when a model catalog is empty", async () => {
  render(<input aria-label="Model" defaultValue="old" />)
  const control = screen.getByRole("textbox", { name: "Model" })
  await selectOption(control, "custom-model")
  expect(control).toHaveValue("custom-model")
})

it("rejects unavailable choices instead of simulating an impossible selection", async () => {
  render(
    <NativeSelect aria-label="Attempts" defaultValue="2">
      <NativeSelectOption value="2">Best of 2</NativeSelectOption>
    </NativeSelect>
  )
  await expect(selectOption(screen.getByRole("combobox"), "9")).rejects.toThrow("does not exist")
})

it("rejects a control that has no native form mirror", () => {
  render(<button>Other</button>)
  expect(() => getNativeSelect(screen.getByRole("button"))).toThrow("no native form control")
})

it("preserves grouped and disabled options in the desktop menu", async () => {
  render(
    <NativeSelect aria-label="Model" defaultValue="a">
      <>
        <NativeSelectOptGroup label="Available">
          <NativeSelectOption value="a">Model A</NativeSelectOption>
        </NativeSelectOptGroup>
        <NativeSelectOptGroup label="Offline" disabled>
          <NativeSelectOption value="b">Model B</NativeSelectOption>
        </NativeSelectOptGroup>
      </>
    </NativeSelect>
  )
  await userEvent.click(screen.getByRole("combobox"))
  expect(screen.getByRole("group", { name: "Available" })).toBeInTheDocument()
  expect(screen.getByRole("option", { name: "Model B" })).toHaveAttribute("aria-disabled", "true")
})

it("reflects controlled value and catalog updates without firing change", () => {
  const onChange = jest.fn()
  const view = render(
    <NativeSelect aria-label="Model" value="a" onChange={onChange}>
      <NativeSelectOption value="a">Model A</NativeSelectOption>
    </NativeSelect>
  )
  view.rerender(
    <NativeSelect aria-label="Model" value="b" onChange={onChange}>
      <NativeSelectOption value="b">Model B</NativeSelectOption>
    </NativeSelect>
  )
  expect(screen.getByRole("combobox")).toHaveTextContent("Model B")
  expect(onChange).not.toHaveBeenCalled()
})

it.each([
  ["narrow desktop", false, true, false, "BUTTON"],
  ["touch-only browser", true, false, false, "SELECT"],
  ["Tauri with touch input", true, true, true, "BUTTON"],
] as const)("uses the correct picker for %s", (_name, touch, narrow, tauri, tag) => {
  const media = jest.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches: query.includes("coarse") ? touch : narrow,
        media: query,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      }) as unknown as MediaQueryList
  )
  if (tauri) Object.assign(window, { __TAURI_INTERNALS__: {} })
  const view = render(
    <NativeSelect aria-label="Attempts" value="2" onChange={jest.fn()}>
      <NativeSelectOption value="2">Best of 2</NativeSelectOption>
    </NativeSelect>
  )
  expect(screen.getByRole("combobox").tagName).toBe(tag)
  view.unmount()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  media.mockRestore()
})
