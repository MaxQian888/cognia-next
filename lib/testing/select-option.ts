import { fireEvent, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

/** Inspect form options without mistaking the desktop trigger for its native form mirror. */
export function getNativeSelect(control: HTMLElement): HTMLSelectElement {
  if (control instanceof HTMLSelectElement) return control
  const native = control
    .closest('[data-slot="native-select-wrapper"]')
    ?.querySelector<HTMLSelectElement>('select[data-slot="native-select"]')
  if (!native) throw new Error("Select has no native form control")
  return native
}

/** Exercise the visible picker while keeping value-based tests portable across devices. */
export async function selectOption(
  control: HTMLElement,
  value: string | HTMLElement
): Promise<void> {
  const user = userEvent.setup({
    advanceTimers: (delay) => {
      if ("clock" in setTimeout || jest.isMockFunction(setTimeout)) jest.advanceTimersByTime(delay)
    },
  })
  // Catalog-backed fields fall back to editable text when their catalog is empty.
  if (control instanceof HTMLInputElement) {
    fireEvent.change(control, { target: { value } })
    return
  }
  if (control instanceof HTMLSelectElement) {
    await user.selectOptions(control, value)
    return
  }
  const selectedValue = typeof value === "string" ? value : (value as HTMLOptionElement).value
  const native = getNativeSelect(control)
  const option = Array.from(native.options).find((item) => item.value === selectedValue)
  if (!option) throw new Error(`Select option ${JSON.stringify(selectedValue)} does not exist`)
  if (option.disabled) throw new Error(`Select option ${JSON.stringify(selectedValue)} is disabled`)
  await user.click(control)
  const label = option.label.replace(/\s+/g, " ").trim()
  const index = Array.from(native.options)
    .filter((item) => item.label.replace(/\s+/g, " ").trim() === label)
    .indexOf(option)
  await user.click(
    within(screen.getByRole("listbox")).getAllByRole("option", { name: label })[index]
  )
}
