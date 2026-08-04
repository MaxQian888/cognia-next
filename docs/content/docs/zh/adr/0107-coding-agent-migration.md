---
title: ADR-0107 — 统一编程智能体迁移
description: "把 Claude Code、Codex 和 OpenCode 的设置、会话、技能、子智能体、MCP 服务器、命令与记忆组合为一个可预览的迁移流程。"
---

# ADR-0107 — 统一编程智能体迁移

**状态**：已接受（2026-08-03）

## 背景

Cognia 已分别提供智能体会话、MCP 配置、子智能体、技能和外部记忆的导入路径，但用户必须逐一寻找和执行；设置与命令提示词也没有完整导入路径。同时，厂商根目录需要遵守 `CLAUDE_CONFIG_DIR`、`CODEX_HOME` 和 OpenCode 的 XDG 配置。

## 决策

`lib/agent-migration/` 是纯编排层。它探测已安装的 Claude Code、Codex 与 OpenCode，把预览和应用操作委托给既有子系统，并暴露一个可取消、可报告进度的迁移计划。该层不拥有持久化，也不创建平行数据模型。

支持的工件矩阵包括设置、会话、技能、子智能体、MCP 服务器、命令和记忆。每个预览单元明确标记为 `ready`、`shared`、`empty`、`unsupported` 或 `error`；有损或无法映射的来源设置以警告展示，不会静默丢弃。冲突处理沿用 `skip`、`overwrite` 和 `duplicate`。

Claude Code hooks 与斜杠命令标记为**已共享**而非导入：Cognia 有意读写同一个 `~/.claude/settings.json` hooks 区块和 `.claude/commands/` 目录。Codex 与 OpenCode 命令会转换到这份规范存储。环境感知的厂商根目录解析器由会话、技能、命令、记忆和迁移发现共同使用。

迁移向导是新增入口，不替换各领域既有的专用导入对话框。

## 后果

- 用户可以在 Cognia 写入任何内容前检查所有可用工件。
- 每个应用操作仍经过对应领域子系统的校验和持久化规则。
- 不受支持的来源概念会被报告，不会为了镜像其他工具而扩展 `AppSettings`。
- OpenCode 路径遵循当前官方文档的复数 `agents/`、`skills/` 和 `commands/` 目录，同时在安全情况下兼容旧版 agent 路径。

## 验证

同目录适配器、编排、组件和 Rust 测试覆盖根目录覆盖、转换、合并策略、取消和向导接线；i18n 目录由配对的中英文命名空间生成。
