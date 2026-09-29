import { fireEvent, render, screen } from "@testing-library/react"

import type { ProjectEnvironmentSetupReuse } from "@/types/project-environment"

import {
  ProjectEnvironmentSetupReuseFields,
  finalizeSetupReuse,
} from "./project-environment-setup-reuse"

describe("ProjectEnvironmentSetupReuseFields", () => {
  it("shows only the switch while reuse is off", () => {
    render(<ProjectEnvironmentSetupReuseFields value={undefined} onChange={jest.fn()} ids="env" />)
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false")
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("turns reuse on from an environment that never opted in", () => {
    const onChange = jest.fn()
    render(<ProjectEnvironmentSetupReuseFields value={undefined} onChange={onChange} ids="env" />)
    fireEvent.click(screen.getByRole("switch"))
    expect(onChange).toHaveBeenCalledWith({ enabled: true, inputs: [], outputs: [] })
  })

  it("edits inputs and outputs one path per line, keeping a blank line while typing", () => {
    const onChange = jest.fn()
    const value: ProjectEnvironmentSetupReuse = {
      enabled: true,
      inputs: ["pnpm-lock.yaml"],
      outputs: ["node_modules"],
    }
    render(<ProjectEnvironmentSetupReuseFields value={value} onChange={onChange} ids="env" />)
    const [inputs, outputs] = screen.getAllByRole("textbox")
    expect(inputs).toHaveValue("pnpm-lock.yaml")
    expect(outputs).toHaveValue("node_modules")

    fireEvent.change(inputs, { target: { value: "pnpm-lock.yaml\n" } })
    expect(onChange).toHaveBeenLastCalledWith({ ...value, inputs: ["pnpm-lock.yaml", ""] })

    fireEvent.change(outputs, { target: { value: "node_modules\n.venv" } })
    expect(onChange).toHaveBeenLastCalledWith({ ...value, outputs: ["node_modules", ".venv"] })
  })
})

describe("finalizeSetupReuse", () => {
  it("leaves an untouched environment without a declaration", () => {
    expect(finalizeSetupReuse(undefined)).toBeUndefined()
    expect(finalizeSetupReuse({ enabled: false, inputs: [" "], outputs: [] })).toBeUndefined()
  })

  it("trims paths and drops blank lines", () => {
    expect(
      finalizeSetupReuse({
        enabled: true,
        inputs: [" pnpm-lock.yaml ", ""],
        outputs: ["", "node_modules"],
      })
    ).toEqual({ enabled: true, inputs: ["pnpm-lock.yaml"], outputs: ["node_modules"] })
  })

  it("keeps the lists of a disabled declaration so turning it back on restores them", () => {
    expect(finalizeSetupReuse({ enabled: false, inputs: ["a.lock"], outputs: [] })).toEqual({
      enabled: false,
      inputs: ["a.lock"],
      outputs: [],
    })
  })
})
