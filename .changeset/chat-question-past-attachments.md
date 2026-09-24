---
"cognia-next": patch
---

Messages with an attached document or image OCR text are now read by the question you typed, not by the file's extracted text. Before, the file's text was used in its place in several spots. Model routing, memory and twin recall, and skill hints now use your question. A bound Squad now gets both the file and your question as its goal, and the Squad card names your question. The independent verifier is briefed with your question. The run log and trace preview record your question.

Team rooms do the same: a name mentioned inside an attached file no longer picks who answers, and a follow-up you send while the room is busy keeps your text and its files apart.

Editing a message now resends its attached files with the new text, as other chat apps do, in direct chats and team rooms. Before, only the text was resent. Regenerating a message now resends its files too, including after the app restarts, and keeps its leading `@agent` routing. A file that can't be sent again, such as a video that was sent natively, is named in a notice instead of being dropped silently. That includes edits made from a paired phone.

External agents (Codex, ACP agents, a paired host's agents) receive text only, and so does a Squad's goal. When a message's images, video or fetched pages can't be handed to either, a notice now says what was left out. When another agent answered since the built-in agent last spoke, the handoff of what it said now goes in front of an attached file instead of being written into the file's text.
