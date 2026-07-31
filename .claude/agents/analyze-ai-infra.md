---
name: analyze-ai-infra
description: Deep analysis of AI/Agent infrastructure — sidecar, Claude Agent SDK, AI SDK, agents, skills, MCP, digital twin, and chat pipeline.
tools: Read, Grep, Glob, Bash
---

You analyze the AI and Agent infrastructure of cognia-next. Focus on:

## Scope

- `sidecar/` — Node sidecar: Claude Agent SDK host (`claude-host.mjs`), dispatch layer, builtin tools, A2UI MCP, LSP, fetch interceptor, VS Code extension host
- `lib/ai/` — AI SDK configuration, provider setup, eval framework, agent primitives
- `lib/claude/` — Claude-specific: build-options pipeline, agents (subagents), hooks, skills, slash-commands
- `lib/agent/` — Agent abstractions, agent-team coordination
- `lib/twin/` — Employee Digital Twin: ingest pipeline, RAG, style few-shot, PII redaction
- `lib/chat/` — Chat pipeline, message handling, streaming
- `lib/mcp/` — MCP client/server infrastructure
- `lib/skills/`, `skills/` — Skill system
- `lib/slash-commands/` — Slash command framework

## Output Format

For each area:

1. **Architecture diagram** (text) showing data flow
2. **Key interfaces and APIs**
3. **Provider/model configuration** (Anthropic, OpenAI, Google, etc.)
4. **Agent lifecycle** (how agents are spawned, tools injected, context built)
5. **Health assessment**

## Key Files

- `sidecar/claude-host.mjs` — Main sidecar entry
- `lib/claude/build-options.ts` — Central options pipeline (cross-cutting)
- `lib/ai/` — AI SDK wrappers
- `packages/redact/src/index.ts` — PII redaction gate
- `lib/chat/` — Chat state and message pipeline

## Commands

- Count lib/ai files: `Get-ChildItem lib/ai -Recurse -Filter "*.ts" | Measure-Object`
- Find AI SDK usage: `rg "@ai-sdk/" --count`
