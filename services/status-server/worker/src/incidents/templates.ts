/**
 * Bilingual text for automated incident updates.
 *
 * Automation states observed facts only: which component, how many
 * consecutive reference checks, how many independent observers agree. It
 * never names a cause; an operator adds context with a manual update.
 */

import type { ComponentId, IncidentImpact, LocalizedText } from "../../../../../lib/status/contract"

export const COMPONENT_LABELS: Readonly<Record<ComponentId, LocalizedText & { "zh-CN": string }>> =
  {
    signalingHttp: { en: "Signaling HTTP endpoint", "zh-CN": "信令 HTTP 端点" },
    signalingAuth: { en: "Signaling authentication", "zh-CN": "信令认证" },
    relayData: { en: "Relay data channel", "zh-CN": "中继数据通道" },
  }

export interface WitnessTally {
  /** Fresh non-reference witnesses. */
  total: number
  failing: number
  passing: number
}

export function automatedTitle(componentId: ComponentId, impact: IncidentImpact): LocalizedText {
  const label = COMPONENT_LABELS[componentId]
  if (impact === "partial_outage") {
    return {
      en: `${label.en}: partial outage detected`,
      "zh-CN": `${label["zh-CN"]}：检测到部分中断`,
    }
  }
  return { en: `${label.en}: outage detected`, "zh-CN": `${label["zh-CN"]}：检测到中断` }
}

function witnessSentence(tally: WitnessTally): LocalizedText {
  if (tally.total === 0) {
    return {
      en: "No independent observer has fresh results, so this is single-witness evidence.",
      "zh-CN": "目前没有其他观测点的新鲜结果，这是单一观测点的证据。",
    }
  }
  return {
    en: `${tally.failing} of ${tally.total} other fresh observers also report failures; ${tally.passing} report success.`,
    "zh-CN": `其他 ${tally.total} 个有新鲜结果的观测点中，${tally.failing} 个同样报告失败，${tally.passing} 个报告成功。`,
  }
}

export function openedMessage(
  componentId: ComponentId,
  failures: number,
  tally: WitnessTally
): LocalizedText {
  const label = COMPONENT_LABELS[componentId]
  const witness = witnessSentence(tally)
  return {
    en: `Automated monitoring observed ${failures} consecutive failed checks of the ${label.en} from the reference observer. ${witness.en} We are investigating.`,
    "zh-CN": `自动监测发现参考观测点对${label["zh-CN"]}的检查连续失败 ${failures} 次。${witness["zh-CN"]}我们正在调查。`,
  }
}

export function escalatedMessage(componentId: ComponentId, tally: WitnessTally): LocalizedText {
  const label = COMPONENT_LABELS[componentId]
  const witness = witnessSentence(tally)
  return {
    en: `No fresh observer reports success for the ${label.en} any more. ${witness.en} Impact raised to major outage.`,
    "zh-CN": `已没有观测点报告${label["zh-CN"]}检查成功。${witness["zh-CN"]}影响级别提升为重大中断。`,
  }
}

export function monitoringMessage(componentId: ComponentId, passes: number): LocalizedText {
  const label = COMPONENT_LABELS[componentId]
  return {
    en: `The reference observer has passed ${passes} consecutive checks of the ${label.en}. We are monitoring for stability.`,
    "zh-CN": `参考观测点对${label["zh-CN"]}的检查已连续通过 ${passes} 次。我们正在持续观察其稳定性。`,
  }
}

export function refailedMessage(componentId: ComponentId): LocalizedText {
  const label = COMPONENT_LABELS[componentId]
  return {
    en: `The reference observer reported a new failure of the ${label.en} while recovery was being monitored. We are investigating again.`,
    "zh-CN": `在观察恢复期间，参考观测点再次报告${label["zh-CN"]}检查失败。我们重新开始调查。`,
  }
}

export function resolvedMessage(
  componentId: ComponentId,
  passes: number,
  corroborated: boolean
): LocalizedText {
  const label = COMPONENT_LABELS[componentId]
  if (corroborated) {
    return {
      en: `The ${label.en} has passed ${passes} consecutive reference checks and an independent observer confirms recovery. Resolved.`,
      "zh-CN": `${label["zh-CN"]}已连续通过 ${passes} 次参考检查，并有独立观测点确认恢复。已解决。`,
    }
  }
  return {
    en: `The ${label.en} has passed ${passes} consecutive reference checks. No independent observer was available, so this recovery is uncorroborated. Resolved.`,
    "zh-CN": `${label["zh-CN"]}已连续通过 ${passes} 次参考检查。由于没有可用的独立观测点，此次恢复未经佐证。已解决。`,
  }
}
