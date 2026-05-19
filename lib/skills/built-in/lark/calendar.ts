/**
 * Lark Calendar skill family (ADR-0026).
 *
 * Wraps `lark-cli calendar` subcommands as built-in MCP tools.
 *
 *   - agenda_today      read       — quick "what's on my plate" summary
 *   - list_events       read       — paginated event list
 *   - freebusy          read       — busy windows for a set of users
 *   - search_rooms      read       — meeting room availability
 *   - create_event      write      — schedule a new event (HITL)
 *   - update_event      write      — edit existing event (HITL)
 *   - rsvp              write      — accept/decline an invitation (HITL)
 *   - book_room         write      — attach a room to an event (HITL)
 *   - delete_event      destructive— remove an event (opt-in + HITL)
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { argsToFlags, buildConfirmSurface, runLarkCli } from "./_helpers"

const FAMILY = "lark.calendar"
const PLATFORMS = ["lark"] as const

function mkRead<S extends z.ZodTypeAny>(input: {
  id: string
  mcpToolName: string
  label: { en: string; "zh-CN": string }
  description: { en: string; "zh-CN": string }
  schema: S
  subcommand: readonly string[]
  skipFlags?: readonly string[]
}): BuiltInSkill<S> {
  return {
    id: input.id,
    family: FAMILY,
    label: input.label,
    description: input.description,
    platforms: PLATFORMS,
    mutation: "read",
    imAccess: "always",
    mcpToolName: input.mcpToolName,
    inputSchema: input.schema,
    execute: async (args, ctx) =>
      runLarkCli({
        args: [
          ...input.subcommand,
          ...argsToFlags(args as Record<string, unknown>, input.skipFlags),
        ],
        confirmed: ctx.hitlBypass === true,
      }),
  }
}

function mkWrite<S extends z.ZodTypeAny>(input: {
  id: string
  mcpToolName: string
  label: { en: string; "zh-CN": string }
  description: { en: string; "zh-CN": string }
  schema: S
  subcommand: readonly string[]
  confirmSummary: (args: z.infer<S>) => {
    summary: string
    details?: { label: string; value: string }[]
  }
  confirmTitle: string
  mutation?: "write" | "destructive"
  imAccess?: "always" | "opt-in"
  skipFlags?: readonly string[]
}): BuiltInSkill<S> {
  return {
    id: input.id,
    family: FAMILY,
    label: input.label,
    description: input.description,
    platforms: PLATFORMS,
    mutation: input.mutation ?? "write",
    imAccess: input.imAccess ?? "always",
    mcpToolName: input.mcpToolName,
    inputSchema: input.schema,
    execute: async (args, ctx) =>
      runLarkCli({
        args: [
          ...input.subcommand,
          ...argsToFlags(args as Record<string, unknown>, input.skipFlags),
        ],
        confirmed: ctx.hitlBypass === true,
      }),
    hitlSurface: (args) => {
      const c = input.confirmSummary(args)
      return buildConfirmSurface({
        surfaceId: `sfc_${input.id.replace(/\./g, "_")}_${Date.now().toString(36)}`,
        title: input.confirmTitle,
        summary: c.summary,
        details: c.details,
      })
    },
  }
}

// ---- read skills ---------------------------------------------------------

registerBuiltInSkill(
  mkRead({
    id: "lark.calendar.agenda_today",
    mcpToolName: "lark_calendar_agenda_today",
    label: { en: "Today's agenda", "zh-CN": "今日日程" },
    description: {
      en: "Summarise the events on your calendar for today.",
      "zh-CN": "汇总今天日历上的全部日程。",
    },
    schema: z.object({}).strict(),
    subcommand: ["calendar", "+agenda"],
  })
)

registerBuiltInSkill(
  mkRead({
    id: "lark.calendar.list_events",
    mcpToolName: "lark_calendar_list_events",
    label: { en: "List events", "zh-CN": "列出日程" },
    description: {
      en: "Paginated list of events on a Lark calendar between two timestamps.",
      "zh-CN": "分页列出指定时间范围内的 Lark 日历事件。",
    },
    schema: z.object({
      calendarId: z.string().min(1).describe("Lark calendar id, e.g. primary"),
      startTime: z.string().optional().describe("RFC3339 start cutoff"),
      endTime: z.string().optional().describe("RFC3339 end cutoff"),
      pageSize: z.number().int().min(1).max(500).optional(),
    }),
    subcommand: ["calendar", "+list-events"],
  })
)

registerBuiltInSkill(
  mkRead({
    id: "lark.calendar.freebusy",
    mcpToolName: "lark_calendar_freebusy",
    label: { en: "Free/busy query", "zh-CN": "查询空闲" },
    description: {
      en: "Busy windows for a set of users between two timestamps.",
      "zh-CN": "查询一组用户在指定时间范围内的忙闲信息。",
    },
    schema: z.object({
      userIds: z.array(z.string()).min(1),
      startTime: z.string(),
      endTime: z.string(),
    }),
    subcommand: ["calendar", "+freebusy"],
  })
)

registerBuiltInSkill(
  mkRead({
    id: "lark.calendar.search_rooms",
    mcpToolName: "lark_calendar_search_rooms",
    label: { en: "Search meeting rooms", "zh-CN": "搜索会议室" },
    description: {
      en: "Find meeting rooms matching a query, optionally filtered by capacity or location.",
      "zh-CN": "按名称、容量或位置搜索会议室。",
    },
    schema: z.object({
      query: z.string().min(1),
      minCapacity: z.number().int().min(1).optional(),
      buildingId: z.string().optional(),
    }),
    subcommand: ["calendar", "+search-rooms"],
  })
)

// ---- write skills (HITL) -------------------------------------------------

registerBuiltInSkill(
  mkWrite({
    id: "lark.calendar.create_event",
    mcpToolName: "lark_calendar_create_event",
    label: { en: "Create event", "zh-CN": "创建日程" },
    description: {
      en: "Schedule a new Lark calendar event with optional attendees and room.",
      "zh-CN": "在 Lark 日历中创建新日程，可选邀请参会人和会议室。",
    },
    schema: z.object({
      calendarId: z.string().min(1),
      summary: z.string().min(1).describe("Event title"),
      startTime: z.string().describe("RFC3339 start"),
      endTime: z.string().describe("RFC3339 end"),
      attendees: z.array(z.string()).optional(),
      description: z.string().optional(),
      roomIds: z.array(z.string()).optional(),
    }),
    subcommand: ["calendar", "+create-event"],
    confirmTitle: "Create calendar event",
    confirmSummary: (args) => ({
      summary: `Create "${args.summary}" on calendar ${args.calendarId}.`,
      details: [
        { label: "When", value: `${args.startTime} → ${args.endTime}` },
        ...(args.attendees?.length
          ? [{ label: "Attendees", value: args.attendees.join(", ") }]
          : []),
        ...(args.roomIds?.length ? [{ label: "Rooms", value: args.roomIds.join(", ") }] : []),
      ],
    }),
  })
)

registerBuiltInSkill(
  mkWrite({
    id: "lark.calendar.update_event",
    mcpToolName: "lark_calendar_update_event",
    label: { en: "Update event", "zh-CN": "更新日程" },
    description: {
      en: "Edit fields on an existing Lark calendar event.",
      "zh-CN": "编辑一个已存在的 Lark 日程。",
    },
    schema: z.object({
      calendarId: z.string().min(1),
      eventId: z.string().min(1),
      summary: z.string().optional(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      description: z.string().optional(),
    }),
    subcommand: ["calendar", "+update-event"],
    confirmTitle: "Update calendar event",
    confirmSummary: (args) => ({
      summary: `Update event ${args.eventId} on calendar ${args.calendarId}.`,
      details: [
        ...(args.summary ? [{ label: "New title", value: args.summary }] : []),
        ...(args.startTime ? [{ label: "New start", value: args.startTime }] : []),
        ...(args.endTime ? [{ label: "New end", value: args.endTime }] : []),
      ],
    }),
  })
)

registerBuiltInSkill(
  mkWrite({
    id: "lark.calendar.rsvp",
    mcpToolName: "lark_calendar_rsvp",
    label: { en: "RSVP to event", "zh-CN": "回复日程邀请" },
    description: {
      en: "Accept, decline, or tentatively respond to a Lark calendar invitation.",
      "zh-CN": "对 Lark 日程邀请进行接受、拒绝或暂定回复。",
    },
    schema: z.object({
      calendarId: z.string().min(1),
      eventId: z.string().min(1),
      response: z.enum(["accept", "decline", "tentative"]),
    }),
    subcommand: ["calendar", "+rsvp"],
    confirmTitle: "Respond to invitation",
    confirmSummary: (args) => ({
      summary: `${args.response.toUpperCase()} the invitation to event ${args.eventId}.`,
    }),
  })
)

registerBuiltInSkill(
  mkWrite({
    id: "lark.calendar.book_room",
    mcpToolName: "lark_calendar_book_room",
    label: { en: "Book room", "zh-CN": "预定会议室" },
    description: {
      en: "Attach a meeting room to an existing event.",
      "zh-CN": "为已有日程预定会议室。",
    },
    schema: z.object({
      calendarId: z.string().min(1),
      eventId: z.string().min(1),
      roomId: z.string().min(1),
    }),
    subcommand: ["calendar", "+book-room"],
    confirmTitle: "Book meeting room",
    confirmSummary: (args) => ({
      summary: `Book room ${args.roomId} for event ${args.eventId}.`,
    }),
  })
)

// ---- destructive skills (opt-in + HITL) ----------------------------------

registerBuiltInSkill(
  mkWrite({
    id: "lark.calendar.delete_event",
    mcpToolName: "lark_calendar_delete_event",
    label: { en: "Delete event", "zh-CN": "删除日程" },
    description: {
      en: "Permanently delete a Lark calendar event. Cannot be undone.",
      "zh-CN": "永久删除 Lark 日程，无法撤销。",
    },
    schema: z.object({
      calendarId: z.string().min(1),
      eventId: z.string().min(1),
      notifyAttendees: z.boolean().optional(),
    }),
    subcommand: ["calendar", "+delete-event"],
    confirmTitle: "Delete calendar event",
    mutation: "destructive",
    imAccess: "opt-in",
    confirmSummary: (args) => ({
      summary: `Delete event ${args.eventId} on calendar ${args.calendarId}. This cannot be undone.`,
      details: args.notifyAttendees ? [{ label: "Notify attendees", value: "yes" }] : undefined,
    }),
  })
)
