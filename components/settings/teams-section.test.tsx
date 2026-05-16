/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Stub next-intl: keys come back verbatim (with simple {var} interpolation).
// The component uses about a dozen distinct keys; we don't need the real
// English bundle to drive the flows.
jest.mock("next-intl", () => {
  const interpolate = (template: string, values?: Record<string, unknown>) =>
    !values
      ? template
      : Object.entries(values).reduce(
          (acc, [k, v]) => acc.replace(new RegExp(`\\{\\s*${k}\\s*\\}`, "g"), String(v)),
          template
        )
  return {
    useTranslations: (namespace?: string) => (key: string, values?: Record<string, unknown>) => {
      const full = namespace ? `${namespace}.${key}` : key
      return interpolate(full, values)
    },
  }
})

// Sonner is fire-and-forget; mock to spies so we can assert error toasts.
jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

import { TeamsSection } from "./teams-section"
import { createTeam, listTeams, seedBuiltInTeams } from "@/lib/db/teams"
import { seedBuiltInCharacters } from "@/lib/db/characters"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { toast } from "sonner"

beforeEach(async () => {
  jest.clearAllMocks()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await seedBuiltInCharacters()
  await getDb().teams.clear()
})

async function findOrchestrationSelectTrigger() {
  // The orchestration <Select> is the first SelectTrigger inside the editor
  // that doesn't carry the supervisor placeholder.
  const triggers = await screen.findAllByRole("combobox")
  return triggers[0]!
}

describe("TeamsSection — listing", () => {
  it("renders empty state when no teams exist", async () => {
    render(<TeamsSection />)
    await waitFor(() => {
      expect(screen.getByText("settings.teams.emptyHint")).toBeInTheDocument()
    })
  })

  it("renders rows with built-in badge and disabled edit/delete", async () => {
    await seedBuiltInTeams()
    render(<TeamsSection />)
    await screen.findByText("Brainstorm Squad")
    // Multiple built-ins are seeded — every row should show the built-in badge.
    expect(screen.getAllByText("settings.teams.builtIn").length).toBeGreaterThan(0)

    const editAria = "settings.teams.editAria"
    const deleteAria = "settings.teams.deleteAria"
    const editButtons = screen.getAllByRole("button", {
      name: new RegExp(editAria),
    })
    expect(editButtons.length).toBeGreaterThan(0)
    expect(editButtons[0]).toBeDisabled()
    const delButtons = screen.getAllByRole("button", {
      name: new RegExp(deleteAria),
    })
    expect(delButtons[0]).toBeDisabled()
  })

  it("renders user-created teams alongside built-ins", async () => {
    await seedBuiltInTeams()
    await createTeam({
      name: "My Team",
      members: [{ characterId: "char_builtin_coding" }],
    })
    render(<TeamsSection />)
    await screen.findByText("My Team")
    expect(screen.getByText("Brainstorm Squad")).toBeInTheDocument()
  })
})

