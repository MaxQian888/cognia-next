/**
 * Zhihu pipeline skills (inline markdown playbooks).
 *
 * Stored in the skill-registry under their verbatim id (self-namespaced as
 * `zhihu-content-pipeline:<name>` via `packSkillId`). Role characters attach
 * them through `pluginSkillIds`; `resolveSkillsForCharacter` inlines the
 * markdown into the system prompt at send time (see
 * `lib/claude/skills-bridge.ts`).
 *
 * `inline` (not `local-folder`) is deliberate: local-folder skills are dropped
 * in browser mode and require an on-disk read at runtime, which a bundled
 * plugin can't guarantee. Inline markdown is bundled into the JS and always
 * available — the same choice `cognia-backend-refactor` makes.
 *
 * Content is adapted from the matching skills in `D:\Project\skills-test`
 * (zhihu-answer-writer, ai-writing-humanizer, market-research-skill,
 * daily-news-multisource-brief, pdf-reading-workflow / vision-analysis). The
 * methodology drives the agent; the actual capabilities (search, scrape,
 * vision, image-gen) come from the MCP servers + native tools each role gets.
 */

import { defineSkill } from "@cognia/plugin-sdk"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import { packSkillId } from "../ids"

/** Writer — the high-vote Zhihu answer writer (faithful to zhihu-answer-writer). */
const ZHIHU_ANSWER_WRITER = defineSkill({
  id: packSkillId("zhihu-answer-writer"),
  name: "知乎高分回答写手",
  description:
    "把一个知乎问题写成有“高赞气质”的回答：开头抓人、结构清晰、观点+案例、排版舒服、去 AI 味、配图到位。问题拆解→结构大纲→正文初稿→配图方案四步多轮确认。",
  scope: "character",
  source: {
    kind: "inline",
    markdown: [
      "# 知乎高分回答写手",
      "",
      "把一个知乎问题，写成一篇有“高赞气质”的回答——开头抓人、结构清晰、有观点有案例、排版舒服、配图到位、读起来像真人答主而不是 AI。",
      "",
      "知乎的残酷现实：**信息流只露前两三行，排序由互动（赞/藏/评/完读率）驱动，读者只认“具体的人 + 具体的信息”**。这三条决定一切打法。",
      "",
      "## 为什么要多轮确认",
      "知乎回答高度个人化：用什么立场、走什么结构、用谁的经历当案例，都得贴合用户本人。一口气写完再让用户推翻，既浪费又难改。拆成四个卡点，**每步定下来再往下走**——越早对齐方向，返工越少。不要图快跳过确认。",
      "",
      "## 工作流程",
      "",
      "### 第 0 步：拿全问题 + 联网调研（动笔前必做）",
      "先确认拿到**完整问题**。知乎标题下常有“问题补充/描述”，提问者在那交代真实诉求，经常彻底改变正确答法。用户只给标题时，问一句“这题下面有没有问题补充？”。",
      "拿全问题后别急着写，用联网搜索（Exa / fetch / zget search）把话题摸清——这是“具体信息”的来源，也是和纯 AI 空泛回答拉开差距的关键：",
      "- 话题的**事实、数据、时间线**——有具体数字才可信。",
      "- 已有**高赞回答怎么答**——不是抄，是看清读者想要什么、已有答案的空白在哪，找差异化角度。",
      "- 可用的**真实案例 / 争议点 / 反常识结论**。",
      "调研快而准（2-4 次检索），抓到硬料就停。用户明确说“别联网”才跳过，但提醒缺数据的回答偏弱。",
      "",
      "### 确认 ① 问题拆解 + 立场 + 钩子",
      "一次性给出三样让用户挑/改，用 `AskUserQuestion` 收敛：",
      "1. **问题归类与拆解**：六类里的哪类（知识科普/个人经验/情感共鸣/测评推荐/争议辩论/职业行业），读者真正想要什么，“题眼”在哪。",
      "2. **答主立场/人设**：第一人称亲历 / 专家科普 / 犀利观点——**要问用户**他和这话题什么关系、有无真实经历。人设必须真实，编造会崩。",
      "3. **2-3 个候选开头钩子**：写出来给用户选，标明类型（反常识/亮证/数据/悬念/场景/总述）。",
      "**定下来再进下一步。**",
      "",
      "### 确认 ② 结构 / 大纲",
      "选一个结构模板（结论先行 / 故事+道理 / 清单体 / 层层递进 / 对比体 / 总分总），列**逐段大纲**：",
      "- 每段讲什么、放什么案例/数据、承担什么作用。",
      "- 标出“观点”主线和支撑它的“案例/数据”血肉——两者都要，别变纯干货或纯故事。",
      "- 标出情绪曲线高点和金句位置。",
      "- **定详略**：长度随类型走，不是越长越高赞。情感题贵在精炼，干货/测评/科普才需长篇分块。先和用户对篇幅。",
      "大纲给用户过目、调整后再往下。**大纲没定不要写正文。**",
      "",
      "### 确认 ③ 正文初稿",
      "按大纲写完整初稿：",
      "- 开头第一句给钩子不铺垫；短段短句、加粗只给重点、该分点分点；金句放情绪高点；结尾先收主旨再做利他式互动引导。",
      "- **此时不插真图**，在该配图处用 `【配图位：画什么】` 占位。",
      "- **写完立刻去 AI 味自检**：删“综上所述/此外/值得注意的是/研究表明”等标志词换口语；加具体细节、个人化措辞、明确立场。交给用户的初稿就该去过 AI 味（详见 de-ai-humanizer 技能）。",
      "把初稿给用户读，改到认可。",
      "",
      "### 确认 ④ 配图方案",
      "正文定稿后规划配图（详见 zhihu-illustration 技能）：针对每个 `【配图位】` 定四件事——放哪/画什么/类型/出图路子（A: gpt-image 真生成 ；B: 联网找真实网图）。**先把配图方案表给用户拍板**再出图。",
      "",
      "### 第 5 步：交付成品",
      "组装正文 + 配图为最终 markdown：生成图给路径、网图给链接+图注+版权提示；末尾附简短交付说明（用了什么人设/结构/钩子，哪些图建议换成自己的真实图）；提醒用户发布前把人设细节替换成自己真实的。",
      "",
      "## 贯穿始终的硬约束",
      "1. **开头第一句必须有信息或钩子，禁止铺垫**（信息流只露前两三行）。",
      "2. **“观点 + 案例”双驱动**（纯干货空泛，纯故事没主见）。",
      "3. **短段、加粗重点、分点**是基本功。",
      "4. **主动去 AI 味**：删标志词，加具体细节、个人立场、口语节奏——AI 起草内容能否过关的分水岭。",
      "5. **结尾互动引导要利他**，别用“码字不易求三连”模板话术。",
      "6. **人设必须真实**：用用户自己的身份和经历，不替他编造可被戳穿的经历。",
      "",
      "## 灵活度",
      "这是创作类流程，不是死板检查表。用户说“别啰嗦直接写一版”就压缩确认、一次给初稿再迭代；老手只想要钩子和结构建议就别硬塞全流程。四个卡点是默认路径，核心是“具体的人 + 具体的信息”这条魂。",
    ].join("\n"),
  },
})

