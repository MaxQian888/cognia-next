/**
 * The page the capture specs read.
 *
 * Every trap in it is one the extractor promises to avoid, and every one of
 * them needs a real layout engine to detect: `display: none`, `visibility:
 * hidden`, `opacity: 0` and `aria-hidden` are all invisible to a parser over
 * serialized markup, which is why `@cognia/document`'s cheerio parser cannot
 * be the extractor and why this fixture cannot be a jsdom document either —
 * jsdom has no layout, so `getComputedStyle` there returns the declared value
 * rather than the resolved one.
 *
 * Each marker string is unique and searched for by name, so a failure names
 * the specific rule that broke instead of reporting a diff of the whole page.
 */
export const CAPTURE_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Quarterly figures — Example Corp</title>
    <style>
      .gone { display: none; }
      .invisible { visibility: hidden; }
      .transparent { opacity: 0; }
      /* A style sheet's own text must never reach a prompt. */
      .marker::after { content: "STYLESHEET-TEXT"; }
    </style>
  </head>
  <body>
    <h1>Quarterly figures</h1>
    <p id="lead">VISIBLE-LEAD Revenue rose in the third quarter across every region.</p>
    <p>VISIBLE-BODY The board will review the figures next Tuesday.</p>

    <div class="gone">HIDDEN-DISPLAY-NONE</div>
    <div class="invisible">HIDDEN-VISIBILITY</div>
    <div class="transparent">HIDDEN-OPACITY</div>
    <div aria-hidden="true">HIDDEN-ARIA</div>
    <div hidden>HIDDEN-ATTRIBUTE</div>
    <div style="display: block"><span class="gone">HIDDEN-NESTED-ANCESTOR</span></div>

    <form>
      <label for="pw">Password</label>
      <input id="pw" type="password" value="HIDDEN-PASSWORD-VALUE" />
      <input id="text" type="text" value="HIDDEN-INPUT-VALUE" />
      <textarea id="draft">HIDDEN-TEXTAREA-VALUE</textarea>
      <select><option>HIDDEN-OPTION-VALUE</option></select>
    </form>

    <div contenteditable="true">HIDDEN-CONTENTEDITABLE</div>

    <iframe title="embedded" srcdoc="<p>HIDDEN-IFRAME-TEXT</p>"></iframe>

    <script>
      globalThis.__marker = "HIDDEN-SCRIPT-TEXT"
    </script>
  </body>
</html>`

/** Text that must appear in a whole-page capture. */
export const VISIBLE_MARKERS = ["VISIBLE-LEAD", "VISIBLE-BODY", "Quarterly figures"]

/**
 * Text that must never appear in any capture.
 *
 * Asserted as a set rather than one at a time so a regression that reopens
 * several of these at once is reported as several, not as the first.
 */
export const FORBIDDEN_MARKERS = [
  "HIDDEN-DISPLAY-NONE",
  "HIDDEN-VISIBILITY",
  "HIDDEN-OPACITY",
  "HIDDEN-ARIA",
  "HIDDEN-ATTRIBUTE",
  "HIDDEN-NESTED-ANCESTOR",
  "HIDDEN-PASSWORD-VALUE",
  "HIDDEN-INPUT-VALUE",
  "HIDDEN-TEXTAREA-VALUE",
  "HIDDEN-OPTION-VALUE",
  "HIDDEN-CONTENTEDITABLE",
  "HIDDEN-IFRAME-TEXT",
  "HIDDEN-SCRIPT-TEXT",
  "STYLESHEET-TEXT",
]