describe("TeamsSection — create flow", () => {
  it("'New team' button is disabled until a character exists", async () => {
    await getDb().characters.clear()
    render(<TeamsSection />)
    const btn = await screen.findByRole("button", { name: /settings\.teams\.newTeam/ })
    expect(btn).toBeDisabled()
  })

  it("opens the editor when 'New team' is clicked", async () => {
    const user = userEvent.setup()
    render(<TeamsSection />)
    const btn = await screen.findByRole("button", { name: /settings\.teams\.newTeam/ })
    await waitFor(() => expect(btn).not.toBeDisabled())
    await user.click(btn)
    expect(screen.getByPlaceholderText("settings.teams.editor.namePlaceholder")).toBeInTheDocument()
  })

  it("rejects submission with no name", async () => {
    const user = userEvent.setup()
    render(<TeamsSection />)
    const newBtn = await screen.findByRole("button", { name: /settings\.teams\.newTeam/ })
    await waitFor(() => expect(newBtn).not.toBeDisabled())
    await user.click(newBtn)
    // Click submit without a name → toast.error fires
    await user.click(screen.getByRole("button", { name: /settings\.teams\.create/ }))
    expect(toast.error).toHaveBeenCalledWith("settings.teams.validation.nameRequired")
  })

  it("rejects submission with no members", async () => {
    const user = userEvent.setup()
    render(<TeamsSection />)
    const newBtn = await screen.findByRole("button", { name: /settings\.teams\.newTeam/ })
    await waitFor(() => expect(newBtn).not.toBeDisabled())
    await user.click(newBtn)
    await user.type(screen.getByPlaceholderText("settings.teams.editor.namePlaceholder"), "Plain")
    await user.click(screen.getByRole("button", { name: /settings\.teams\.create/ }))
    expect(toast.error).toHaveBeenCalledWith("settings.teams.validation.atLeastOneMember")
  })

  it("creates a valid team end to end", async () => {
    const user = userEvent.setup()
    render(<TeamsSection />)
    const newBtn = await screen.findByRole("button", { name: /settings\.teams\.newTeam/ })
    await waitFor(() => expect(newBtn).not.toBeDisabled())
    await user.click(newBtn)

    await user.type(screen.getByPlaceholderText("settings.teams.editor.namePlaceholder"), "Squad-A")
    // Toggle one member on (Coding Assistant chip)
    const coderChip = screen.getByRole("button", { name: /Coding Assistant/ })
    await user.click(coderChip)
    await user.click(screen.getByRole("button", { name: /settings\.teams\.create/ }))

    await waitFor(async () => {
      const rows = await listTeams()
      expect(rows.find((t) => t.name === "Squad-A")).toBeDefined()
    })
    expect(toast.success).toHaveBeenCalled()
  })
})

describe("TeamsSection — supervisor mode", () => {
  it("rejects supervisor mode with no supervisor selected", async () => {
    const user = userEvent.setup()
    render(<TeamsSection />)
    const newBtn = await screen.findByRole("button", { name: /settings\.teams\.newTeam/ })
    await waitFor(() => expect(newBtn).not.toBeDisabled())
    await user.click(newBtn)

    await user.type(
      screen.getByPlaceholderText("settings.teams.editor.namePlaceholder"),
      "Boss-Team"
    )
    await user.click(screen.getByRole("button", { name: /Coding Assistant/ }))

    // Switch orchestration to supervisor.
    const trigger = await findOrchestrationSelectTrigger()
    await user.click(trigger)
    const supItem = await screen.findByRole("option", {
      name: /settings\.teams\.orchestration\.supervisor/,
    })
    await user.click(supItem)

    await user.click(screen.getByRole("button", { name: /settings\.teams\.create/ }))
    expect(toast.error).toHaveBeenCalledWith("settings.teams.validation.supervisorRequired")
  })

  it("creates a valid supervisor team after picking supervisor", async () => {
    const user = userEvent.setup()
    render(<TeamsSection />)
    const newBtn = await screen.findByRole("button", { name: /settings\.teams\.newTeam/ })
    await waitFor(() => expect(newBtn).not.toBeDisabled())
    await user.click(newBtn)

    await user.type(
      screen.getByPlaceholderText("settings.teams.editor.namePlaceholder"),
      "Boss-Team-OK"
    )
    await user.click(screen.getByRole("button", { name: /Coding Assistant/ }))
    await user.click(screen.getByRole("button", { name: /Writing Editor/ }))

    // Switch to supervisor mode.
    const orchestrationTrigger = await findOrchestrationSelectTrigger()
    await user.click(orchestrationTrigger)
    await user.click(
      await screen.findByRole("option", {
        name: /settings\.teams\.orchestration\.supervisor/,
      })
    )

    // Now there are 2 SelectTriggers; the second is the supervisor picker.
    const allTriggers = screen.getAllByRole("combobox")
    expect(allTriggers.length).toBeGreaterThan(1)
    await user.click(allTriggers[1]!)
    const supChoice = await screen.findByRole("option", { name: /Coding Assistant/ })
    await user.click(supChoice)

    await user.click(screen.getByRole("button", { name: /settings\.teams\.create/ }))

    await waitFor(async () => {
      const rows = await listTeams()
      const created = rows.find((t) => t.name === "Boss-Team-OK")
      expect(created).toBeDefined()
      expect(created?.orchestration).toBe("supervisor")
      expect(created?.supervisorCharacterId).toBe("char_builtin_coding")
    })
  })
})

