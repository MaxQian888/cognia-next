|  Rows | Attachment refs | Operation      | Before median ± MAD (ms) | After median ± MAD (ms) | Improvement | Threshold         |
| ----: | :-------------: | -------------- | -----------------------: | ----------------------: | ----------: | ----------------- |
|  1000 |       no        | unchanged      |              5.30 ± 1.00 |             4.40 ± 0.10 |      16.98% | no conclusive win |
|  1000 |       no        | full-change    |              5.00 ± 0.10 |             5.10 ± 0.20 |      -2.00% | no conclusive win |
|  1000 |       no        | streaming      |              0.60 ± 0.00 |             0.50 ± 0.10 |      16.67% | no conclusive win |
|  1000 |       no        | restore-recent |              0.80 ± 0.10 |             0.60 ± 0.05 |      25.00% | no conclusive win |
|  1000 |       no        | restore-all    |              9.15 ± 0.75 |             7.80 ± 0.10 |      14.75% | no conclusive win |
|  1000 |       yes       | unchanged      |              4.40 ± 0.10 |             4.30 ± 0.20 |       2.27% | no conclusive win |
|  1000 |       yes       | full-change    |              5.95 ± 0.20 |             6.30 ± 0.40 |      -5.88% | no conclusive win |
|  1000 |       yes       | streaming      |              1.30 ± 0.15 |             0.80 ± 0.15 |      38.46% | PASS              |
|  1000 |       yes       | restore-recent |              0.60 ± 0.10 |             0.80 ± 0.10 |     -33.33% | no conclusive win |
|  1000 |       yes       | restore-all    |              8.20 ± 0.30 |             8.30 ± 0.10 |      -1.22% | no conclusive win |
| 10000 |       no        | unchanged      |             36.40 ± 0.70 |            36.20 ± 0.50 |       0.55% | no conclusive win |
| 10000 |       no        | full-change    |             38.25 ± 0.35 |            39.40 ± 0.60 |      -3.01% | no conclusive win |
| 10000 |       no        | streaming      |              0.50 ± 0.00 |             0.40 ± 0.05 |      20.00% | no conclusive win |
| 10000 |       no        | restore-recent |              0.85 ± 0.10 |             0.80 ± 0.00 |       5.88% | no conclusive win |
| 10000 |       no        | restore-all    |             74.45 ± 4.80 |            64.00 ± 0.30 |      14.04% | no conclusive win |
| 10000 |       yes       | unchanged      |             39.15 ± 1.75 |            40.10 ± 1.85 |      -2.43% | no conclusive win |
| 10000 |       yes       | full-change    |             42.65 ± 0.60 |            44.25 ± 1.20 |      -3.75% | no conclusive win |
| 10000 |       yes       | streaming      |              3.70 ± 0.25 |             0.60 ± 0.10 |      83.78% | PASS              |
| 10000 |       yes       | restore-recent |              0.70 ± 0.05 |             0.95 ± 0.05 |     -35.71% | REGRESSION        |
| 10000 |       yes       | restore-all    |             69.85 ± 0.90 |            65.85 ± 0.75 |       5.73% | no conclusive win |
