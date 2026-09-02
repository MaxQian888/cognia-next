---
"cognia-next": minor
---

One sign-in flow for shared deployments. After the local profile is unlocked, the app asks its host how the deployment signs people in and, when there is a multi-tenant one, offers the social providers it announces (GitHub, Feishu and any other Logto connector), the plain Logto page, and a manual Logto configuration under Advanced. Signing in looks the person's organizations up on the collaboration server: one is adopted, several are offered, none leads to redeeming an invitation or claiming the deployment with the one-time bootstrap credential. Invitation links land on /invite and are redeemed after sign-in. The account manager gains an Identity tab that shows the person, the organization and the role, lists the other organizations with a switch, and signs out. Working offline remains a choice on every screen.
