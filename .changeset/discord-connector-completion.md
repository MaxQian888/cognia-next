---
"cognia-next": minor
---

Discord connector: make interactive A2UI components actually work (the gateway now forwards `INTERACTION_CREATE` and the adapter ACKs within Discord's 3s window), fix DM reception (default intents corrected to 46593 and now wired from config), conform reactions to the 2-arg contract, add real modal two-hop (InteractionResponse type 9) for TextField/TextArea/Dialog, upload images/files/voice as real multipart attachments (new Rust `connectors_discord_upload`) instead of URL-only embeds, and add an Interactions Webhook transport (interaction-only; message events still require gateway mode).