describe("TeamsSection — duplicate / delete", () => {
  it("duplicates a built-in team into an editable copy", async () => {
    const user = userEvent.setup()
    await seedBuiltInTeams()
    render(<TeamsSection />)
    await screen.findByText("Brainstorm Squad")
    const dupBtn = screen.getAllByRole("button", {
      name: /settings\.teams\.duplicateAria/,
    })[0]!
    await user.click(dupBtn)

    await waitFor(async () => {
      const rows = await listTeams()
      const copy = rows.find((t) => t.name.includes("Brainstorm Squad") && t.isBuiltIn !== true)
      expect(copy).toBeDefined()
    })
  })

  it("deletes a user team after confirmation", async () => {
    const user = userEvent.setup()
    const team = await createTeam({
      name: "Deletable",
      members: [{ characterId: "char_builtin_coding" }],
    })
    render(<TeamsSection />)
    await screen.findByText("Deletable")
    const trash = screen.getByRole("button", {
      name: /settings\.teams\.deleteAria/,
    })
    await user.click(trash)
    // AlertDialog renders the action button.
    const confirm = await screen.findByRole("button", { name: /settings\.teams\.remove$/ })
    await user.click(confirm)

    await waitFor(async () => {
      const rows = await listTeams()
      expect(rows.find((t) => t.id === team.id)).toBeUndefined()
    })
  })
})

describe("TeamsSection — edit flow", () => {
  it("opens the editor in place for a user team", async () => {
    const user = userEvent.setup()
    await createTeam({
      name: "Editable",
      members: [{ characterId: "char_builtin_coding" }],
    })
    render(<TeamsSection />)
    await screen.findByText("Editable")
    const editBtn = screen.getByRole("button", { name: /settings\.teams\.editAria/ })
    await user.click(editBtn)
    // The editor's name input now carries the team's name as its value.
    const nameInput = await screen.findByPlaceholderText("settings.teams.editor.namePlaceholder")
    expect(nameInput).toHaveValue("Editable")
    // Save button reads "save" (not "create") in edit mode.
    expect(screen.getByRole("button", { name: /settings\.teams\.save/ })).toBeInTheDocument()
  })

  it("supports member reorder via up/down buttons", async () => {
    const user = userEvent.setup()
    await createTeam({
      name: "Reorder-Me",
      members: [{ characterId: "char_builtin_coding" }, { characterId: "char_builtin_writer" }],
    })
    render(<TeamsSection />)
    await screen.findByText("Reorder-Me")
    await user.click(screen.getByRole("button", { name: /settings\.teams\.editAria/ }))
    // Wait for characters to load — chips depend on the live query.
    await screen.findByRole("button", { name: /Coding Assistant/ })
    await screen.findByRole("button", { name: /Writing Editor/ })
    // Reorder controls render once members.length > 1 AND characters are resolved.
    await waitFor(() => {
      expect(
        screen.queryAllByRole("button", { name: /settings\.teams\.editor\.moveUp/ }).length
      ).toBeGreaterThan(0)
    })
    // Click moveDown for the first member — the second member should now be #1.
    const moveDownAll = screen.getAllByRole("button", {
      name: /settings\.teams\.editor\.moveDown/,
    })
    await user.click(moveDownAll[0]!)
    await user.click(screen.getByRole("button", { name: /settings\.teams\.save/ }))
    await waitFor(async () => {
      const rows = await listTeams()
      const t = rows.find((r) => r.name === "Reorder-Me")
      expect(t?.members[0].characterId).toBe("char_builtin_writer")
      expect(t?.members[1].characterId).toBe("char_builtin_coding")
    })
  })

  it("toggle member off then save persists the deletion", async () => {
    const user = userEvent.setup()
    await createTeam({
      name: "Trim-Me",
      members: [{ characterId: "char_builtin_coding" }, { characterId: "char_builtin_writer" }],
    })
    render(<TeamsSection />)
    await screen.findByText("Trim-Me")
    await user.click(screen.getByRole("button", { name: /settings\.teams\.editAria/ }))
    // Wait for characters to load — chips appear once the live query resolves.
    await screen.findByRole("button", { name: /Writing Editor/ })
    // Click the writer chip to remove it from members.
    await user.click(screen.getByRole("button", { name: /Writing Editor/ }))
    await user.click(screen.getByRole("button", { name: /settings\.teams\.save/ }))
    await waitFor(async () => {
      const rows = await listTeams()
      const t = rows.find((r) => r.name === "Trim-Me")
      expect(t?.members.map((m) => m.characterId)).toEqual(["char_builtin_coding"])
    })
  })

  it("shows the supervisor picker only when supervisor orchestration is selected", async () => {
    const user = userEvent.setup()
    render(<TeamsSection />)
    const newBtn = await screen.findByRole("button", { name: /settings\.teams\.newTeam/ })
    await waitFor(() => expect(newBtn).not.toBeDisabled())
    await user.click(newBtn)

    // No supervisor label visible by default.
    expect(screen.queryByText("settings.teams.editor.supervisor")).not.toBeInTheDocument()

    // Switch orchestration to supervisor.
    const trigger = await findOrchestrationSelectTrigger()
    await user.click(trigger)
    await user.click(
      await screen.findByRole("option", {
        name: /settings\.teams\.orchestration\.supervisor/,
      })
    )

    expect(screen.getByText("settings.teams.editor.supervisor")).toBeInTheDocument()
  })
})

