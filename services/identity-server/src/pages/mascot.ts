/**
 * Cognia's sign-in mascot: the anime operator from Cognia's own art
 * (`public/illustrations/cognia-anime-effort/operator.webp`) drawn as a chibi
 * — grey bob, cat-ear headset with cyan edges, amber eyes, the dark jacket
 * with its cyan core — in one expression per page outcome.
 *
 * Plain SVG strings with fixed colours, so the same art renders inline here,
 * as an `<img>` data URI in the app, and in the CLI's loopback page. The
 * app-side copy (`lib/identity/sign-in-mascot.ts`) is pinned to this file by
 * its test. Motion is SMIL (not CSS), so it runs under the pages' nonce-only
 * `style-src`, and every loop that is not a "still waiting" signal stops on
 * its own.
 */

export type MascotMood = "welcome" | "thinking" | "happy" | "worried" | "farewell"

export const MASCOT_MOODS: readonly MascotMood[] = [
  "welcome",
  "thinking",
  "happy",
  "worried",
  "farewell",
]

const LINE = "#3b3030"
const HAIR = "#b9bec4"
const HAIR_SHADE = "#8f969d"
const HAIR_SHINE = "#eef0f2"
const SKIN = "#fbe6d8"
const SKIN_SHADE = "#f0c9b4"
const EYE_LINE = "#2a1c14"
const IRIS = "#e9a23b"
const IRIS_LIGHT = "#f8cf7c"
const MOUTH = "#b9493f"
const BLUSH = "#ff9fb4"
const JACKET = "#22292f"
const COLLAR = "#59626a"
const TRIM = "#e6b03a"
const HEADSET = "#262d33"
const HEADSET_INNER = "#3a434b"
const CYAN = "#35cedd"
const SPARK_YELLOW = "#f3c34b"

function star(cx: number, cy: number, r: number, fill: string, begin: string): string {
  const d = `M${cx} ${cy - r}Q${cx} ${cy} ${cx + r} ${cy}Q${cx} ${cy} ${cx} ${cy + r}Q${cx} ${cy} ${cx - r} ${cy}Q${cx} ${cy} ${cx} ${cy - r}Z`
  return `<path d="${d}" fill="${fill}"><animate attributeName="opacity" values="1;.25;1" dur="1.8s" begin="${begin}" repeatCount="3"/></path>`
}

