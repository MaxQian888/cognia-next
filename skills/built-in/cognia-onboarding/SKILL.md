---
name: First-run walkthrough
description: Complete one authorized first-run folder, screenshot OCR, or web-summary request with a visible result.
category: meta
tags:
  - onboarding
  - first-run
metadata:
  delivery: request-scoped
  triggers:
    surfaces: []
    intents: [onboarding.read-folder, onboarding.extract-text, onboarding.summarize-web]
  capability-requirements:
    - capability: workspace-read
      reason: the folder starter must inspect a host-approved local directory
      when-intent: onboarding.read-folder
    - capability: screen-capture
      reason: the screenshot starter must capture a host-approved screen image
      when-intent: onboarding.extract-text
    - capability: ocr
      reason: the screenshot starter must extract visible text
      when-intent: onboarding.extract-text
    - capability: web-fetch
      reason: the web starter must read the supplied page
      when-intent: onboarding.summarize-web
  host-policies: [request-scope, capability-preflight, permission-ceiling, user-language]
  # The first-run flow is the only place this fires, and it must be live the
  # first time it is needed — a skill the user has to go enable cannot shape
  # the very first conversation.
  default-enabled: true
---

The user has just finished setup and picked one of three cards. The host attaches
this skill only to that onboarding request. The scope lasts through at most one
missing-input reply and ends with a visible result or an honest failure; it is
not a permanent session instruction.

## You are not being introduced

There is no greeting to write. The user chose a card and it sent a fixed sentence on their behalf; from their point of view they have already asked, and they are waiting.

- Do not say hello, introduce yourself, or describe what Cognia is.
- Do not explain that this is an onboarding task, or refer to the flow they just left.
- Do not open with a plan for the plan. Start doing the thing.

## The three starter prompts

Each card sends one fixed message. Match on intent, not exact wording — the same three cards exist in English and Chinese.

- **Read a folder** — "Read a folder on this machine and tell me what's in it."
  No path was given, because the card could not know one. Ask for the directory in a single short question, offering a sensible default you can actually see (the user's home, or the current working directory). Then read it and describe what is there: how many files, what kinds, what the place appears to be for. Name a few real entries. A tree dump is not a summary.

- **Extract text from a screenshot** — "Take a screenshot and extract the text from it."
  Capture, then OCR, then return the text. Show the extracted text itself, not a description of having extracted it. OCR output is a best-effort guess — if a region came back garbled, say which part rather than presenting noise as a transcript.

- **Summarize a web page** — "Summarize a web page for me."
  No URL was given. Ask for one in a single short question. Then fetch and summarize it: what it says, in the order it says it, short enough to be worth reading instead of the page.

## One question, at most

Two of the three cards are missing exactly one fact — a path, a URL. Ask for that one fact in one sentence and nothing else. Do not also ask about format, depth, language, or what they are hoping to get out of it. Those are choices you can make and they can correct.

If the user's reply is ambiguous, pick the most likely reading and say which one you picked. Asking twice in the first minute is worse than being slightly wrong once.

## Finish the request, not merely the transport turn

The result has to be something they can look at and judge without trusting you.
If the starter omitted a path or URL, the one clarification is part of the same
request; finish immediately after the user supplies it.

- Show the actual output — the file listing, the extracted text, the summary. Not a report that you produced one.
- Keep it short. This is a demonstration, not a deliverable.
- If it fails, say plainly what failed and what would fix it. A first run that fails honestly is recoverable; one that fails vaguely is not.

## Create nothing else

Do not create a project, a team, a scheduled task, an automation, a workflow, a memory entry, or a second agent. None of those can be judged by someone who has not yet watched a single task finish, and every one of them is a decision the user did not make.

The correct ending is the finished result and a single sentence offering the obvious next thing — nothing more.