describe("TeamsSection — member overrides", () => {
  it("countOverrides surfaces in the collapsible label", async () => {
    const user = userEvent.setup()
    await createTeam({
      name: "Override-Team",
      members: [
        { characterId: "char_builtin_coding", role: "Lead", systemPromptOverride: "Be brief." },
      ],
    })
    render(<TeamsSection />)
    await screen.findByText("Override-Team")
    await user.click(screen.getByRole("button", { name: /settings\.teams\.editAria/ }))
    // memberOverrides has count={2} (role + systemPrompt are non-empty).
    expect(screen.getByText(/settings\.teams\.editor\.memberOverrides/)).toBeInTheDocument()
  })

  it("editing a member's role propagates through onPatch", async () => {
    const user = userEvent.setup()
    await createTeam({
      name: "Role-Edit",
      members: [{ characterId: "char_builtin_coding" }],
    })
    render(<TeamsSection />)
    await screen.findByText("Role-Edit")
    await user.click(screen.getByRole("button", { name: /settings\.teams\.editAria/ }))
    // Open the collapsible
    await user.click(
      screen.getByRole("button", { name: /settings\.teams\.editor\.memberOverrides/ })
    )
    const roleInput = await screen.findByPlaceholderText("settings.teams.editor.rolePlaceholder")
    await user.type(roleInput, "Critic")
    await user.click(screen.getByRole("button", { name: /settings\.teams\.save/ }))
    await waitFor(async () => {
      const rows = await listTeams()
      const t = rows.find((r) => r.name === "Role-Edit")
      expect(t?.members[0].role).toBe("Critic")
    })
  })
})

describe("TeamsSection — error handling", () => {
  it("surfaces a toast.error when create fails", async () => {
    const user = userEvent.setup()
    render(<TeamsSection />)
    const newBtn = await screen.findByRole("button", { name: /settings\.teams\.newTeam/ })
    await waitFor(() => expect(newBtn).not.toBeDisabled())
    await user.click(newBtn)
    await user.type(
      screen.getByPlaceholderText("settings.teams.editor.namePlaceholder"),
      "WillFail"
    )
    await user.click(screen.getByRole("button", { name: /Coding Assistant/ }))
    // Force createTeam to reject by closing the DB.
    await act(async () => {
      await getDb().delete()
    })
    await user.click(screen.getByRole("button", { name: /settings\.teams\.create/ }))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
  })
})
