---
"cognia-next": patch
---

Fix the CLI's tool-approval prompt. Switching to bypass mid-session kept asking, because an external agent bakes its policy in at spawn and the switch was reported as applied whether or not it landed. The session now restarts when the running agent cannot take the new mode, and says so when it could not. Esc dismissed the prompt without answering it, so the agent stayed blocked on a question nobody was going to answer and the tool it had asked about ran anyway. Esc now denies the request and then stops the turn. The prompt also replaced the whole screen, leaving an approval alone on a blank terminal with none of the conversation that would justify it, and Pi's approvals arrived with no arguments at all, so a shell request read as a bare "Allow bash?" with the command missing. The prompt now docks under the transcript, carries the command or the proposed diff, and its footer says what Esc actually does.
