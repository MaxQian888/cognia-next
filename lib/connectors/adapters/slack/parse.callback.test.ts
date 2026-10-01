/**
 * Tests for parseSlackInteractivePayload — block_actions /
 * view_submission / view_closed projection into ConnectorCallbackEvent.
 */

import { parseSlackInteractivePayload } from "./parse"
import type { SlackInteractivePayload } from "./parse"

const ADAPTER_ID = "adp_sl"
const SELF_ID = "U_BOT"

describe("parseSlackInteractivePayload", () => {
  it.each([
    ["multi_static_select", "selected_options", []],
    ["multi_static_select", "selected_options", [{ value: "one" }]],
    ["multi_external_select", "selected_options", [{ value: "one" }, { value: "two" }]],
    ["users_select", "selected_user", "U1"],
    ["channels_select", "selected_channel", "C1"],
    ["conversations_select", "selected_conversation", "D1"],
    ["multi_users_select", "selected_users", ["U1"]],
    ["multi_channels_select", "selected_channels", []],
    ["multi_conversations_select", "selected_conversations", ["C1", "D1"]],
  ])("preserves %s %s in both actions and modal submissions", (type, field, selected) => {
    const action = { type: type as string, action_id: "a", [field as string]: selected }
    const values = Array.isArray(selected)
      ? selected.map((entry) => (typeof entry === "string" ? entry : entry.value))
      : selected
    const callback = parseSlackInteractivePayload(ADAPTER_ID, SELF_ID, {
      type: "block_actions",
      user: { id: "U" },
      actions: [action],
    })
    expect(callback).toMatchObject({
      actionType: "select",
      value: Array.isArray(values) ? (values[0] ?? "") : values,
      ...(Array.isArray(values) ? { payload: { values } } : {}),
    })
    const submission = parseSlackInteractivePayload(ADAPTER_ID, SELF_ID, {
      type: "view_submission",
      user: { id: "U" },
      view: { id: "v", type: "modal", state: { values: { block: { a: action } } } },
    })
    expect(submission?.payload).toEqual({ a: values })
  })

  it("block_actions / button → actionType=button with action_id as triggerId", () => {
    const payload: SlackInteractivePayload = {
      type: "block_actions",
      user: { id: "U_press", username: "Alice" },
      channel: { id: "C_xyz" },
      container: { message_ts: "1700000000.000100", channel_id: "C_xyz" },
      actions: [{ action_id: "a2ui:sfc:btn:confirm", type: "button", value: "confirm" }],
    }
    const cb = parseSlackInteractivePayload(ADAPTER_ID, SELF_ID, payload)
    expect(cb!.actionType).toBe("button")
    expect(cb!.value).toBe("confirm")
    expect(cb!.triggerId).toBe("a2ui:sfc:btn:confirm")
    expect(cb!.conversationKey).toBe(`slack:${ADAPTER_ID}:C_xyz`)
    expect(cb!.originatingMessageId).toBe("1700000000.000100")
  })

  it("block_actions / static_select → actionType=select with selected_option.value", () => {
    const payload: SlackInteractivePayload = {
      type: "block_actions",
      user: { id: "U", username: "A" },
      channel: { id: "C" },
      container: { channel_id: "C" },
      actions: [
        {
          action_id: "a2ui:sfc:sel:pick",
          type: "static_select",
          selected_option: { value: "alpha" },
        },
      ],
    }
    const cb = parseSlackInteractivePayload(ADAPTER_ID, SELF_ID, payload)
    expect(cb!.actionType).toBe("select")
    expect(cb!.value).toBe("alpha")
  })

  it("datepicker → actionType=input with selected_date as value", () => {
    const payload: SlackInteractivePayload = {
      type: "block_actions",
      user: { id: "U" },
      channel: { id: "C" },
      container: { channel_id: "C" },
      actions: [
        {
          action_id: "a2ui:sfc:d:pick",
          type: "datepicker",
          selected_date: "2025-06-15",
        },
      ],
    }
    const cb = parseSlackInteractivePayload(ADAPTER_ID, SELF_ID, payload)
    expect(cb!.actionType).toBe("input")
    expect(cb!.value).toBe("2025-06-15")
  })

  it("view_submission → actionType=submit with flattened payload", () => {
    const payload: SlackInteractivePayload = {
      type: "view_submission",
      user: { id: "U" },
      view: {
        id: "V_1",
        type: "modal",
        callback_id: "a2ui:sfc:form:submit",
        state: {
          values: {
            blk_name: {
              "a2ui:sfc:name:input": { type: "plain_text_input", value: "Alice" },
            },
            blk_dt: {
              "a2ui:sfc:dt:input": { type: "datepicker", selected_date: "2025-01-01" },
            },
          },
        },
      },
    }
    const cb = parseSlackInteractivePayload(ADAPTER_ID, SELF_ID, payload)
    expect(cb!.actionType).toBe("submit")
    expect(cb!.triggerId).toBe("a2ui:sfc:form:submit")
    expect(cb!.payload).toEqual({
      "a2ui:sfc:name:input": "Alice",
      "a2ui:sfc:dt:input": "2025-01-01",
    })
  })

  it("view_closed → actionType=dismiss", () => {
    const payload: SlackInteractivePayload = {
      type: "view_closed",
      user: { id: "U" },
      view: { id: "V_2", type: "modal", callback_id: "a2ui:sfc:form:cancel" },
    }
    const cb = parseSlackInteractivePayload(ADAPTER_ID, SELF_ID, payload)
    expect(cb!.actionType).toBe("dismiss")
    expect(cb!.triggerId).toBe("a2ui:sfc:form:cancel")
  })

  it("returns null for unknown payload types", () => {
    const payload: SlackInteractivePayload = { type: "shortcut", user: { id: "U" } }
    expect(parseSlackInteractivePayload(ADAPTER_ID, SELF_ID, payload)).toBeNull()
  })
})