/** Polisher — de-AI humanizer (faithful to ai-writing-humanizer). */
const DE_AI_HUMANIZER = defineSkill({
  id: packSkillId("de-ai-humanizer"),
  name: "去 AI 味润色",
  description:
    "诊断并改写带 AI 腔的中文/英文文本：低信息密度、AI 套话、缺少人味。先扫描 AI 指纹，再做有针对性的重写。",
  scope: "character",
  source: {
    kind: "inline",
    markdown: [
      "# 去 AI 味润色",
      "",
      "目标：把一段“一看就是 AI 写的”文字，改成有信息密度、有具体感、有人声的真人文字。不是换几个词，而是定位 AI 指纹后做针对性重写。",
      "",
      "## 第一步：扫描 AI 指纹",
      "逐句找这些信号，标出来：",
      "- **套话/连接词滥用**：综上所述、总而言之、值得注意的是、不仅……而且、此外、首先其次最后、在当今……的背景下。",
      "- **空泛限定词堆叠**：各种各样、诸多、相关、一定程度上、某种意义上——堆砌而不落到具体。",
      "- **完美对称**：每段一样长、每点一样多字、排比过度、破折号/分号过度规整。",
      "- **抽象动词 + 名词化**：实现了……的提升、起到了……的作用——把动作藏进名词。",
      "- **被动与去人称**：通篇没有“我”，没有具体的人、地点、时间、数字。",
      "",
      "## 第二步：问改写力度",
      "用 `AskUserQuestion` 问用户要**整篇重写**还是**只改诊断出的问题句**。默认后者——保留作者原意和结构，外科手术式修。",
      "",
      "## 第三步：针对性重写",
      "- 删套话连接词，让句子直接相连或用口语过渡。",
      "- 把抽象换具体：给数字、给人名/地名、给一个真实场景或例子。",
      "- 打破对称：长短句交替，敢用一句话独立成段，敢有不完美。",
      "- 把名词化拆回动作（“实现了效率的提升”→“快了三倍”）。",
      "- 加明确立场和个人化措辞（“我踩过这个坑”“别信那套”）。",
      "",
      "## 第四步：交付",
      "给改写后的文本 + **3-5 条改动理由**（改了什么、为什么这样更像真人）。不要默默改完，让用户看见你的判断，方便他接受或回退。",
      "",
      "## 红线",
      "去 AI 味不等于注水或编造。保留事实准确，不为“像人”而捏造经历或数据。",
    ].join("\n"),
  },
})

