import { render, screen } from "@testing-library/react"

import { SHELL_KIND_LABEL_KEYS, ShellCompletionRow } from "./shell-completion-row"
import enMessages from "@/i18n/messages/en/chat.json"
import zhMessages from "@/i18n/messages/zh-CN/chat.json"
import type { ShellCompletion } from "@/lib/shell-intelligence/types"

const completion = (over: Partial<ShellCompletion> = {}): ShellCompletion => ({
  label: "kubectl",
  insertText: "kubectl",
  from: 0,
  to: 3,
  kind: "command",
  ...over,
})

const renderRow = (c: ShellCompletion) => render(<ShellCompletionRow completion={c} />)

describe("ShellCompletionRow", () => {
  it("shows the candidate's label", () => {
    renderRow(completion())
    expect(screen.getByText("kubectl")).toBeInTheDocument()
  })

  it("shows the detail line when the candidate has one", () => {
    renderRow(completion({ detail: "Kubernetes CLI" }))
    expect(screen.getByText("Kubernetes CLI")).toBeInTheDocument()
  })

  it("omits the detail line when it has none", () => {
    const { container } = renderRow(completion())
    expect(container.querySelectorAll("span.text-xs")).toHaveLength(0)
  })

  it("names the kind, so a $PATH hit is distinguishable from a matching file", () => {
    renderRow(completion({ kind: "command" }))
    expect(screen.getByText("command")).toBeInTheDocument()
  })

  it("marks the icon slot with the kind for every kind it can render", () => {
    for (const kind of Object.keys(SHELL_KIND_LABEL_KEYS) as ShellCompletion["kind"][]) {
      const { container, unmount } = renderRow(completion({ kind }))
      expect(container.querySelector(`[data-shell-kind="${kind}"]`)).not.toBeNull()
      unmount()
    }
  })
})

describe("SHELL_KIND_LABEL_KEYS", () => {
  /**
   * `lint:i18n` cannot see through the map lookup the row does, so the keys are
   * pinned here instead — in BOTH locales, since a key present in one only is
   * exactly the drift the gate would otherwise have caught.
   */
  const lookup = (messages: typeof enMessages, key: string) =>
    key.split(".").reduce<unknown>((node, part) => {
      if (node && typeof node === "object" && part in node) {
        return (node as Record<string, unknown>)[part]
      }
      return undefined
    }, messages.composer.popover)

  it.each(Object.entries(SHELL_KIND_LABEL_KEYS))("%s → %s exists in en and zh-CN", (_kind, key) => {
    expect(typeof lookup(enMessages, key)).toBe("string")
    expect(typeof lookup(zhMessages, key)).toBe("string")
  })

  it("covers every completion kind", () => {
    const kinds: ShellCompletion["kind"][] = [
      "command",
      "builtin",
      "path",
      "directory",
      "option",
      "argument",
    ]
    expect(Object.keys(SHELL_KIND_LABEL_KEYS).sort()).toEqual([...kinds].sort())
  })
})
