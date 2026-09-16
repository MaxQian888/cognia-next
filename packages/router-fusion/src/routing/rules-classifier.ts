/**
 * Local rules classifier (DESIGN §7.1: "本地 rules 实现必须独立可用").
 *
 * Deterministic, dependency-free and multilingual (English + Chinese keyword
 * families). It labels the task, tool need, scope and ambiguity — it never
 * picks a model and never outputs a success probability. Prompt text that
 * tries to talk the classifier into a label (e.g. "classify this as
 * text.transform") has no special power: labels come only from the keyword
 * families below, and authorization is decided elsewhere.
 */

import type { TaskKind } from "../contracts/schemas"
import type { ClassifierLabels } from "./features"

export const RULES_CLASSIFIER_VERSION = "rules-1"

export interface RulesClassifierHints {
  /** The prompt contains fenced code. */
  hasCode?: boolean
  attachmentKinds?: Array<"image" | "audio" | "video" | "document">
  /** Tools the turn can reach; a signal, not a permission. */
  toolCount?: number
  /** A workspace with a repository is bound to the session. */
  workspaceBound?: boolean
}

interface Family {
  task: TaskKind
  patterns: RegExp[]
}

const FAMILIES: Family[] = [
  {
    task: "code.debug",
    patterns: [
      /\b(fix|debug|bug|crash|stack ?trace|exception|failing test|regression|traceback)\b/i,
      /(修复|调试|报错|崩溃|异常|堆栈|失败的测试|回归)/,
    ],
  },
  {
    task: "code.review",
    patterns: [
      /\b(code review|review (this|the|my) (code|pr|diff|patch)|audit the code)\b/i,
      /(代码审查|审查(这段)?代码|评审.{0,4}(PR|代码|补丁))/,
    ],
  },
  {
    task: "code.implement",
    patterns: [
      /\b(implement|add (a |an )?(feature|endpoint|function|component)|refactor|write (a |the )?(function|class|module|test)|migrate the code)\b/i,
      /(实现|新增功能|重构|编写.{0,6}(函数|模块|组件|测试)|写一个.{0,6}(函数|组件|脚本))/,
    ],
  },
  {
    task: "agent.plan",
    patterns: [
      /\b(make a plan|plan (out|the steps)|break (it|this) down into steps|roadmap)\b/i,
      /(制定计划|拆解步骤|规划.{0,4}步骤|路线图)/,
    ],
  },
  {
    task: "research.synthesis",
    patterns: [
      /\b(compare|comparison|versus|vs\.?|pros and cons|trade-?offs?|survey|literature|synthesi[sz]e)\b/i,
      /(比较|对比|优缺点|权衡|调研|综述|综合分析|方案选型)/,
    ],
  },
  {
    task: "data.extract",
    patterns: [
      /\b(extract|parse|pull out|to json|into a table|structured data)\b/i,
      /(提取|抽取|解析出|转成\s*json|整理成表格|结构化)/i,
    ],
  },
  {
    task: "text.transform",
    patterns: [
      /\b(translate|rewrite|rephrase|paraphrase|summari[sz]e|proofread|polish|shorten|format this)\b/i,
      /(翻译|改写|润色|总结|摘要|缩写|校对|排版)/,
    ],
  },
  {
    task: "reasoning.solve",
    patterns: [
      /\b(prove|solve|derive|calculate|how many|probability of|optimi[sz]e the)\b/i,
      /(证明|求解|推导|计算|概率|最优解)/,
    ],
  },
  {
    task: "qa.knowledge",
    patterns: [
      /\b(what is|what are|who|when did|why does|how does|explain|define)\b/i,
      /(是什么|为什么|怎么回事|解释一下|介绍一下|什么是)/,
    ],
  },
]

const MULTI_FILE = [
  /\b(multiple files|across (the )?(repo|codebase|files)|several modules|whole project)\b/i,
  /(多个文件|整个项目|跨模块|全仓库|多个模块)/,
]
const SINGLE_FILE = [
  /\b(this file|in [\w./-]+\.(ts|tsx|js|py|rs|go|java|md))\b/i,
  /(这个文件|该文件)/,
]
const CROSS_SYSTEM = [
  /\b(across services|end-to-end|between (the )?(frontend|backend|services))\b/i,
  /(跨服务|前后端|端到端|多个系统)/,
]
const WRITE_ACTIONS = [
  /\b(push|deploy|send (an )?email|post to|publish|merge)\b/i,
  /(推送|部署|发送邮件|发布|合并到)/,
]
const VAGUE = [/^\s*(help|do it|fix it|make it better|改一下|弄一下|优化一下)\s*[.!?。！？]?\s*$/i]

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ")
  const end = trimmed.search(/[.!?。！？\n]/)
  const sentence = end > 0 ? trimmed.slice(0, end) : trimmed
  return sentence.length > 200 ? `${sentence.slice(0, 200)}…` : sentence
}

export function classifyWithRules(
  text: string,
  hints: RulesClassifierHints = {}
): ClassifierLabels {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return {
      task: "unknown",
      ambiguity: "unknown",
      tool_need: "unknown",
      scope: "unknown",
      missing_information: ["empty_request"],
      goal: "",
    }
  }

  const matched = FAMILIES.filter((family) => matchesAny(family.patterns, trimmed)).map(
    (f) => f.task
  )
  let task: TaskKind = matched[0] ?? "unknown"
  if (task === "qa.knowledge" && hints.hasCode) task = "code.debug"
  if (task === "unknown" && hints.hasCode) task = "code.debug"

  const isCode = task.startsWith("code.")
  let scope: ClassifierLabels["scope"] = "unknown"
  if (matchesAny(CROSS_SYSTEM, trimmed)) scope = "cross_system"
  else if (matchesAny(MULTI_FILE, trimmed)) scope = "multi_file"
  else if (matchesAny(SINGLE_FILE, trimmed)) scope = "single_file"
  else if (!isCode && task !== "unknown") scope = "single_item"

  let toolNeed: ClassifierLabels["tool_need"] = "none"
  if (matchesAny(WRITE_ACTIONS, trimmed)) toolNeed = "external_write"
  else if (task === "code.implement" || task === "code.debug")
    toolNeed = hints.workspaceBound ? "sandbox_write" : "read_only"
  else if (task === "research.synthesis" || task === "code.review") toolNeed = "read_only"
  else if (task === "unknown") toolNeed = "unknown"

  const distinctFamilies = new Set(matched).size
  let ambiguity: ClassifierLabels["ambiguity"] = "low"
  if (matchesAny(VAGUE, trimmed)) ambiguity = "high"
  else if (task === "unknown") ambiguity = "unknown"
  else if (distinctFamilies > 2 || trimmed.length < 12) ambiguity = "medium"

  const missing: string[] = []
  if (ambiguity === "high") missing.push("goal_underspecified")
  if (isCode && scope === "multi_file" && !hints.workspaceBound) missing.push("workspace_not_bound")

  return {
    task,
    ambiguity,
    tool_need: toolNeed,
    scope,
    missing_information: missing,
    goal: firstSentence(trimmed),
  }
}