/** Polisher — illustration plan (the 配图方案 stage). */
const ZHIHU_ILLUSTRATION = defineSkill({
  id: packSkillId("zhihu-illustration"),
  name: "知乎配图方案",
  description:
    "为一篇知乎回答规划配图：每个配图位定“放哪/画什么/类型/出图路子”，区分 AI 生成示意图与联网找真实数据图。",
  scope: "character",
  source: {
    kind: "inline",
    markdown: [
      "# 知乎配图方案",
      "",
      "好配图让回答更专业、完读率更高；错配图（伪造的“数据图”、糊图、跑题图）反而扣分。先做方案表，用户拍板，再出图。",
      "",
      "## 方案表（每个 `【配图位】` 一行）",
      "定四件事：",
      "1. **放哪**：正文哪个位置（开头封面 / 某小节后 / 结论前）。",
      "2. **画什么**：一句话说清这张图要传达什么。",
      "3. **类型**：封面 / 概念示意图 / 流程图 / 数据图表 / 实物或截图。",
      "4. **出图路子**：",
      "   - **路子 A（AI 真生成）**：示意图、信息图、封面、概念图 → 调用 gpt-image 生成；流程图/结构图可用 mermaid，数据图可用 vega-lite。",
      "   - **路子 B（联网找真实图）**：真实统计数据、实物、产品截图 → 联网（Exa / zget）找现成图，给链接 + 来源 + 版权提示。",
      "",
      "## 硬规矩",
      "- **绝不用 AI 生成“真实数据图”**：伪造的统计图在知乎是信任灾难。数据图要么用真实来源（路子 B），要么用工具按真实数据画（vega-lite）。",
      "- 截图类（操作步骤、界面）用 screenshot 工具实拍。",
      "- 每张网图标注来源与版权提示，提醒用户发布前确认可用。",
      "- 配图服务于内容，不凑数；一篇 2-5 张通常够。",
      "",
      "## 交付",
      "方案确认后执行出图：生成图给文件路径，网图给链接+图注+版权提示，按正文位置落位。",
    ].join("\n"),
  },
})

/** Scout — hot-topic discovery (faithful to daily-news / ai-news multisource). */
const HOT_TOPIC_SCOUT = defineSkill({
  id: packSkillId("hot-topic-scout"),
  name: "热点侦察",
  description:
    "跨来源扫描当前热点：知乎热榜 + 搜索、全网中文热搜（微博/B站/V2EX）、科技海外源（HN/Reddit/AI 资讯），按来源标注，聚合成带证据的候选清单。",
  scope: "character",
  source: {
    kind: "inline",
    markdown: [
      "# 热点侦察",
      "",
      "目标：在几分钟内给出一份**带来源、带依据**的热点候选清单，供后续选题。不是罗列标题，而是判断“哪些话题正在升温、为什么、适不适合写知乎”。",
      "",
      "## 来源（按优先级）",
      "1. **知乎本体**：`zget hot`（热榜）、`zget search <关键词>`、`zget question` / `zget answers` 看一个问题的现有回答密度与质量。最贴合知乎选题。",
      "2. **全网中文**：微博热搜、B 站热门、V2EX（用 zget 对应命令或联网搜索）。看话题是否破圈。",
      "3. **科技/海外**：Hacker News、Reddit、AI 资讯（联网搜索 / Exa）。做科技/AI 类深度选题。",
      "",
      "## 方法",
      "- 每个候选话题记：**标题、来源、链接、为什么在升温（事件/数据/时间点）、热度信号**（榜单位次、互动量、讨论增速）。",
      "- 去重与聚类：同一事件的不同标题合并成一个话题。",
      "- 初判知乎适配度：这话题在知乎有没有对应问题、现有回答是否留有空白、是否有“具体的人+具体信息”可写。",
      "",
      "## 交付",
      "输出一个候选清单（建议 5-10 条），每条带：话题、来源链接、升温原因、热度信号、知乎适配度初判（高/中/低 + 一句理由）。把判断依据写清楚，方便选题环节复核——别只给标题。",
    ].join("\n"),
  },
})

