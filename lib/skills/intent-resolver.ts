/**
 * Cheap, deterministic intent hints for contextual built-in Skill discovery.
 * This is deliberately conservative: a missed hint only removes guidance,
 * while a false positive spends prompt/catalog budget on an irrelevant Skill.
 */
export function inferBuiltInSkillIntents(prompt: string | undefined): string[] {
  const text = prompt?.trim().toLocaleLowerCase() ?? ""
  if (!text) return []

  const intents = new Set<string>()
  if (
    /\b(chart|plot|quantitative graph|bar chart|line chart|pie chart|doughnut|radar chart|scatter plot)\b/.test(
      text
    ) ||
    /(图表|绘图|数据可视化|柱状图|折线图|饼图|环形图|雷达图|散点图|趋势图)/.test(text)
  ) {
    intents.add("chart")
  }
  if (
    /\b(diagram|flowchart|sequence diagram|architecture figure|process map|state machine|entity relationship|mermaid|mind ?map|gantt|org chart)\b/.test(
      text
    ) ||
    /(架构图|流程图|时序图|状态机图|关系图|实体关系图|思维导图|甘特图|泳道图|象限图)/.test(text)
  ) {
    intents.add("diagram")
  }
  if (
    /\b(ocr|extract text from (?:an? )?(?:image|screenshot|scan)|read (?:an? )?scanned document)\b/.test(
      text
    ) ||
    /(ocr|从.{0,8}(图片|截图|扫描件).{0,8}(提取|识别).{0,4}(文字|文本)|识别扫描件)/i.test(text)
  ) {
    intents.add("extract-text-from-image")
  }
  if (
    /\b(search|browse|research|look up|verify).{0,24}\b(web|online|internet|source|latest|current)\b/.test(
      text
    ) ||
    /\b(latest|current).{0,24}\b(news|release|version|price|schedule)\b/.test(text) ||
    /(联网|上网|网页|网上|网络).{0,12}(搜索|查找|调研|核实|验证|查询)|(最新|当前).{0,10}(新闻|版本|价格|赛程)/.test(
      text
    )
  ) {
    intents.add("research-web")
  }
  return [...intents]
}
