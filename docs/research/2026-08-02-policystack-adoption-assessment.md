# PolicyStack adoption assessment

**Date:** 2026-08-02  
**Scope:** Whether [PolicyStack](https://www.policystack.dev/) should be introduced into Cognia.

## Decision

Adopt only as a bounded proof of concept for the public website's English privacy-policy page. Do not use it as Cognia's agent authorization policy layer, do not replace Cognia's existing behavior-telemetry consent model, and do not ship its third-party script loader until the open `gateScript` defect is resolved and independently regression-tested.

PolicyStack is a privacy-policy and cookie-consent toolkit, not a general authorization engine. Its open-source packages turn a typed TypeScript config into privacy/cookie policy documents and a browser consent state machine; the hosted Cloud control plane is optional ([official README](https://github.com/jamiedavenport/policystack#readme), [official documentation](https://www.policystack.dev/docs)).

## Fit with Cognia

### Where it fits

- `web/` and `docs/` are React 19 / Next.js 16 static exports. PolicyStack 1.2.0 supports React 18+ and documents a Next.js provider pattern, including deterministic SSR snapshots for consent hooks ([React consent adapter](https://www.policystack.dev/docs/consent/react), [React package manifest](https://github.com/jamiedavenport/policystack/blob/main/packages/react/package.json)).
- The OSS packages use Apache-2.0 and publish `LICENSE`/`NOTICE` material. This creates no obvious dependency-license blocker for Cognia, provided notices are preserved ([license](https://github.com/jamiedavenport/policystack/blob/main/LICENSE.md), [notice](https://github.com/jamiedavenport/policystack/blob/main/NOTICE.md)).
- Policies-as-code matches Cognia's existing preference for versioned, testable contracts. A typed config can render a privacy policy and cookie policy, and its policy version can trigger re-consent when the cookie policy changes ([configuration](https://www.policystack.dev/docs/policy/configuration)).

### Where it does not fit yet

- Cognia already has a richer product-specific behavior-telemetry contract: default off, local/remote destinations, per-domain categories, sampling, retention, bounded event counts, and a PII gate. PolicyStack's browser cookie categories are not a replacement for that model.
- The public `web/` and `docs/` sources currently contain no GA, GTM, PostHog, Segment, Plausible, or Umami integration. Shipping a cookie banner before a non-essential browser tracker exists would add UX and compliance surface without gating anything.
- The built-in policy locales are `en`, `fr`, `de`, `nl`, and `es`; there is no Chinese dictionary. PolicyStack's eleven jurisdiction codes also omit China/PIPL, and only EEA, UK, and California have jurisdiction-specific policy text ([i18n documentation](https://github.com/jamiedavenport/policystack/blob/main/apps/web/content/docs/policy/i18n.md), [jurisdictions](https://www.policystack.dev/docs/policy/references/jurisdictions)). A Chinese policy would require a maintained custom dictionary or upstream contribution plus legal review, while PIPL-specific content would still need a separate solution.
- PolicyStack does not generate Terms of Service. It only covers privacy and cookie policies ([policy documentation](https://www.policystack.dev/docs/policy)).
- The build-time integration is Vite-first. Cognia's Next.js packages cannot attach the Vite plugin directly. The CLI can validate a config, but consent scan/sync commands are still documented as planned; a Next-specific CI scanner script would be custom integration work ([CLI consent documentation](https://github.com/jamiedavenport/policystack/blob/main/apps/web/content/docs/consent/cli.md), [scanner documentation](https://www.policystack.dev/docs/consent/scanner)).

## Risk assessment

- The current npm release is 1.2.0, published 2026-07-27. The project is young and has a small maintainer/contributor base, so an exact version pin and a deliberate upgrade review are warranted.
- An open upstream defect reports that `gateScript` can silently drop queued calls and prevents the shipped Meta Pixel integration from initializing. Do not adopt `@policystack/scripts` until a fixed release exists and Cognia has a real-browser regression test ([issue #156](https://github.com/jamiedavenport/policystack/issues/156)).
- The scanner explicitly uses a heuristic rather than control-flow analysis and favors false negatives. It is a review aid, not a compliance or security enforcement boundary ([scanner documentation](https://www.policystack.dev/docs/consent/scanner)).
- The repository exposes ordinary CI build/type/test/dead-code checks, but no `SECURITY.md` or published independent security audit was found ([CI workflow](https://github.com/jamiedavenport/policystack/blob/main/.github/workflows/ci.yml)).
- Generated legal text is not legal advice. PolicyStack itself requires counsel review, including native-language review of translated boilerplate ([policy README](https://github.com/jamiedavenport/policystack#readme), [i18n documentation](https://github.com/jamiedavenport/policystack/blob/main/apps/web/content/docs/policy/i18n.md)).

## Recommended rollout

1. Complete a real data/processors inventory and obtain the legal entity name, address, privacy contact, applicable jurisdictions, retention periods, and counsel-approved wording.
2. Add an exact-pinned `@policystack/sdk` and `@policystack/react` only to the `web` workspace. Build an English `/privacy` route with a route-local wrapper; do not mount the client provider across the whole application.
3. Add a CI command using `policystack validate --json`. Keep the existing Cognia i18n, static-export, and co-located test gates.
4. Verify `web` static export, hydration, accessibility, bundle impact, and the rendered legal text. Treat successful compilation as a software check, not legal approval.
5. Do not add Consent until a non-essential browser tracker is actually introduced. At that point, implement a custom Cognia banner/preferences UI, persist decisions locally, test GPC and re-consent behavior, and keep `@policystack/scripts` out until issue #156 is fixed.
6. Ship Chinese only after a complete Chinese dictionary and PIPL-specific legal content have been reviewed. Using the generic `row` jurisdiction is not a substitute for PIPL coverage.

## Go / no-go summary

| Surface                           | Decision      | Reason                                                      |
| --------------------------------- | ------------- | ----------------------------------------------------------- |
| Agent/tool authorization          | No-go         | Wrong problem domain                                        |
| Existing in-app telemetry consent | No-go         | Cognia's model is already richer and PII-gated              |
| English public privacy page       | PoC           | Strong technical fit; needs real inventory and counsel      |
| Cookie banner today               | Defer         | No current third-party browser analytics to gate            |
| Chinese/PIPL policy               | No-go for now | No built-in Chinese locale or China jurisdiction            |
| `@policystack/scripts`            | No-go for now | Open runtime defect in script gating                        |
| PolicyStack Cloud                 | Defer         | Optional early hosted control plane; not needed for the PoC |
