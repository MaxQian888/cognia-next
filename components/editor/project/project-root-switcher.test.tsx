/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Flatten Radix Select into a native <select> so jsdom can drive it.
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const Ctx = React.createContext<(value: string) => void>(() => {})
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string
      onValueChange: (v: string) => void
      children: React.ReactNode
    }) => (
      <Ctx.Provider value={onValueChange}>
        <select
          data-testid="native-root-select"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
        >
          {children}
        </select>
      </Ctx.Provider>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
  }
})

import { ProjectRootSwitcher } from "./project-root-switcher"
import type { ProjectRoot } from "./use-project-editor"

const roots: ProjectRoot[] = [
  { key: "/repo", label: "main", path: "/repo", isMain: true },
  { key: "/repo-wt", label: "feature/x", path: "/repo-wt", isMain: false },
]

describe("ProjectRootSwitcher", () => {
  it("renders nothing with a single root", () => {
    const { container } = render(
      <ProjectRootSwitcher roots={[roots[0]]} rootKey="/repo" onSelect={jest.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("lists every root and fires onSelect on change", () => {
    const onSelect = jest.fn()
    render(<ProjectRootSwitcher roots={roots} rootKey="/repo" onSelect={onSelect} />)
    const select = screen.getByTestId("native-root-select")
    fireEvent.change(select, { target: { value: "/repo-wt" } })
    expect(onSelect).toHaveBeenCalledWith("/repo-wt")
  })
})
