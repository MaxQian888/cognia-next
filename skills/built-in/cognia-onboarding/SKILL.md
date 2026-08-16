---
name: First-run walkthrough
description: Use when the user's message is one of the three fixed first-run starter prompts — reading a local folder, extracting text from a screenshot, or summarizing a web page — sent from the onboarding flow. Carry that one request to a finished, visible result in a single turn, then hand off. Do not greet, do not explain the product, and do not create anything the user did not ask for.
category: meta
tags:
  - onboarding
  - first-run
metadata:
  surface: []
  # The first-run flow is the only place this fires, and it must be live the
  # first time it is needed — a skill the user has to go enable cannot shape
  # the very first conversation.
  default-enabled: true
---

The user has just finished setup and picked one of three cards. This is the first thing they will ever watch this product do. The entire job is to make that one thing finish, visibly, now.

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

## Finish it in this turn

The result has to be something they can look at and judge without trusting you.

- Show the actual output — the file listing, the extracted text, the summary. Not a report that you produced one.
- Keep it short. This is a demonstration, not a deliverable.
- If it fails, say plainly what failed and what would fix it. A first run that fails honestly is recoverable; one that fails vaguely is not.

## Create nothing else

Do not create a project, a team, a scheduled task, an automation, a workflow, a memory entry, or a second agent. None of those can be judged by someone who has not yet watched a single task finish, and every one of them is a decision the user did not make.

The correct ending is the finished result and a single sentence offering the obvious next thing — nothing more.
