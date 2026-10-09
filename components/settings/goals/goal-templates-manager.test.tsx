import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { GoalTemplate } from "@/types/goal"

// next-intl is globally mocked in jest.setup.ts (resolves keys against en.json).

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
// Writes delegate to the real Dexie helpers; a test can make one fail.
jest.mock("@/lib/db/goal-templates", () => {
  const actual = jest.requireActual("@/lib/db/goal-templates")
  return {
    ...actual,
    deleteGoalTemplate: jest.fn((id: string) => actual.deleteGoalTemplate(id)),
    upsertGoalTemplate: jest.fn((row: GoalTemplate) => actual.upsertGoalTemplate(row)),
    setTemplateFavorite: jest.fn((id: string, fav: boolean) => actual.setTemplateFavorite(id, fav)),
  }
})
// The quick-create dialog has its own suite; the stub shows what "Use" opens.
jest.mock("@/components/goal/goal-quick-create-dialog", () => ({
  GoalQuickCreateDialog: ({
    open,
    initialTemplateId,
    showTrigger,
    onOpenChange,
  }: {
    open?: boolean
    initialTemplateId?: string
    showTrigger?: boolean
    onOpenChange?: (open: boolean) => void
  }) =>
    open ? (
      <div
        data-testid="mock-quick-create"
        data-template-id={initialTemplateId}
        data-show-trigger={String(showTrigger)}
      >
        <button
          type="button"
          data-testid="mock-quick-create-close"
          onClick={() => onOpenChange?.(false)}
        />
      </div>
    ) : null,
}))

import { toast } from "sonner"
import {
  deleteGoalTemplate,
  listGoalTemplates,
  setTemplateFavorite,
  upsertGoalTemplate,
} from "@/lib/db/goal-templates"
import { GoalTemplatesManager } from "./goal-templates-manager"

const realUpsert = jest.requireActual("@/lib/db/goal-templates").upsertGoalTemplate as (
  row: GoalTemplate
) => Promise<void>

beforeEach(async () => {
  jest.clearAllMocks()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().goalTemplates.clear()
})

