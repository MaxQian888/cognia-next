---
"cognia-next": patch
---

Fix `MISSING_MESSAGE` console errors on the Settings → Conversation page. The "Input & sending", "Composer behavior", and "Message stream" cards referenced translation keys (`settings.conversation.inputSend.*`, `settings.conversation.composerBehavior.*`, `settings.conversation.messageStream.*`) that were never added to the message catalog, so their titles, descriptions, and toggle labels rendered as errors. The missing keys are now added in both `en` and `zh-CN`.
