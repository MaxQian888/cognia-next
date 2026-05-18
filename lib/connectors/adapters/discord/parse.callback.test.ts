/**
 * Tests for Discord parser additions in G3.2:
 *   - reactionToEvent (MESSAGE_REACTION_ADD / REMOVE)
 *   - parseDiscordInteraction (button / select / modal_submit)
 *   - media attachment widening (voice / video / sticker)
 */

import { parseDiscordDispatch, parseDiscordInteraction } from "./parse"
import type { DiscordDispatch } from "./parse"

const ADAPTER_ID = "dc-1"
const SELF_ID = "BOT_SELF"

describe("MESSAGE_REACTION_ADD / REMOVE", () => {
  it("REACTION_ADD → system event tagged reaction_added", () => {
    const dispatch: DiscordDispatch = {
      t: "MESSAGE_REACTION_ADD",
      op: 0,
      d: {
        user_id: "U_99",
        channel_id: "C_x",
        message_id: "M_77",
        emoji: { id: null, name: "👍" },
      },
    }
    const evt = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)
    expect(evt!.kind).toBe("system")
    expect(evt!.systemKind).toBe("reaction_added")
    expect(evt!.replacesMessageId).toBe("M_77")
    expect((evt!.segments[0] as { code: string }).code).toBe("👍")
  })

  it("REACTION_REMOVE → system event tagged reaction_removed", () => {
    const dispatch: DiscordDispatch = {
      t: "MESSAGE_REACTION_REMOVE",
      op: 0,
      d: {
        user_id: "U_99",
        channel_id: "C_x",
        message_id: "M_77",
        emoji: { id: "EMOJI_ID", name: "custom_emoji" },
      },
    }
    const evt = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)
    expect(evt!.systemKind).toBe("reaction_removed")
    // Custom emoji id is preserved via `custom:` prefix.
    expect((evt!.segments[0] as { code: string }).code).toBe("custom:EMOJI_ID")
  })
})

describe("attachment widening", () => {
  it("voice attachment → voice segment with durationSec", () => {
    const dispatch: DiscordDispatch = {
      t: "MESSAGE_CREATE",
      op: 0,
      d: {
        id: "M",
        content: "",
        channel_id: "C",
        author: { id: "U", username: "A" },
        timestamp: "2025-01-01T00:00:00.000Z",
        attachments: [
          {
            id: "a1",
            filename: "voice.ogg",
            url: "https://cdn/voice.ogg",
            content_type: "audio/ogg",
            duration_secs: 7,
          },
        ],
        mentions: [],
      },
    }
    const evt = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)
    expect(evt!.segments[0]).toMatchObject({ type: "voice", durationSec: 7 })
  })

  it("video attachment → video segment", () => {
    const dispatch: DiscordDispatch = {
      t: "MESSAGE_CREATE",
      op: 0,
      d: {
        id: "M",
        content: "",
        channel_id: "C",
        author: { id: "U", username: "A" },
        timestamp: "2025-01-01T00:00:00.000Z",
        attachments: [
          {
            id: "a1",
            filename: "clip.mp4",
            url: "https://cdn/clip.mp4",
            content_type: "video/mp4",
          },
        ],
        mentions: [],
      },
    }
    const evt = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)
    expect(evt!.segments[0]).toMatchObject({ type: "video", url: "https://cdn/clip.mp4" })
  })

  it("sticker_items → emoji segments with sticker name", () => {
    const dispatch: DiscordDispatch = {
      t: "MESSAGE_CREATE",
      op: 0,
      d: {
        id: "M",
        content: "",
        channel_id: "C",
        author: { id: "U", username: "A" },
        timestamp: "2025-01-01T00:00:00.000Z",
        attachments: [],
        mentions: [],
        sticker_items: [{ id: "s1", name: "rocket" }],
      },
    }
    const evt = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)
    expect(evt!.segments[0]).toEqual({ type: "emoji", code: "rocket" })
  })
})

describe("parseDiscordInteraction", () => {
  it("button press → ConnectorCallbackEvent with actionType=button", () => {
    const dispatch: DiscordDispatch = {
      t: "INTERACTION_CREATE",
      op: 0,
      d: {
        type: 3,
        id: "INT_1",
        application_id: "APP",
        token: "TOK",
        channel_id: "C_xyz",
        user: { id: "U_press", username: "Bob" },
        message: { id: "M_origin" },
        data: { custom_id: "a2ui:sfc:btn:confirm", component_type: 2 },
      },
    }
    const cb = parseDiscordInteraction(ADAPTER_ID, SELF_ID, dispatch)
    expect(cb!.actionType).toBe("button")
    expect(cb!.value).toBe("a2ui:sfc:btn:confirm")
    expect(cb!.triggerId).toBe("a2ui:sfc:btn:confirm")
    expect(cb!.user.remoteUserId).toBe("U_press")
    expect(cb!.originatingMessageId).toBe("M_origin")
  })

  it("select menu → actionType=select with first value", () => {
    const dispatch: DiscordDispatch = {
      t: "INTERACTION_CREATE",
      op: 0,
      d: {
        type: 3,
        id: "INT_2",
        application_id: "APP",
        token: "TOK",
        channel_id: "C_xyz",
        user: { id: "U", username: "A" },
        data: { custom_id: "a2ui:sfc:sel:select", component_type: 3, values: ["alpha", "beta"] },
      },
    }
    const cb = parseDiscordInteraction(ADAPTER_ID, SELF_ID, dispatch)
    expect(cb!.actionType).toBe("select")
    expect(cb!.value).toBe("alpha")
    expect(cb!.payload).toEqual({ values: ["alpha", "beta"] })
  })

  it("modal_submit → actionType=submit with full payload", () => {
    const dispatch: DiscordDispatch = {
      t: "INTERACTION_CREATE",
      op: 0,
      d: {
        type: 5,
        id: "INT_3",
        application_id: "APP",
        token: "TOK",
        channel_id: "C_xyz",
        user: { id: "U", username: "A" },
        data: {
          custom_id: "a2ui:sfc:modal:submit",
          components: [
            {
              components: [
                { custom_id: "name", value: "Alice" },
                { custom_id: "role", value: "admin" },
              ],
            },
          ],
        },
      },
    }
    const cb = parseDiscordInteraction(ADAPTER_ID, SELF_ID, dispatch)
    expect(cb!.actionType).toBe("submit")
    expect(cb!.payload).toEqual({ name: "Alice", role: "admin" })
  })

  it("returns null for application commands (type 2)", () => {
    const dispatch: DiscordDispatch = {
      t: "INTERACTION_CREATE",
      op: 0,
      d: {
        type: 2,
        id: "INT",
        application_id: "APP",
        token: "TOK",
        channel_id: "C",
        user: { id: "U", username: "A" },
      },
    }
    expect(parseDiscordInteraction(ADAPTER_ID, SELF_ID, dispatch)).toBeNull()
  })

  it("returns null when dispatch type isn't INTERACTION_CREATE", () => {
    const dispatch: DiscordDispatch = {
      t: "MESSAGE_CREATE",
      op: 0,
      d: { id: "M", content: "x" },
    }
    expect(parseDiscordInteraction(ADAPTER_ID, SELF_ID, dispatch)).toBeNull()
  })
})