function tpl(over: Partial<GoalTemplate> = {}): GoalTemplate {
  const now = Date.now()
  return {
    id: "t1",
    title: "Existing",
    objectiveText: "do the thing",
    builtin: false,
    isFavorite: false,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

// `TooltipProvider` is mounted once in `app/layout.tsx`.
function renderManager() {
  return render(
    <TooltipProvider>
      <GoalTemplatesManager />
    </TooltipProvider>
  )
}

describe("GoalTemplatesManager", () => {
  it("shows the empty state when there are no templates", async () => {
    renderManager()
    expect(await screen.findByTestId("goal-templates-empty")).toBeInTheDocument()
  })

  it("renders a row per template, badging built-ins", async () => {
    await realUpsert(tpl({ id: "a", title: "Alpha" }))
    await realUpsert(tpl({ id: "b", title: "Beta", builtin: true, sortOrder: 1 }))
    renderManager()
    await waitFor(() => expect(screen.getAllByTestId("goal-template-row")).toHaveLength(2))
    const [alpha, beta] = screen.getAllByTestId("goal-template-row")
    expect(within(beta).getByText("Built-in")).toBeInTheDocument()
    expect(within(alpha).queryByText("Built-in")).not.toBeInTheDocument()
    // Built-ins cannot be deleted.
    expect(within(alpha).getByTestId("goal-template-delete")).toBeInTheDocument()
    expect(within(beta).queryByTestId("goal-template-delete")).not.toBeInTheDocument()
  })

  it("creates a new template through the inline editor and confirms with a toast", async () => {
    renderManager()
    fireEvent.click(screen.getByTestId("goal-template-new"))
    expect(screen.getByTestId("goal-template-new")).toBeDisabled()
    const save = screen.getByTestId("goal-template-save")
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByTestId("goal-template-title"), { target: { value: "Weekly" } })
    fireEvent.change(screen.getByTestId("goal-template-objective"), {
      target: { value: "summarise my week" },
    })
    fireEvent.click(save)
    await waitFor(async () => {
      const rows = await listGoalTemplates()
      expect(rows.some((r) => r.title === "Weekly" && !r.builtin)).toBe(true)
    })
    expect(toast.success).toHaveBeenCalledWith("Template saved")
    await waitFor(() =>
      expect(screen.queryByTestId("goal-template-editor")).not.toBeInTheDocument()
    )
  })

  it("keeps the editor open and reports a failed save", async () => {
    ;(upsertGoalTemplate as jest.Mock).mockRejectedValueOnce(new Error("quota exceeded"))
    renderManager()
    fireEvent.click(screen.getByTestId("goal-template-new"))
    fireEvent.change(screen.getByTestId("goal-template-title"), { target: { value: "Weekly" } })
    fireEvent.change(screen.getByTestId("goal-template-objective"), {
      target: { value: "summarise my week" },
    })
    fireEvent.click(screen.getByTestId("goal-template-save"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't save the template", {
        description: "quota exceeded",
      })
    )
    expect(screen.getByTestId("goal-template-editor")).toBeInTheDocument()
  })

  it("cancels the editor without saving", async () => {
    const user = userEvent.setup()
    renderManager()
    await user.click(screen.getByTestId("goal-template-new"))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByTestId("goal-template-editor")).not.toBeInTheDocument()
    expect(upsertGoalTemplate).not.toHaveBeenCalled()
  })

  it("clones (does not mutate) a built-in when edited", async () => {
    await realUpsert(tpl({ id: "builtin1", title: "Builtin", builtin: true }))
    renderManager()
    fireEvent.click(await screen.findByTestId("goal-template-edit"))
    expect(
      screen.getByText("Built-in templates aren't edited in place — saving creates your own copy.")
    ).toBeInTheDocument()
    fireEvent.change(screen.getByTestId("goal-template-title"), { target: { value: "My copy" } })
    fireEvent.click(screen.getByTestId("goal-template-save"))
    await waitFor(async () => {
      const rows = await listGoalTemplates()
      // Original built-in preserved + a new non-builtin clone exists.
      expect(rows.find((r) => r.id === "builtin1")?.title).toBe("Builtin")
      expect(rows.some((r) => r.title === "My copy" && !r.builtin)).toBe(true)
    })
  })

  it("edits a user template in place", async () => {
    await realUpsert(tpl({ id: "mine", title: "Mine" }))
    renderManager()
    fireEvent.click(await screen.findByTestId("goal-template-edit"))
    fireEvent.change(screen.getByTestId("goal-template-title"), { target: { value: "Renamed" } })
    fireEvent.click(screen.getByTestId("goal-template-save"))
    await waitFor(async () => {
      const rows = await listGoalTemplates()
      expect(rows.find((r) => r.id === "mine")?.title).toBe("Renamed")
    })
  })

  it("toggles favourite", async () => {
    await realUpsert(tpl({ id: "a", title: "Alpha" }))
    renderManager()
    const star = await screen.findByTestId("goal-template-favorite")
    expect(star).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(star)
    await waitFor(async () => {
      const rows = await listGoalTemplates()
      expect(rows.find((r) => r.id === "a")?.isFavorite).toBe(true)
    })
  })

  it("reports a failed favourite toggle", async () => {
    ;(setTemplateFavorite as jest.Mock).mockRejectedValueOnce(new Error("locked"))
    await realUpsert(tpl({ id: "a", title: "Alpha" }))
    renderManager()
    fireEvent.click(await screen.findByTestId("goal-template-favorite"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't save the template", {
        description: "locked",
      })
    )
  })

  it("opens New goal with the template picked when Use is pressed", async () => {
    const user = userEvent.setup()
    await realUpsert(tpl({ id: "a", title: "Alpha" }))
    renderManager()
    expect(screen.queryByTestId("mock-quick-create")).not.toBeInTheDocument()
    await user.click(await screen.findByTestId("goal-template-use"))
    const dialog = screen.getByTestId("mock-quick-create")
    expect(dialog).toHaveAttribute("data-template-id", "a")
    expect(dialog).toHaveAttribute("data-show-trigger", "false")
    await user.click(screen.getByTestId("mock-quick-create-close"))
    expect(screen.queryByTestId("mock-quick-create")).not.toBeInTheDocument()
  })

  it("asks before deleting, and deletes only on confirm", async () => {
    const user = userEvent.setup()
    await realUpsert(tpl({ id: "a", title: "Alpha" }))
    renderManager()
    await user.click(await screen.findByTestId("goal-template-delete"))
    const dialog = await screen.findByTestId("goal-template-delete-dialog")
    expect(dialog).toHaveTextContent("“Alpha” will be removed.")
    expect(deleteGoalTemplate).not.toHaveBeenCalled()
    await user.click(screen.getByTestId("goal-template-delete-confirm"))
    await waitFor(async () => {
      const rows = await listGoalTemplates()
      expect(rows.find((r) => r.id === "a")).toBeUndefined()
    })
    await waitFor(() =>
      expect(screen.queryByTestId("goal-template-delete-dialog")).not.toBeInTheDocument()
    )
  })

  it("keeps the template when the delete is cancelled", async () => {
    const user = userEvent.setup()
    await realUpsert(tpl({ id: "a", title: "Alpha" }))
    renderManager()
    await user.click(await screen.findByTestId("goal-template-delete"))
    await user.click(await screen.findByRole("button", { name: "Cancel" }))
    expect(deleteGoalTemplate).not.toHaveBeenCalled()
    expect((await listGoalTemplates()).some((r) => r.id === "a")).toBe(true)
  })

  it("reports a failed delete with a toast", async () => {
    const user = userEvent.setup()
    ;(deleteGoalTemplate as jest.Mock).mockRejectedValueOnce(new Error("disk unavailable"))
    await realUpsert(tpl({ id: "a", title: "Alpha" }))
    renderManager()
    await user.click(await screen.findByTestId("goal-template-delete"))
    await user.click(await screen.findByTestId("goal-template-delete-confirm"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't delete the template", {
        description: "disk unavailable",
      })
    )
    expect((await listGoalTemplates()).some((r) => r.id === "a")).toBe(true)
  })
})
