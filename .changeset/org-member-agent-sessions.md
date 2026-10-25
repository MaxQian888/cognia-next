---
"cognia-next": minor
---

Organization members on a multi-tenant cognia-server can now chat with a real agent. Each conversation runs as one of the agents the organization allows, or as the organization's default agent. The agent runs in the member's gVisor sandbox inside their personal workspace, and it uses the organization's model access through the Host without ever seeing the key. Tool permissions are granted automatically inside the sandbox. The agent process stays up between turns and stops after 15 minutes idle. The Host also stops it when the workspace outgrows its limit or the member loses their place in the organization, and the turn reports why. Conversations with no allowed agent stay tool-less chat. Members can't pick the agent from their device yet.
