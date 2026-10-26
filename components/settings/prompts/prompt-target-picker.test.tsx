/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { ReactNode } from "react"

jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (value: string) => void
    children: ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange?.(event.target.value)}>
      <option value="" />
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}))

import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { createCharacter } from "@/lib/db/characters"
import { createSession, updateSession } from "@/lib/db/sessions"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { useProjectStore } from "@/stores/project/project-store"
import { PromptTargetPicker, usePromptTargetOptions } from "./prompt-target-picker"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  useProjectStore.setState({
    projects: [
      { id: "ws-1", name: "Repo", roots: [] },
      { id: "ws-old", name: "Old", roots: [], isArchived: true },
    ],
  } as never)
})
afterAll(dbFixture.dispose)

describe("usePromptTargetOptions", () => {
  it("offers live workspaces, every agent and recent unarchived chats", async () => {
    expect(renderHook(() => usePromptTargetOptions("account")).result.current).toEqual([])
    expect(renderHook(() => usePromptTargetOptions("workspace")).result.current).toEqual([
      { id: "ws-1", label: "Repo" },
    ])

    const agent = await createCharacter({ name: "Ada", systemPrompt: "x" })
    const agents = renderHook(() => usePromptTargetOptions("agent"))
    await waitFor(() =>
      expect(agents.result.current).toContainEqual({ id: agent.id, label: "Ada" })
    )

    const pause = () => new Promise((resolve) => setTimeout(resolve, 5))
    await createSession({ title: "Older" })
    await pause()
    const newer = await createSession({ title: "Newer" })
    const gone = await createSession({ title: "Gone" })
    await updateSession(gone.id, { archivedAt: Date.now() })
    const sessions = renderHook(() => usePromptTargetOptions("session"))
    await waitFor(() => expect(sessions.result.current?.length).toBe(2))
    expect(sessions.result.current?.map((option) => option.label)).toEqual(["Newer", "Older"])
    expect(sessions.result.current?.[0].id).toBe(newer.id)
  })
})

describe("PromptTargetPicker", () => {
  it("offers only the definition's scopes and resets the target on a scope change", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <PromptTargetPicker
        scopes={["account", "workspace"]}
        scope="account"
        targetId=""
        onChange={onChange}
      />
    )
    const [scopeSelect] = screen.getAllByRole("combobox")
    expect([...scopeSelect.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "",
      "account",
      "workspace",
    ])
    // No target picker at the account scope.
    expect(screen.getAllByRole("combobox")).toHaveLength(1)

    fireEvent.change(scopeSelect, { target: { value: "workspace" } })
    expect(onChange).toHaveBeenLastCalledWith({ scope: "workspace", targetId: "" })

    rerender(
      <PromptTargetPicker
        scopes={["account", "workspace"]}
        scope="workspace"
        targetId=""
        onChange={onChange}
      />
    )
    const targetSelect = screen.getAllByRole("combobox")[1]
    fireEvent.change(targetSelect, { target: { value: "ws-1" } })
    expect(onChange).toHaveBeenLastCalledWith({ scope: "workspace", targetId: "ws-1" })
  })

  it("says when a scope has no targets", () => {
    useProjectStore.setState({ projects: [] } as never)
    render(
      <PromptTargetPicker
        scopes={["workspace"]}
        scope="workspace"
        targetId=""
        onChange={jest.fn()}
      />
    )
    expect(screen.getByText("No workspaces yet.")).toBeInTheDocument()
  })
})
