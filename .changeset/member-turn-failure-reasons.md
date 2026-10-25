---
"cognia-next": patch
---

Organization members on a shared Host now see why a turn failed, as it happens: a used-up monthly allowance, a chat whose model the organization has no key for, or an agent the organization doesn't allow each shows its own explanation in the chat instead of a bare error. A turn over the allowance fails at once instead of retrying for twenty seconds, and nothing is spent on it; a refused message no longer leaves the conversation looking busy, and a delivered message no longer stays "sending".
