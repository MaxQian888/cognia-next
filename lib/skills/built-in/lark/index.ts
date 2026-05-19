/**
 * Lark built-in skill family barrel (ADR-0026).
 *
 * Importing this file triggers `registerBuiltInSkill()` calls for every
 * Lark skill module. v1 covers six families:
 *
 *   family         | tools | mutation tiers
 *   ---------------|-------|---------------------------
 *   calendar       | 9     | read · write · destructive
 *   doc            | 6     | read · write · destructive
 *   sheets         | 6     | read · write
 *   base (Bitable) | 8     | read · write · destructive
 *   task           | 7     | read · write
 *   wiki           | 4     | read · write
 *
 * 40 skills total. Each file calls `registerBuiltInSkill()` at module load.
 */

import "./calendar"
import "./doc"
import "./sheets"
import "./base"
import "./task"
import "./wiki"

export {}
