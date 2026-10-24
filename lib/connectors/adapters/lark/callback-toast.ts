/** Bilingual bot replies for Feishu's synchronous card callback response. */
import type { ConnectorCallbackDecision } from "@/types/connectors/interaction"
import { larkReplyLocale } from "./card-kit"

export interface LarkCallbackToast {
  type: "success" | "info" | "warning" | "error"
  content: string
  i18n: { zh_cn: string; en_us: string }
}

function toast(
  type: LarkCallbackToast["type"],
  zh_cn: string,
  en_us: string,
  locale?: string
): LarkCallbackToast {
  return {
    type,
    content: /^en(?:[-_]|$)/i.test(larkReplyLocale(undefined, locale)) ? en_us : zh_cn,
    i18n: { zh_cn, en_us },
  }
}

export function larkCallbackToast(
  decision: ConnectorCallbackDecision,
  locale?: string
): LarkCallbackToast {
  switch (decision.status) {
    case "deduped":
      return toast("info", "已处理过了", "Already handled", locale)
    case "in_flight":
      return toast("info", "正在处理中", "Still processing", locale)
    case "expired":
      return toast(
        "warning",
        "此卡片已失效，请重新发起",
        "This card has expired — please start again",
        locale
      )
    case "denied":
      return toast("error", "你没有权限操作此卡片", "You can't act on this card", locale)
    case "failed":
      return toast(
        "error",
        "处理失败，请稍后重试",
        "Something went wrong — please try again",
        locale
      )
    case "accepted":
      if (decision.kind === "run_control") {
        return toast("success", "已发送", "Sent", locale)
      }
      if (decision.decision === "allow_session") {
        return toast("success", "本会话已允许", "Allowed for this session", locale)
      }
      if (decision.decision === "allow_request") {
        return toast("success", "本次请求内已允许", "Allowed for this request", locale)
      }
      if (decision.decision === "deny") {
        return toast("info", "已拒绝", "Declined", locale)
      }
      if (
        decision.action === "cancel" ||
        decision.kind === "wf_cancel" ||
        decision.kind === "wf_fanout_cancel"
      ) {
        return toast("info", "已取消", "Cancelled", locale)
      }
      if (
        decision.decision === "allow" ||
        decision.action === "approve" ||
        decision.kind === "plan_approve" ||
        decision.kind === "tool_approve" ||
        decision.kind === "wf_approve" ||
        decision.kind === "wf_fanout_approve"
      ) {
        return toast("success", "已允许", "Approved", locale)
      }
      return toast("info", "已收到，正在处理…", "Got it, working on it…", locale)
  }
}
