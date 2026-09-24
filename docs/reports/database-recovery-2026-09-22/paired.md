# Paired follow-up measurement

One browser, two isolated contexts, alternating baseline/optimized AB then BA order each round; two warmups and30 measured pairs for each operation and fixture; same frozen production source as final independent run.

Baseline source: `db1089db59c33c482b964a2eaab0ee5e2f9acf0c89f893ea5e9ac60fcc339ab4`. Optimized source: `f0cfc8e81c670ea9e3827c380bbbc781284b78829a9e88817237ce09af3d8888`.

|  Rows | Operation      | Baseline median ± MAD (ms) | Optimized median ± MAD (ms) | Improvement | Threshold             |
| ----: | -------------- | -------------------------: | --------------------------: | ----------: | --------------------- |
|  1000 | streaming      |                1.30 ± 0.10 |                 0.55 ± 0.05 |      57.69% | PASS                  |
|  1000 | restore-recent |                0.70 ± 0.10 |                 0.70 ± 0.10 |       0.00% | No threshold crossing |
| 10000 | streaming      |                4.10 ± 0.40 |                 0.75 ± 0.15 |      81.71% | PASS                  |
| 10000 | restore-recent |                0.80 ± 0.20 |                 0.85 ± 0.20 |      -6.25% | No threshold crossing |

This follow-up was triggered by the original independent-run recent-80 read regression, which remains in comparison.md. Pairing controls experiment timing and workload conditions more closely, but is not proof of absence of regressions on other machines, concurrent workloads or whole-app paths. All30 pairs, AB/BA order and paired differences are retained in paired.json.
