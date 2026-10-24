import type { ConnectorCallbackDecision } from "@/types/connectors/interaction"
import { larkCallbackToast } from "./callback-toast"

describe("larkCallbackToast", () => {
  it.each<[ConnectorCallbackDecision, string, string, string]>([
    [
      { status: "accepted", kind: "tool_approve", decision: "allow" },
      "success",
      "已允许",
      "Approved",
    ],
    [{ status: "accepted", kind: "tool_approve", decision: "deny" }, "info", "已拒绝", "Declined"],
    [
      { status: "accepted", kind: "tool_approve", decision: "allow_session" },
      "success",
      "本会话已允许",
      "Allowed for this session",
    ],
    [
      { status: "accepted", kind: "tool_approve", decision: "allow_request" },
      "success",
      "本次请求内已允许",
      "Allowed for this request",
    ],
    [{ status: "accepted", kind: "plan_approve", action: "cancel" }, "info", "已取消", "Cancelled"],
    [
      { status: "accepted", kind: "plan_approve", action: "approve" },
      "success",
      "已允许",
      "Approved",
    ],
    [{ status: "accepted", kind: "wf_approve" }, "success", "已允许", "Approved"],
    [{ status: "accepted", kind: "wf_cancel" }, "info", "已取消", "Cancelled"],
    [{ status: "accepted", kind: "wf_fanout_approve" }, "success", "已允许", "Approved"],
    [{ status: "accepted", kind: "wf_fanout_cancel" }, "info", "已取消", "Cancelled"],
    [
      { status: "accepted", kind: "skill_invoke", action: "approve" },
      "success",
      "已允许",
      "Approved",
    ],
    [{ status: "accepted", kind: "run_control", action: "cancel" }, "success", "已发送", "Sent"],
    [
      { status: "accepted", kind: "generic" },
      "info",
      "已收到，正在处理…",
      "Got it, working on it…",
    ],
    [{ status: "deduped" }, "info", "已处理过了", "Already handled"],
    [{ status: "in_flight" }, "info", "正在处理中", "Still processing"],
    [
      { status: "expired" },
      "warning",
      "此卡片已失效，请重新发起",
      "This card has expired — please start again",
    ],
    [
      { status: "denied", reason: "actor" },
      "error",
      "你没有权限操作此卡片",
      "You can't act on this card",
    ],
    [
      { status: "failed" },
      "error",
      "处理失败，请稍后重试",
      "Something went wrong — please try again",
    ],
  ])("maps %j to bilingual feedback", (decision, type, zh_cn, en_us) => {
    expect(larkCallbackToast(decision)).toEqual({ type, content: zh_cn, i18n: { zh_cn, en_us } })
    expect(larkCallbackToast(decision, "en-US")).toEqual({
      type,
      content: en_us,
      i18n: { zh_cn, en_us },
    })
  })

  it.each([undefined, "", "zh-CN", "fr"])("defaults %s to Chinese", (locale) => {
    expect(larkCallbackToast({ status: "deduped" }, locale).content).toBe("已处理过了")
  })

  it.each(["en", "en_us", "EN-GB"])("recognizes English locale %s", (locale) => {
    expect(larkCallbackToast({ status: "deduped" }, locale).content).toBe("Already handled")
  })
})
