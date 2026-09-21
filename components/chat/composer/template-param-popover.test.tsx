import { fireEvent, render, screen, within } from "@testing-library/react"
import { TemplateParamPopover } from "./template-param-popover"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function anchorEl(): HTMLElement {
  const el = document.createElement("div")
  document.body.appendChild(el)
  return el
}

describe("TemplateParamPopover", () => {
  it("stays closed when no parameter is being edited", () => {
    render(
      <TemplateParamPopover
        paramId={null}
        value={undefined}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(screen.queryByTestId("template-param-popover")).not.toBeInTheDocument()
  })

  it("stays closed until it has an anchor to position against", () => {
    render(
      <TemplateParamPopover
        paramId="module"
        value={undefined}
        anchor={null}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(screen.queryByTestId("template-param-popover")).not.toBeInTheDocument()
  })

  it("shows the parameter id and its current value", () => {
    render(
      <TemplateParamPopover
        paramId="module"
        value={{ kind: "text", value: "login" }}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(screen.getByText("module")).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveValue("login")
  })

  it("reports every keystroke as a text value", () => {
    const onChange = jest.fn()
    render(
      <TemplateParamPopover
        paramId="module"
        value={undefined}
        anchor={anchorEl()}
        onChange={onChange}
        onClose={jest.fn()}
      />
    )

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "auth" } })

    expect(onChange).toHaveBeenCalledWith({ kind: "text", value: "auth" })
  })

  it("falls back to a resource's label, which is what a shared template degrades to", () => {
    render(
      <TemplateParamPopover
        paramId="repo"
        value={{ kind: "resource", resourceKind: "repo", id: "p_1", label: "cognia-next" }}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(screen.getByRole("textbox")).toHaveValue("cognia-next")
  })

  it("closes on Enter, exactly once", () => {
    const onClose = jest.fn()
    render(
      <TemplateParamPopover
        paramId="module"
        value={undefined}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={onClose}
      />
    )

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("closes on Escape exactly once, leaving the key to the dismiss layer", () => {
    // Handling Escape here too fired `onClose` twice: the popover's own
    // dismiss layer listens on the document, so a React `stopPropagation`
    // never reaches it.
    const onClose = jest.fn()
    render(
      <TemplateParamPopover
        paramId="module"
        value={undefined}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={onClose}
      />
    )

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("does not take focus when it opens", () => {
    // The user is mid-sentence. Yanking the caret out of the textarea into a
    // panel they did not ask for is worse than no panel at all.
    const textarea = document.createElement("textarea")
    document.body.appendChild(textarea)
    textarea.focus()

    render(
      <TemplateParamPopover
        paramId="module"
        value={undefined}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(document.activeElement).toBe(textarea)
  })
})

describe("TemplateParamPopover — declared kinds", () => {
  const resourceParam = {
    id: "target",
    label: "Target file",
    required: true,
    kind: "resource" as const,
    resourceKind: "file" as const,
  }

  it("picks a reference through the shared @ source", async () => {
    const onChange = jest.fn()
    const onClose = jest.fn()
    const search = jest
      .fn()
      .mockResolvedValue([{ id: "src/app.ts", label: "src/app.ts", raw: "@src/app.ts" }])

    render(
      <TemplateParamPopover
        paramId="target"
        param={resourceParam}
        value={undefined}
        anchor={anchorEl()}
        searchResources={search}
        onChange={onChange}
        onClose={onClose}
      />
    )

    // The 200ms debounce is the `@file` menu's, kept so a fast typist can't
    // queue one workspace walk per keystroke.
    expect(await screen.findByText("src/app.ts", undefined, { timeout: 3000 })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("option"))

    expect(onChange).toHaveBeenCalledWith({
      kind: "resource",
      resourceKind: "file",
      id: "src/app.ts",
      label: "src/app.ts",
      raw: "@src/app.ts",
    })
    expect(onClose).toHaveBeenCalled()
  })

  it("steps ↓ from the query into results and ↑ back out at the top", async () => {
    const search = jest.fn().mockResolvedValue([
      { id: "a.ts", label: "a.ts", raw: "@a.ts" },
      { id: "b.ts", label: "b.ts", raw: "@b.ts" },
    ])

    render(
      <TemplateParamPopover
        paramId="target"
        param={resourceParam}
        value={undefined}
        anchor={anchorEl()}
        searchResources={search}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    await screen.findByText("a.ts", undefined, { timeout: 3000 })
    const input = screen.getByTestId("template-param-search")
    const [first, second] = screen.getAllByRole("option")

    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: "ArrowDown" })
    expect(document.activeElement).toBe(second)
    // ↑ on the first result returns to the query, not the last result.
    fireEvent.keyDown(second, { key: "ArrowUp" })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: "ArrowUp" })
    expect(document.activeElement).toBe(input)
  })

  it("marks the already-bound resource as selected", async () => {
    render(
      <TemplateParamPopover
        paramId="target"
        param={resourceParam}
        value={{
          kind: "resource",
          resourceKind: "file",
          id: "a.ts",
          label: "a.ts",
        }}
        anchor={anchorEl()}
        searchResources={jest.fn().mockResolvedValue([{ id: "a.ts", label: "a.ts", raw: "@a.ts" }])}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    await screen.findByText("a.ts", undefined, { timeout: 3000 })
    expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "true")
  })

  it("shows the position counter when the caller knows it", () => {
    render(
      <TemplateParamPopover
        paramId="module"
        value={undefined}
        anchor={anchorEl()}
        position={{ index: 1, total: 3 }}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(screen.getByText("position")).toBeInTheDocument()
  })

  it("uses a textarea for a declared multi-line parameter", () => {
    const onChange = jest.fn()
    const onClose = jest.fn()
    render(
      <TemplateParamPopover
        paramId="notes"
        param={{ id: "notes", label: "Notes", required: false, kind: "string", multiline: true }}
        value={{ kind: "text", value: "line one" }}
        anchor={anchorEl()}
        onChange={onChange}
        onClose={onClose}
      />
    )

    const field = within(screen.getByTestId("template-param-popover")).getByRole("textbox")
    expect(field.tagName).toBe("TEXTAREA")
    fireEvent.change(field, { target: { value: "line one\nline two" } })
    expect(onChange).toHaveBeenCalledWith({ kind: "text", value: "line one\nline two" })
    // Enter still confirms rather than forcing a newline.
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onClose).toHaveBeenCalled()
  })

  it("says so when a search returns nothing", async () => {
    render(
      <TemplateParamPopover
        paramId="target"
        param={resourceParam}
        value={undefined}
        anchor={anchorEl()}
        searchResources={jest.fn().mockResolvedValue([])}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(await screen.findByText("noMatches", undefined, { timeout: 3000 })).toBeInTheDocument()
  })

  // Without a search source there is nothing to pick from, and an empty picker
  // that can never fill in would be a dead end — free text still works.
  it("falls back to free text when the composer has no picker to offer", () => {
    render(
      <TemplateParamPopover
        paramId="target"
        param={resourceParam}
        value={undefined}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(screen.queryByTestId("template-param-search")).not.toBeInTheDocument()
    expect(
      within(screen.getByTestId("template-param-popover")).getByRole("textbox")
    ).toBeInTheDocument()
  })

  it("offers a declared choice list instead of a text field", () => {
    const onChange = jest.fn()
    render(
      <TemplateParamPopover
        paramId="env"
        param={{
          id: "env",
          label: "Environment",
          required: true,
          kind: "enum",
          options: ["staging", "production"],
        }}
        value={{ kind: "text", value: "staging" }}
        anchor={anchorEl()}
        onChange={onChange}
        onClose={jest.fn()}
      />
    )

    const options = screen.getAllByRole("option")
    expect(options.map((el) => el.textContent)).toEqual(["staging", "production"])
    expect(options[0]).toHaveAttribute("aria-selected", "true")

    fireEvent.click(options[1])
    expect(onChange).toHaveBeenCalledWith({ kind: "text", value: "production" })
  })

  it("walks a closed list with arrow keys and wraps at the ends", () => {
    render(
      <TemplateParamPopover
        paramId="env"
        param={{
          id: "env",
          label: "Environment",
          required: true,
          kind: "enum",
          options: ["staging", "production", "preview"],
        }}
        value={undefined}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    const options = screen.getAllByRole("option")
    options[0].focus()
    fireEvent.keyDown(options[0], { key: "ArrowDown" })
    expect(document.activeElement).toBe(options[1])
    fireEvent.keyDown(options[1], { key: "ArrowUp" })
    expect(document.activeElement).toBe(options[0])
    // Past the last item wraps to the first.
    fireEvent.keyDown(options[0], { key: "ArrowUp" })
    expect(document.activeElement).toBe(options[2])
    // A non-arrow key is none of the list's business — focus stays put.
    // (Tab is deliberately not tested: Radix's focus scope owns it and loops
    // focus back to the first option, which is the correct popover behavior.)
    fireEvent.keyDown(options[2], { key: "x" })
    expect(document.activeElement).toBe(options[2])
  })

  it("shows the declared label and description rather than the raw token", () => {
    render(
      <TemplateParamPopover
        paramId="module"
        param={{
          id: "module",
          label: "Which module",
          description: "The area of the codebase to review",
          required: true,
          kind: "string",
        }}
        value={undefined}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(screen.getByText("Which module")).toBeInTheDocument()
    expect(screen.getByText("The area of the codebase to review")).toBeInTheDocument()
  })
})
