/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { ConversationOverrideForm } from "./conversation-override-form"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("ConversationOverrideForm", () => {
  it("toggles quiet hours into the persisted row", async () => {
    const onDone = jest.fn()
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_quiet"
        sessionId="s_quiet"
        onDone={onDone}
      />
    )
    fireEvent.click(screen.getByTestId("conv-override-quiet-enabled"))
    fireEvent.change(screen.getByTestId("conv-override-quiet-from"), {
      target: { value: "23:00" },
    })
    fireEvent.change(screen.getByTestId("conv-override-quiet-to"), {
      target: { value: "07:00" },
    })
    fireEvent.change(screen.getByTestId("conv-override-quiet-tz"), {
      target: { value: "Asia/Shanghai" },
    })
    fireEvent.click(screen.getByTestId("conv-override-save"))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const persisted = await getDb()
      .conversationOverrides.where("conversationKey")
      .equals("lark:lark-1:oc_quiet")
      .first()
    expect(persisted?.quietHours).toEqual({
      from: "23:00",
      to: "07:00",
      tz: "Asia/Shanghai",
    })
  })

  it("clears quiet hours when toggle is off on save", async () => {
    const initial: ConversationOverrideRow = {
      id: "co-existing",
      conversationKey: "lark:lark-1:oc_quiet_clear",
      sessionId: "s_quiet_clear",
      quietHours: { from: "22:00", to: "08:00", tz: "UTC" },
      createdAt: 0,
      updatedAt: 0,
    }
    await getDb().conversationOverrides.add(initial)
    const onDone = jest.fn()
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_quiet_clear"
        sessionId="s_quiet_clear"
        initialRow={initial}
        onDone={onDone}
      />
    )
    fireEvent.click(screen.getByTestId("conv-override-quiet-enabled"))
    fireEvent.click(screen.getByTestId("conv-override-save"))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const persisted = await getDb()
      .conversationOverrides.where("conversationKey")
      .equals("lark:lark-1:oc_quiet_clear")
      .first()
    expect(persisted?.quietHours).toBeUndefined()
  })

  it("persists whitelisted skill ids and clears them when toggling back to inherit", async () => {
    const onDone = jest.fn()
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_skills"
        sessionId="s_skills"
        onDone={onDone}
      />
    )
    fireEvent.click(screen.getByTestId("conv-override-skills-whitelist"))
    fireEvent.change(screen.getByTestId("conv-override-skills-input"), {
      target: { value: "lark.calendar.list_events" },
    })
    fireEvent.keyDown(screen.getByTestId("conv-override-skills-input"), { key: "Enter" })
    fireEvent.click(screen.getByTestId("conv-override-save"))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const persisted = await getDb()
      .conversationOverrides.where("conversationKey")
      .equals("lark:lark-1:oc_skills")
      .first()
    expect(persisted?.allowedBuiltInSkillIds).toEqual(["lark.calendar.list_events"])
  })

  it("HITL switch defaults on and persists false when turned off", async () => {
    const onDone = jest.fn()
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_hitl"
        sessionId="s_hitl"
        onDone={onDone}
      />
    )
    // The switch starts in the on (checked) state.
    expect(screen.getByTestId("conv-override-hitl")).toHaveAttribute("data-state", "checked")
    fireEvent.click(screen.getByTestId("conv-override-hitl"))
    fireEvent.click(screen.getByTestId("conv-override-save"))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const persisted = await getDb()
      .conversationOverrides.where("conversationKey")
      .equals("lark:lark-1:oc_hitl")
      .first()
    expect(persisted?.requireHitlForWrites).toBe(false)
  })

  it("renders empty form when no initialRow is supplied", () => {
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_new"
        sessionId="s_new"
      />
    )
    expect(screen.getByTestId("conv-override-character")).toHaveValue("")
    expect(screen.getByTestId("conv-override-provider")).toHaveValue("")
    expect(screen.getByTestId("conv-override-model")).toHaveValue("")
  })

  it("seeds fields from initialRow", () => {
    const initialRow: ConversationOverrideRow = {
      id: "co-seed",
      conversationKey: "lark:lark-1:oc_seed",
      sessionId: "s_seed",
      mode: "manual",
      characterId: "char_alpha",
      allowComputerUse: true,
      providerOverride: "codex",
      modelOverride: "gpt-5",
      pinned: true,
      archived: false,
      createdAt: 0,
      updatedAt: 0,
    }
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_seed"
        sessionId="s_seed"
        initialRow={initialRow}
      />
    )
    expect(screen.getByTestId("conv-override-character")).toHaveValue("char_alpha")
    expect(screen.getByTestId("conv-override-provider")).toHaveValue("codex")
    expect(screen.getByTestId("conv-override-model")).toHaveValue("gpt-5")
    expect(screen.getByTestId("conv-override-cu")).toHaveAttribute("data-state", "checked")
    expect(screen.getByTestId("conv-override-pinned")).toHaveAttribute("data-state", "checked")
  })

  it("upserts a new row when Save is clicked", async () => {
    const onDone = jest.fn()
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_persist"
        sessionId="s_persist"
        onDone={onDone}
      />
    )
    fireEvent.change(screen.getByTestId("conv-override-character"), {
      target: { value: "char_bravo" },
    })
    fireEvent.change(screen.getByTestId("conv-override-provider"), {
      target: { value: "anthropic" },
    })
    fireEvent.change(screen.getByTestId("conv-override-team"), {
      target: { value: "team_research" },
    })
    fireEvent.click(screen.getByTestId("conv-override-proactive"))
    fireEvent.click(screen.getByTestId("conv-override-save"))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const persisted = await getDb()
      .conversationOverrides.where("conversationKey")
      .equals("lark:lark-1:oc_persist")
      .first()
    expect(persisted?.characterId).toBe("char_bravo")
    expect(persisted?.providerOverride).toBe("anthropic")
    expect(persisted?.teamId).toBe("team_research")
    expect(persisted?.proactivePush).toBe(true)
  })

  it("persists the response-SLA minutes from the form", async () => {
    const onDone = jest.fn()
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_sla"
        sessionId="s_sla"
        onDone={onDone}
      />
    )
    fireEvent.change(screen.getByTestId("conv-override-sla"), { target: { value: "45" } })
    fireEvent.click(screen.getByTestId("conv-override-save"))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const persisted = await getDb()
      .conversationOverrides.where("conversationKey")
      .equals("lark:lark-1:oc_sla")
      .first()
    expect(persisted?.slaResponseMinutes).toBe(45)
  })

  it("updates an existing row in place (no second row created)", async () => {
    await getDb().conversationOverrides.put({
      id: "co-existing",
      conversationKey: "lark:lark-1:oc_existing",
      sessionId: "s_existing",
      providerOverride: "old",
      createdAt: 0,
      updatedAt: 0,
    })
    const existing = await getDb().conversationOverrides.get("co-existing")
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_existing"
        sessionId="s_existing"
        initialRow={existing}
      />
    )
    fireEvent.change(screen.getByTestId("conv-override-provider"), {
      target: { value: "new" },
    })
    fireEvent.click(screen.getByTestId("conv-override-save"))
    await waitFor(async () => {
      const refreshed = await getDb().conversationOverrides.get("co-existing")
      expect(refreshed?.providerOverride).toBe("new")
    })
    expect(await getDb().conversationOverrides.count()).toBe(1)
  })

  it("Delete-Override button removes the existing row", async () => {
    await getDb().conversationOverrides.put({
      id: "co-delete",
      conversationKey: "lark:lark-1:oc_delete",
      sessionId: "s_delete",
      createdAt: 0,
      updatedAt: 0,
    })
    const onDone = jest.fn()
    const initialRow = (await getDb().conversationOverrides.get("co-delete"))!
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_delete"
        sessionId="s_delete"
        initialRow={initialRow}
        onDone={onDone}
      />
    )
    fireEvent.click(screen.getByTestId("conv-override-delete"))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(await getDb().conversationOverrides.get("co-delete")).toBeUndefined()
  })

  it("Cancel button invokes onCancel without persisting changes", () => {
    const onCancel = jest.fn()
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_cancel"
        sessionId="s_cancel"
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByTestId("conv-override-cancel"))
    expect(onCancel).toHaveBeenCalled()
  })

  it("never writes a row on Cancel without prior Save", async () => {
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_noempty"
        sessionId="s_noempty"
      />
    )
    fireEvent.change(screen.getByTestId("conv-override-character"), {
      target: { value: "abc" },
    })
    fireEvent.click(screen.getByTestId("conv-override-cancel"))
    expect(await getDb().conversationOverrides.count()).toBe(0)
  })
})