/** Editor — topic selection & validation (faithful to market-research-skill). */
const TOPIC_SELECTION = defineSkill({
  id: packSkillId("topic-selection"),
  name: "选题验证",
  description:
    "把候选热点收敛成一个值得写的选题：验证需求真实性、受众与角度、竞争（现有高赞回答）空白，给出证据支撑的选题建议。",
  scope: "character",
  source: {
    kind: "inline",
    markdown: [
      "# 选题验证",
      "",
      "目标：从候选清单里选出**一个**真正值得投入的选题，并把“为什么是它、用什么角度”讲清楚。证据优先，不拍脑袋。",
      "",
      "## 评估维度",
      "对每个候选，快速核四件事（联网取证，给链接）：",
      "1. **需求真实性**：这话题在知乎有没有真实在被问、被搜？问题的关注/回答数、搜索热度。伪需求不写。",
      "2. **受众与角度**：谁会看、他们想解决什么。同一话题不同角度（科普 vs 亲历 vs 测评 vs 争议）受众不同——选一个我们能写出“具体的人+具体信息”的角度。",
      "3. **竞争空白**：读现有高赞回答（`zget answers` / 联网），找它们的空白：过时了？太空泛？缺数据？缺某个视角？差异化点就在这。",
      "4. **可写性**：我们（或用户）有没有真实经历/数据/资料能支撑？没有硬料的选题再热也先放。",
      "",
      "## 收敛",
      "用 `AskUserQuestion` 把 2-3 个最优候选 + 各自的推荐角度给用户选。选定后产出一份**选题简报**：选题、目标问题/链接、受众、差异化角度、可用的证据/案例线索、预期人设。这份简报直接喂给调研和写作环节。",
      "",
      "## 原则",
      "宁缺毋滥：一个有硬料、有差异化角度的选题，胜过三个跟风空泛的。",
    ].join("\n"),
  },
})

/** Researcher — deep research (faithful to pdf-reading + vision + web research). */
const DEEP_RESEARCH = defineSkill({
  id: packSkillId("deep-research"),
  name: "深度调研",
  description:
    "围绕选定话题收集可引用的硬料：联网搜索与抓取、PDF/报告提取、图表/截图视觉分析；产出带来源的调研笔记。",
  scope: "character",
  source: {
    kind: "inline",
    markdown: [
      "# 深度调研",
      "",
      "目标：为选题攒够**可引用、可核实**的硬料——事实、数据、时间线、真实案例、权威观点。回答的可信度由这一步决定。",
      "",
      "## 取料渠道",
      "- **联网搜索/抓取**：Exa（`web_search_exa` / `web_fetch_exa`）做主力检索与正文抓取；fetch 抓已知 URL；zget `summary` / `scrape` 抓知乎/公众号/B站等平台内容转 Markdown。",
      "- **登录/JS 渲染站点**：走 CloakBrowser（拟人化隐身浏览器，经 Playwright MCP）抓需要登录或反爬的页面。",
      "- **PDF / 报告**：白皮书、行业报告、论文——提取关键数据、结论、图表所在页。",
      "- **图表 / 截图**：用视觉分析读懂图里的数据点、趋势，转成可引用的文字与数字。",
      "",
      "## 方法",
      "- 每条料记**来源链接 + 原文要点 + 提取出的事实/数字**。能溯源才能引用。",
      "- 交叉验证关键数字：一个数据至少两个独立来源对得上，再用；对不上就标注存疑。",
      "- 注意时效：标注数据的时间，过时数据明确说明。",
      "- 抓“反常识结论 / 争议点 / 真实案例”——这些是回答最出彩的料。",
      "",
      "## 交付",
      "产出一份**调研笔记**：按主题分块，每块给事实/数据 + 来源链接 + 可直接用进回答的“金句料/案例”。把笔记交给写手，标清哪些可直接引用、哪些需用户自己补真实经历。",
    ].join("\n"),
  },
})

/** All skills, in a stable order. Declared on `manifest.skills`. */
export const ZHIHU_SKILLS: PluginSkillDef[] = [
  HOT_TOPIC_SCOUT,
  TOPIC_SELECTION,
  DEEP_RESEARCH,
  ZHIHU_ANSWER_WRITER,
  DE_AI_HUMANIZER,
  ZHIHU_ILLUSTRATION,
]
