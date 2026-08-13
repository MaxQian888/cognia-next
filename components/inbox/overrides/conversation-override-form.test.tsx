/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

  it("persists the per-conversation mute flag and clears it when toggled off", async () => {
    const onDone = jest.fn()
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_mute"
        sessionId="s_mute"
        onDone={onDone}
      />
    )
    fireEvent.click(screen.getByTestId("conv-override-muted"))
    fireEvent.click(screen.getByTestId("conv-override-save"))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const persisted = await getDb()
      .conversationOverrides.where("conversationKey")
      .equals("lark:lark-1:oc_mute")
      .first()
    expect(persisted?.muted).toBe(true)

    // Toggle back off from the persisted row → cleared (undefined, not false).
    const onDone2 = jest.fn()
    render(
      <ConversationOverrideForm
        key="second"
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_mute"
        sessionId="s_mute"
        initialRow={persisted}
        onDone={onDone2}
      />
    )
    const mutedSwitches = screen.getAllByTestId("conv-override-muted")
    fireEvent.click(mutedSwitches[mutedSwitches.length - 1])
    const saves = screen.getAllByTestId("conv-override-save")
    fireEvent.click(saves[saves.length - 1])
    await waitFor(() => expect(onDone2).toHaveBeenCalled())
    const cleared = await getDb()
      .conversationOverrides.where("conversationKey")
      .equals("lark:lark-1:oc_mute")
      .first()
    expect(cleared?.muted).toBeUndefined()
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

  it("renders inherited Character and target state when no initialRow is supplied", () => {
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_new"
        sessionId="s_new"
      />
    )
    expect(screen.getByTestId("conv-override-character-state")).toHaveTextContent("Inherit")
    expect(screen.queryByTestId("conv-override-character")).not.toBeInTheDocument()
    expect(screen.getByTestId("conv-override-target")).toHaveTextContent("Inherit")
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
      workflowId: "wf_seed",
      allowComputerUse: true,
      allowScheduleTools: true,
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
    expect(screen.getByTestId("conv-override-workflow")).toHaveValue("wf_seed")
    expect(screen.getByTestId("conv-override-cu")).toHaveAttribute("data-state", "checked")
    expect(screen.getByTestId("conv-override-schedule-tools")).toHaveAttribute(
      "data-state",
      "checked"
    )
    expect(screen.getByTestId("conv-override-pinned")).toHaveAttribute("data-state", "checked")
  })

  it("upserts a new row when Save is clicked", async () => {
    const user = userEvent.setup()
    const onDone = jest.fn()
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_persist"
        sessionId="s_persist"
        onDone={onDone}
      />
    )
    await user.click(screen.getByTestId("conv-override-character-state"))
    await user.click(screen.getByRole("option", { name: "Specific Character" }))
    fireEvent.change(screen.getByTestId("conv-override-character"), {
      target: { value: "char_bravo" },
    })
    fireEvent.change(screen.getByTestId("conv-override-provider"), {
      target: { value: "anthropic" },
    })
    await user.click(screen.getByTestId("conv-override-target"))
    await user.click(screen.getByRole("option", { name: "Agent Team" }))
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
    expect(persisted?.workflowId).toBeUndefined()
    expect(persisted?.workflowDisabled).toBe(true)
    expect(persisted?.proactivePush).toBe(true)
  })

  it("persists the explicit scheduler-tool opt-in", async () => {
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_schedule"
        sessionId="s_schedule"
      />
    )
    fireEvent.click(screen.getByTestId("conv-override-schedule-tools"))
    fireEvent.click(screen.getByTestId("conv-override-save"))
    await waitFor(async () => {
      const row = await getDb()
        .conversationOverrides.where("conversationKey")
        .equals("lark:lark-1:oc_schedule")
        .first()
      expect(row?.allowScheduleTools).toBe(true)
    })
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

  it("persists topic activation, queue/steer dispatch, and TTL overrides", async () => {
    const initial: ConversationOverrideRow = {
      id: "co-runtime",
      conversationKey: "lark:lark-1:oc_runtime:omt_1",
      sessionId: "s_runtime",
      inboundActivationPolicy: "mention_activates",
      activeRunDispatchMode: "steer",
      activationTtlMs: 24 * 3_600_000,
      createdAt: 0,
      updatedAt: 0,
    }
    await getDb().conversationOverrides.put(initial)
    const onDone = jest.fn()
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey={initial.conversationKey}
        sessionId={initial.sessionId}
        initialRow={initial}
        onDone={onDone}
      />
    )
    fireEvent.change(screen.getByTestId("behavior-ttl"), {
      target: { value: "48" },
    })
    fireEvent.click(screen.getByTestId("conv-override-save"))
    await waitFor(() => expect(onDone).toHaveBeenCalled())

    expect(await getDb().conversationOverrides.get(initial.id)).toMatchObject({
      inboundActivationPolicy: "mention_activates",
      activeRunDispatchMode: "steer",
      activationTtlMs: 48 * 3_600_000,
    })
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
    const user = userEvent.setup()
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey="lark:lark-1:oc_noempty"
        sessionId="s_noempty"
      />
    )
    await user.click(screen.getByTestId("conv-override-character-state"))
    await user.click(screen.getByRole("option", { name: "Specific Character" }))
    fireEvent.change(screen.getByTestId("conv-override-character"), {
      target: { value: "abc" },
    })
    fireEvent.click(screen.getByTestId("conv-override-cancel"))
    expect(await getDb().conversationOverrides.count()).toBe(0)
  })

  it("promotes supported explicit values without rewriting conversation overrides", async () => {
    await getDb().adapterInstances.put({
      id: "lark-1",
      type: "lark",
      displayName: "Bot",
      enabled: true,
      transportMode: "long-connection",
      settings: {},
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      defaultMode: "auto",
      createdAt: 0,
      updatedAt: 0,
    })
    const initial: ConversationOverrideRow = {
      id: "co-promote",
      conversationKey: "lark:lark-1:oc_promote",
      sessionId: "s_promote",
      mode: "manual",
      allowedBuiltInSkillIds: ["lark.calendar.*"],
      requireHitlForWrites: false,
      pinned: true,
      archived: true,
      slaResponseMinutes: 15,
      createdAt: 0,
      updatedAt: 0,
    }
    await getDb().conversationOverrides.put(initial)
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(true)
    render(
      <ConversationOverrideForm
        adapterId="lark-1"
        conversationKey={initial.conversationKey}
        sessionId={initial.sessionId}
        initialRow={initial}
      />
    )

    fireEvent.click(screen.getByTestId("conv-override-promote-to-adapter"))
    await waitFor(async () => {
      expect(await getDb().adapterInstances.get("lark-1")).toMatchObject({
        defaultMode: "manual",
        builtInSkillCeiling: ["lark.calendar.*"],
        requireHitlForWrites: false,
      })
    })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(await getDb().conversationOverrides.get(initial.id)).toEqual(initial)
    confirm.mockRestore()
  })
})
