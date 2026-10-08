# Account apply op-key reuse — 2026-10-08

Pre-registered before production edits and measurement. Prior delete-existence hypothesis rejected: it would skip authentication of old encrypted body. No production delete optimization was applied.

Hypothesis: successive valid remote ops commonly use the same epoch key; deriving the same opKey with HKDF importKey+deriveBits for every op wastes native crypto work. A single last-key entry scoped to prepare closure may reuse the derivation, while everyop still checks own-device/schema/epoch/key availability and origin signature in originalorder, then decrypts/validates normally. Compare epoch-key objectidentity, so replacement at same epoch rederives. Cache released per batch; replay owns one bounded entry foritscall. No global cache, no crypto primitive/protocol change, no parallel crypto or IndexedDB holds.

Primary: actual applyBatches from invocation through fulltransactioncommit for256 incoming new ordinary session metadata rows (id,title32ASCIIcharacters,createdAt,updatedAt). Nativeprotocol encrypt/sign fixture, actual originverification+wiredecrypt, fullCogniaDB encryptedrows/clocks and capturearmed/exemptremoteapply, cursor/HLC commit. Synthetic preverifiedregistry andgenerated ECDSA/epochkeys; excludesenrollment, registrytransport, network,fixtureseal/sign/setup/seed andpostchecks.

Guards:256 updates of existing4KiB sessionbody (titleupdateonly);256 staleupserts with4KiB bodies;256 newmetadata rows alternating2epochsacross2signers (eachsignerkeepsmonotonicepoch);singlemetadataop. Separate native rollback, cipherlock, invalidsignature/ciphertext; co-located same-epochkeyreplacement and repeatedIDs ordering, existing malformed/newerschema/unknownkey/inboxreplay/convergence tests. Everywirebatch<=256ops/1MiB. Encryptedbodyreadstaysunchanged.

Environment: AppleM4Pro/macOS48GiB, Chromium151, production/minifiedesbuild ESM. Samefullschema/shareddeps bothvariants. FreshisolatedaccountDB/cipherper sample, no unrelatedcacheclear. Oneprewarm+onebaselinepilot beforeedit, then1warmup pervariant/workload +10 measuredsamples each; order alternatesbaseline/result thenresult/baseline. No outlierremoval. Dedicatedport18753/sessionaccount-key-20261008. Serializebuild/tests/timing withparent.

Primary metric: medianelapsedmilliseconds; reportMAD. Acceptonly improvement>=10% AND absoluteimprovement>2largerMAD. Rejectguardregression>10% AND >2largerMAD; anycorrectness/security/rollback/orderfailure rejects. No prep-onlyspeedclaim, p95/realphone/networkclaim. Ifwithinnoise orbelowthreshold revertownproduction+testhunks, retain report.

Allowedsource: lib/account-sync/data/applier.ts + .test.ts only; artifacts underthisdirectory and/tmp/cognia-account-apply-key-2026-10-08; generateddisposableDBs/synthetickeys only. Allotherdirtyworkpreserved; no commits. Frozenbaseline, baseline-before-edit.json,comparison.json,metrics.json,guards.json andreport.md provideevidence. FocusedJest applier/op-origin/syncintegration/sync-round pluseslint/prettier/diffcheck; parentglobalgates.

Before measurements: cache guard also compares source key bytes against a32-byte snapshot copied before derivation. This preserves in-place key mutation behavior even when Uint8Arrayidentity stayssame. Add atomic authenticationfailuretest after such mutation; derivedkey consumer doesnotmutate input.

Before final comparison: include current deps.spaceId in cache validity (snapshot before HKDF await); same live argument evaluation/error ordering as baseline. Add scope-change guard. No workload/threshold change.
