/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    onClick,
  }: {
    children: React.ReactNode
    href: string
    onClick?: () => void
  }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}))

import { ChatHeaderPresetPill, resolveActivePreset } from "./chat-header-preset-pill"
import type { ChatSession, SystemPromptPreset } from "@/lib/claude/types"

function preset(overrides: Partial<SystemPromptPreset>): SystemPromptPreset {
  return {
    id: overrides.id ?? "x",
    name: overrides.name ?? "X",
    content: overrides.content ?? "...",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as SystemPromptPreset
}

function session(
  overrides: Partial<ChatSession>
): Pick<ChatSession, "activePresetId" | "systemPrompt"> {
  return {
    activePresetId: overrides.activePresetId,
    systemPrompt: overrides.systemPrompt,
  }
}

describe("resolveActivePreset", () => {
  const presets = [
    preset({ id: "a", name: "Alpha", content: "alpha body" }),
    preset({ id: "b", name: "Beta", content: "beta body" }),
  ]

  it("prefers session.activePresetId when present", () => {
    expect(resolveActivePreset(session({ activePresetId: "b" }), presets)?.id).toBe("b")
  })

  it("falls back to content-equality match when activePresetId is unset", () => {
    expect(resolveActivePreset(session({ systemPrompt: "beta body" }), presets)?.id).toBe("b")
  })

  it("returns null when nothing matches", () => {
    expect(resolveActivePreset(session({ systemPrompt: "nothing" }), presets)).toBeNull()
  })

  it("returns null when activePresetId references a deleted preset and no content fallback matches", () => {
    expect(
      resolveActivePreset(session({ activePresetId: "missing", systemPrompt: "x" }), presets)
    ).toBeNull()
  })
})

describe("ChatHeaderPresetPill", () => {
  const presets = [
    preset({ id: "a", name: "Alpha", isFavorite: true }),
    preset({ id: "b", name: "Beta", category: "coding" }),
    preset({ id: "c", name: "Gamma", isDefault: true }),
  ]

  it("renders the active preset's name in the pill button", () => {
    render(
      <ChatHeaderPresetPill
        session={session({ activePresetId: "b" })}
        presets={presets}
        onSelectPreset={jest.fn()}
      />
    )
    expect(screen.getByTestId("chat-header-preset-pill")).toHaveTextContent("Beta")
  })

  it("falls back to a 'none' label when no preset is active", () => {
    render(
      <ChatHeaderPresetPill session={session({})} presets={presets} onSelectPreset={jest.fn()} />
    )
    expect(screen.getByTestId("chat-header-preset-pill")).toHaveTextContent("none")
  })

  it("opens the popover and renders grouped presets on click", () => {
    render(
      <ChatHeaderPresetPill session={session({})} presets={presets} onSelectPreset={jest.fn()} />
    )
    fireEvent.click(screen.getByTestId("chat-header-preset-pill"))
    expect(screen.getByTestId("chat-header-preset-pill-list")).toBeInTheDocument()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.getByText("Gamma")).toBeInTheDocument()
  })

  it("invokes onSelectPreset when a row is clicked", () => {
    const onSelectPreset = jest.fn()
    render(
      <ChatHeaderPresetPill
        session={session({})}
        presets={presets}
        onSelectPreset={onSelectPreset}
      />
    )
    fireEvent.click(screen.getByTestId("chat-header-preset-pill"))
    fireEvent.click(screen.getByTestId("chat-header-preset-pill-row-b"))
    expect(onSelectPreset).toHaveBeenCalledTimes(1)
    expect(onSelectPreset.mock.calls[0][0].id).toBe("b")
  })

  it("filters presets by the search input", () => {
    render(
      <ChatHeaderPresetPill session={session({})} presets={presets} onSelectPreset={jest.fn()} />
    )
    fireEvent.click(screen.getByTestId("chat-header-preset-pill"))
    fireEvent.change(screen.getByLabelText("searchAriaLabel"), { target: { value: "alpha" } })
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.queryByText("Beta")).not.toBeInTheDocument()
  })

  it("renders the 'manage all' footer link with the configured href", () => {
    render(
      <ChatHeaderPresetPill
        session={session({})}
        presets={presets}
        onSelectPreset={jest.fn()}
        manageHref="/me/presets"
      />
    )
    fireEvent.click(screen.getByTestId("chat-header-preset-pill"))
    expect(screen.getByText("manageAll").closest("a")).toHaveAttribute("href", "/me/presets")
  })
})
