---
"cognia-next": patch
---

Sites: saving an environment change no longer wipes your configured secrets. Each secret is now kept, replaced, or removed explicitly, and the diff shows which survive the save — previously the editor opened with an empty secrets field and saving a variable silently dropped every secret from the new revision, so the next publish shipped a worker without them.