it("routes plain text changes as input callbacks", () => {
  const result = parseSlackInteractivePayload(ADAPTER_ID, SELF_ID, {
    type: "block_actions",
    user: { id: "U" },
    channel: { id: "C" },
    actions: [
      { action_id: "a2ui:s:field:input", type: "plain_text_input", value: "Updated value" },
    ],
  })
  expect(result).toMatchObject({ actionType: "input", value: "Updated value" })
})

it.each([{ selected_options: [] }, { selected_options: [{ value: "true" }] }])(
  "preserves checkbox selections $selected_options",
  ({ selected_options }) => {
    const result = parseSlackInteractivePayload(ADAPTER_ID, SELF_ID, {
      type: "block_actions",
      user: { id: "U" },
      channel: { id: "C" },
      actions: [{ action_id: "a2ui:s:check:change", type: "checkboxes", selected_options }],
    })
    expect(result).toMatchObject({
      actionType: "checkbox",
      value: selected_options[0]?.value ?? "",
      payload: { values: selected_options.map((option) => option.value) },
    })
  }
)

it.each([null, [], [{ value: "one" }], [{ value: "one" }, { value: "two" }]])(
  "preserves checkbox form state including cleared values: %j",
  (selected_options) => {
    const field = { type: "checkboxes", action_id: "checks", selected_options }
    const values = (selected_options ?? []).map((option) => option.value)
    const action = parseSlackInteractivePayload(ADAPTER_ID, SELF_ID, {
      type: "block_actions",
      user: { id: "U" },
      actions: [field],
    })
    expect(action).toMatchObject({
      actionType: "checkbox",
      value: values[0] ?? "",
      payload: { values },
    })
    const submit = parseSlackInteractivePayload(ADAPTER_ID, SELF_ID, {
      type: "view_submission",
      user: { id: "U" },
      view: { id: "v", type: "modal", state: { values: { b: { checks: field } } } },
    })
    expect(submit?.payload).toEqual({ checks: values })
  }
)