/** Everything but the face: hair, headset, body. Drawn back to front. */
const BACK = [
  // Hair behind the head.
  `<path d="M34 78C30 44 52 22 80 22S130 44 126 78L128 112C128 120 120 122 115 116L112 104H48L45 116C40 122 32 120 32 112Z" fill="${HAIR_SHADE}" stroke="${LINE}" stroke-width="1.4" stroke-linejoin="round"/>`,
  // Jacket, collar with its hazard trim, and the cyan core.
  `<path d="M28 160C30 137 50 124 80 124S130 137 132 160Z" fill="${JACKET}" stroke="${LINE}" stroke-width="1.4"/>`,
  `<path d="M62 124L80 146L70 160H48C50 146 55 132 62 124Z" fill="${COLLAR}"/><path d="M98 124L80 146L90 160H112C110 146 105 132 98 124Z" fill="${COLLAR}"/>`,
  `<path d="M62 124L80 146L98 124" fill="none" stroke="${TRIM}" stroke-width="2" stroke-linejoin="round"/>`,
  `<circle cx="80" cy="152" r="6" fill="#0f1418" stroke="${CYAN}" stroke-width="2"/><circle cx="80" cy="152" r="2" fill="${CYAN}"/>`,
  // Neck.
  `<path d="M71 106V126Q80 132 89 126V106Z" fill="${SKIN_SHADE}"/>`,
  // Cat-ear headset, its cyan edge lit.
  `<path d="M45 54L37 14L67 37Z" fill="${HEADSET}" stroke="#151a1e" stroke-width="1.4" stroke-linejoin="round"/><path d="M47 45L42 23L60 37Z" fill="${HEADSET_INNER}"/><path d="M40 20L44 47" stroke="${CYAN}" stroke-width="2" stroke-linecap="round"/>`,
  `<path d="M115 54L123 14L93 37Z" fill="${HEADSET}" stroke="#151a1e" stroke-width="1.4" stroke-linejoin="round"/><path d="M113 45L118 23L100 37Z" fill="${HEADSET_INNER}"/><path d="M120 20L116 47" stroke="${CYAN}" stroke-width="2" stroke-linecap="round"/>`,
  // Face.
  `<path d="M46 74C46 50 60 40 80 40S114 50 114 74C114 94 100 110 80 111C60 110 46 94 46 74Z" fill="${SKIN}" stroke="${LINE}" stroke-width="1.6"/>`,
  // Fringe and crown, with the hair's shine and a hairpin.
  `<path d="M40 76C36 44 54 26 80 26S124 44 120 76C116 66 112 60 106 56L104 70C99 60 94 54 88 52L86 66C81 56 74 52 68 52L64 66C60 58 56 56 52 58L50 70C46 70 42 72 40 76Z" fill="${HAIR}" stroke="${LINE}" stroke-width="1.4" stroke-linejoin="round"/>`,
  `<path d="M57 41Q64 34 73 32M87 32Q96 34 103 41" fill="none" stroke="${HAIR_SHINE}" stroke-width="2.8" stroke-linecap="round"/>`,
  `<rect x="97" y="51" width="11" height="3.4" rx="1.7" fill="${TRIM}" transform="rotate(-24 102 53)"/>`,
  // Side locks.
  `<path d="M42 70C38 88 40 104 48 114C47 100 49 88 53 74Z" fill="${HAIR}" stroke="${LINE}" stroke-width="1.2" stroke-linejoin="round"/>`,
  `<path d="M118 70C122 88 120 104 112 114C113 100 111 88 107 74Z" fill="${HAIR}" stroke="${LINE}" stroke-width="1.2" stroke-linejoin="round"/>`,
  // Nose and blush.
  `<path d="M80 91l-1 2" stroke="#e0a68c" stroke-width="1.4" stroke-linecap="round"/>`,
  `<ellipse cx="58" cy="96" rx="6" ry="2.6" fill="${BLUSH}" opacity=".5"/><ellipse cx="102" cy="96" rx="6" ry="2.6" fill="${BLUSH}" opacity=".5"/>`,
  `<path d="M55 97l2-3M59 97l2-3M99 97l2-3M103 97l2-3" stroke="#ff7f9c" stroke-width="1.1" stroke-linecap="round"/>`,
].join("")

/** An open anime eye; `look` shifts the iris (dx, dy) to glance somewhere. */
function openEye(cx: number, look: readonly [number, number] = [0, 0]): string {
  const [dx, dy] = look
  return [
    `<ellipse cx="${cx}" cy="83" rx="7" ry="9" fill="${EYE_LINE}"/>`,
    `<ellipse cx="${cx + dx}" cy="${85 + dy}" rx="5.6" ry="7" fill="${IRIS}"/>`,
    `<ellipse cx="${cx + dx}" cy="${88.5 + dy}" rx="4.2" ry="3.4" fill="${IRIS_LIGHT}"/>`,
    `<ellipse cx="${cx + dx}" cy="${84 + dy}" rx="2.4" ry="3.4" fill="${EYE_LINE}"/>`,
    `<circle cx="${cx - 2.5 + dx}" cy="${80 + dy}" r="2.2" fill="#fff"/><circle cx="${cx + 2.5 + dx}" cy="${88 + dy}" r="1" fill="#fff"/>`,
    `<path d="M${cx - 9} 78Q${cx} 70 ${cx + 9} 77" fill="none" stroke="${EYE_LINE}" stroke-width="3" stroke-linecap="round"/>`,
  ].join("")
}

/** A happily closed eye (^). */
function closedEye(cx: number): string {
  return `<path d="M${cx - 8} 85Q${cx} 75 ${cx + 8} 85" fill="none" stroke="${EYE_LINE}" stroke-width="3.2" stroke-linecap="round"/>`
}

const CALM_BROWS = `<path d="M58 68Q65 65 72 67M88 67Q95 65 102 68" fill="none" stroke="${HAIR_SHADE}" stroke-width="1.8" stroke-linecap="round"/>`
const SMILE = `<path d="M75 99Q80 103 85 99" fill="none" stroke="#8c3d33" stroke-width="1.8" stroke-linecap="round"/>`
const OPEN_SMILE = `<path d="M73 98Q80 108 87 98Z" fill="${MOUTH}" stroke="#8c3d33" stroke-width="1.2" stroke-linejoin="round"/><path d="M76 102Q80 106 84 102Q80 104 76 102Z" fill="#f28b8b"/>`

