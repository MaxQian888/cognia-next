// The film's words, per locale: the title cards and one callout per beat.
// Loaded by index.html (window.__cogniaFilmCopy) and read by
// web/scripts/render-video.mjs to write the WebVTT caption tracks, so the
// on-screen callouts and the captions are one text.
window.__cogniaFilmCopy = {
  en: {
    openTitle: "One task, end to end.",
    openMeta: "acme/checkout-service · release/2.4.0 · unit-tests failing",
    provenance: "Recorded in Cognia · demo data",
    closeTitle: "Your open workspace for AI agents.",
    closeMeta: "Open source · Build from source",
    beats: {
      request: ["01 · Request", "One sentence starts the task."],
      context: ["02 · Context", "It reads the project before it proposes anything."],
      reproduce: ["03 · Reproduce", "The failing check, reproduced first."],
      plan: ["04 · Plan", "A plan you can read before a file changes."],
      fix: ["05 · Fix", "The change arrives as a diff, not a claim."],
      verify: ["06 · Verify", "The check that failed now passes."],
      notes: ["07 · Notes", "The result is a file you keep."],
      approval: ["08 · Approval", "Anything that leaves the machine waits for you."],
    },
  },
  zh: {
    openTitle: "一条任务，从头到尾。",
    openMeta: "acme/checkout-service · release/2.4.0 · unit-tests 未通过",
    provenance: "录自 Cognia · 演示数据",
    closeTitle: "你的开放 AI Agent 工作空间。",
    closeMeta: "开源 · 从源码构建",
    beats: {
      request: ["01 · 请求", "一句话开始任务。"],
      context: ["02 · 上下文", "先读项目，再提方案。"],
      reproduce: ["03 · 复现", "先把失败的检查复现出来。"],
      plan: ["04 · 计划", "改动之前，先给你看计划。"],
      fix: ["05 · 修复", "改动以 diff 呈现，而不是一句声明。"],
      verify: ["06 · 验证", "刚才失败的检查，现在通过了。"],
      notes: ["07 · 说明", "结果是一份留得住的文件。"],
      approval: ["08 · 审批", "任何离开这台机器的操作，都会停下来等你。"],
    },
  },
}
