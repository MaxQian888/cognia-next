import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

jest.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    "aria-label": ariaLabel,
  }: {
    checked: boolean
    onCheckedChange: (v: boolean) => void
    "aria-label"?: string
  }) => (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value?: string
    onValueChange?: (v: string) => void
  }) => (
    <select
      data-testid="strategy-select"
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}))

import { ApiKeyPoolInput } from "./api-key-pool-input"

function setup(props: Partial<React.ComponentProps<typeof ApiKeyPoolInput>> = {}) {
  const onChange = jest.fn()
  const onRotationEnabledChange = jest.fn()
  const onStrategyChange = jest.fn()
  const utils = render(
    <ApiKeyPoolInput
      keys={[]}
      onChange={onChange}
      rotationEnabled={false}
      onRotationEnabledChange={onRotationEnabledChange}
      strategy="round-robin"
      onStrategyChange={onStrategyChange}
      placeholder="tvly-xxx"
      {...props}
    />
  )
  return { onChange, onRotationEnabledChange, onStrategyChange, ...utils }
}

describe("ApiKeyPoolInput", () => {
  it("toggles rotation via the switch", () => {
    const { onRotationEnabledChange } = setup()
    fireEvent.click(screen.getByLabelText("rotateKeys"))
    expect(onRotationEnabledChange).toHaveBeenCalledWith(true)
  })

  it("shows the strategy select only when rotation is enabled", () => {
    const { rerender } = setup()
    expect(screen.queryByTestId("strategy-select")).not.toBeInTheDocument()
    rerender(
      <ApiKeyPoolInput
        keys={[]}
        onChange={jest.fn()}
        rotationEnabled
        onRotationEnabledChange={jest.fn()}
        strategy="round-robin"
        onStrategyChange={jest.fn()}
      />
    )
    expect(screen.getByTestId("strategy-select")).toBeInTheDocument()
  })

  it("changes the rotation strategy", () => {
    const { onStrategyChange } = setup({ rotationEnabled: true })
    fireEvent.change(screen.getByTestId("strategy-select"), { target: { value: "least-used" } })
    expect(onStrategyChange).toHaveBeenCalledWith("least-used")
  })

  it("renders each backup key and edits it in place", () => {
    const { onChange } = setup({ keys: ["a", "b"] })
    const inputs = screen.getAllByPlaceholderText("tvly-xxx")
    // two key inputs + the draft input
    expect(inputs).toHaveLength(3)
    fireEvent.change(inputs[0], { target: { value: "A2" } })
    expect(onChange).toHaveBeenCalledWith(["A2", "b"])
  })

  it("removes a backup key", () => {
    const { onChange } = setup({ keys: ["a", "b"] })
    fireEvent.click(screen.getAllByLabelText("removeKey")[0])
    expect(onChange).toHaveBeenCalledWith(["b"])
  })

  it("appends a new key via the add button", () => {
    const { onChange } = setup({ keys: ["a"] })
    const draft = screen.getAllByPlaceholderText("tvly-xxx").at(-1)!
    fireEvent.change(draft, { target: { value: "new-key" } })
    fireEvent.click(screen.getByText("addBackupKey"))
    expect(onChange).toHaveBeenCalledWith(["a", "new-key"])
  })

  it("appends on Enter", () => {
    const { onChange } = setup()
    const draft = screen.getByPlaceholderText("tvly-xxx")
    fireEvent.change(draft, { target: { value: "k1" } })
    fireEvent.keyDown(draft, { key: "Enter" })
    expect(onChange).toHaveBeenCalledWith(["k1"])
  })

  it("ignores a duplicate key", () => {
    const { onChange } = setup({ keys: ["dup"] })
    const draft = screen.getAllByPlaceholderText("tvly-xxx").at(-1)!
    fireEvent.change(draft, { target: { value: "dup" } })
    fireEvent.click(screen.getByText("addBackupKey"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("shows the pool size including the primary key", () => {
    setup({ keys: ["a", "b"] })
    // 2 backup + 1 primary = 3
    expect(screen.getByText('keyPoolSize:{"count":3}')).toBeInTheDocument()
  })

  it("reveals and hides the keys", () => {
    setup({ keys: ["a"] })
    fireEvent.click(screen.getByLabelText("showKeys"))
    expect(screen.getByLabelText("hideKeys")).toBeInTheDocument()
  })

  it("ignores non-Enter keydown in the draft input", () => {
    const { onChange } = setup()
    const draft = screen.getByPlaceholderText("tvly-xxx")
    fireEvent.change(draft, { target: { value: "k" } })
    fireEvent.keyDown(draft, { key: "a" })
    expect(onChange).not.toHaveBeenCalled()
  })
})