/** A raised hand that waves twice and settles. */
const WAVE = `<g><animateTransform attributeName="transform" type="rotate" values="0 128 148;16 128 148;0 128 148;16 128 148;0 128 148" dur="1.6s" begin=".3s" repeatCount="1"/><path d="M116 160L124 124L138 127L134 160Z" fill="${JACKET}" stroke="${LINE}" stroke-width="1.4" stroke-linejoin="round"/><path d="M123 125C119 112 123 101 131 101C139 101 142 111 138 127Z" fill="${SKIN}" stroke="${LINE}" stroke-width="1.4" stroke-linejoin="round"/><path d="M127 108v6M131 106v7M135 107v6" stroke="${SKIN_SHADE}" stroke-width="1.3" stroke-linecap="round"/></g>`

function badge(fill: string, glyph: string): string {
  return `<circle cx="134" cy="136" r="15" fill="${fill}" stroke="#fff" stroke-width="3"/>${glyph}`
}

const FACES: Record<MascotMood, string> = {
  welcome: [
    CALM_BROWS,
    openEye(66),
    openEye(94),
    SMILE,
    WAVE,
    star(26, 34, 7, CYAN, "0s"),
    star(140, 30, 5, SPARK_YELLOW, ".6s"),
    star(18, 104, 4, BLUSH, "1.1s"),
  ].join(""),
  thinking: [
    CALM_BROWS,
    openEye(66, [1.4, -1.4]),
    openEye(94, [1.4, -1.4]),
    `<ellipse cx="81" cy="100" rx="2.6" ry="2.2" fill="${MOUTH}"/>`,
    // A speech bubble whose dots keep pulsing while the page waits.
    `<path d="M120 14H152Q158 14 158 20V34Q158 40 152 40H134L126 47L128 40H120Q114 40 114 34V20Q114 14 120 14Z" fill="#fff" stroke="${LINE}" stroke-width="1.4" stroke-linejoin="round"/>`,
    ...[126, 136, 146].map(
      (cx, index) =>
        `<circle cx="${cx}" cy="27" r="3" fill="${CYAN}"><animate attributeName="opacity" values=".25;1;.25" dur="1.2s" begin="${index * 0.2}s" repeatCount="indefinite"/></circle>`
    ),
  ].join(""),
  happy: [
    CALM_BROWS,
    closedEye(66),
    closedEye(94),
    OPEN_SMILE,
    star(24, 38, 7, CYAN, "0s"),
    star(138, 26, 6, SPARK_YELLOW, ".5s"),
    star(20, 108, 4, BLUSH, "1s"),
    badge(
      "#2a6f49",
      `<path d="M127 136l5 5 9-10" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`
    ),
  ].join(""),
  worried: [
    `<path d="M58 66Q65 66 72 63M88 63Q95 66 102 66" fill="none" stroke="${HAIR_SHADE}" stroke-width="1.8" stroke-linecap="round"/>`,
    openEye(66, [0, 0.6]),
    openEye(94, [0, 0.6]),
    // Welling tears and a sweat drop.
    `<path d="M59 91Q66 94 73 91M87 91Q94 94 101 91" fill="none" stroke="#8fd3f4" stroke-width="2" stroke-linecap="round"/>`,
    `<path d="M124 50Q130 59 124 64Q118 59 124 50Z" fill="#8fd3f4" stroke="#4a9cc4" stroke-width="1.2"/>`,
    `<path d="M73 101q2.3-2.4 4.6 0t4.6 0t4.6 0" fill="none" stroke="#8c3d33" stroke-width="1.8" stroke-linecap="round"/>`,
    badge(
      "#b3261e",
      `<path d="M134 128v9" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><circle cx="134" cy="143" r="2" fill="#fff"/>`
    ),
  ].join(""),
  farewell: [
    CALM_BROWS,
    openEye(66),
    `<path d="M86 84Q94 78 102 84" fill="none" stroke="${EYE_LINE}" stroke-width="3.2" stroke-linecap="round"/>`,
    OPEN_SMILE,
    WAVE,
    star(26, 36, 6, CYAN, "0s"),
  ].join(""),
}

/** The mascot as a standalone SVG document (decorative: `aria-hidden`). */
export function mascotSvg(mood: MascotMood): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" fill="none" aria-hidden="true" focusable="false">${BACK}${FACES[mood]}</svg>`
}
