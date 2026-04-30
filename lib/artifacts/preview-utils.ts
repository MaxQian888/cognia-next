/**
 * Artifact preview utility functions
 * Pure functions for iframe-based rendering (HTML, SVG, React)
 */

import DOMPurify from "dompurify"

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

/**
 * Render sanitized HTML content into an iframe document
 */
export function renderHTML(doc: Document, content: string): void {
  const sanitized = DOMPurify.sanitize(content, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["style", "link", "meta"],
    ADD_ATTR: ["target", "rel", "class", "id", "style"],
    ALLOW_DATA_ATTR: true,
  })
  doc.open()
  doc.write(sanitized)
  doc.close()
}

/**
 * Render sanitized SVG content into an iframe document
 */
export function renderSVG(doc: Document, content: string): void {
  const sanitized = DOMPurify.sanitize(content, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["style"],
  })
  doc.open()
  doc.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #f5f5f5; }
        svg { max-width: 100%; max-height: 100vh; }
      </style>
    </head>
    <body>${sanitized}</body>
    </html>
  `)
  doc.close()
}

/**
 * Localized strings injected into the React preview iframe shell.
 */
export interface ReactShellMessages {
  cdnLoadTitle: string
  cdnLoadDescription: string
  noComponentFound: string
}

/**
 * Generate a static HTML shell for React preview.
 * Content is received via postMessage to prevent XSS via template string injection.
 * Uses React 19 CDN and CSP meta tag to restrict external requests.
 *
 * `messages` is JSON-serialized into the inline script — values may contain any
 * characters; JSON.stringify handles all required escaping (quotes, backslashes,
 * unicode, and the </script> sequence is broken with a closing-tag escape).
 */
export function getReactShellHtml(messages: ReactShellMessages): string {
  const messagesJson = JSON.stringify(messages).replace(/<\//g, "<\\/")
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.tailwindcss.com; style-src 'unsafe-inline' https://cdn.tailwindcss.com; img-src data: blob:; font-src data:;">
  <script src="https://unpkg.com/react@19/umd/react.development.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@19/umd/react-dom.development.js" crossorigin></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { margin: 0; padding: 16px; font-family: system-ui, -apple-system, sans-serif; }
    * { box-sizing: border-box; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    var __ARTIFACT_MSG = ${messagesJson};
    function _escapeMsg(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // CDN load check with timeout
    var _cdnTimeout = setTimeout(function() {
      if (typeof React === 'undefined' || typeof ReactDOM === 'undefined' || typeof Babel === 'undefined') {
        document.getElementById('root').innerHTML =
          '<div style="color: #b45309; padding: 16px; background: #fef3c7; border-radius: 8px;">' +
          '<strong>' + _escapeMsg(__ARTIFACT_MSG.cdnLoadTitle) + '</strong>' +
          '<p style="margin:8px 0 0">' + _escapeMsg(__ARTIFACT_MSG.cdnLoadDescription) + '</p></div>';
      }
    }, 15000);

    // Receive component code via postMessage (secure: no template injection)
    window.addEventListener('message', function(event) {
      if (!event.data || event.data.type !== 'render-component') return;
      clearTimeout(_cdnTimeout);
      var code = event.data.code;
      try {
        // Create a script element with Babel transpilation
        var scriptEl = document.createElement('script');
        scriptEl.setAttribute('type', 'text/babel');
        scriptEl.setAttribute('data-presets', 'react');
        scriptEl.textContent = code + '\\n' +
          ';(function() {' +
          '  var components = [' +
          '    typeof App !== "undefined" ? App : null,' +
          '    typeof Component !== "undefined" ? Component : null,' +
          '    typeof Main !== "undefined" ? Main : null,' +
          '  ].filter(Boolean);' +
          '  if (components.length > 0) {' +
          '    var root = ReactDOM.createRoot(document.getElementById("root"));' +
          '    root.render(React.createElement(components[0]));' +
          '  } else {' +
          '    document.getElementById("root").innerHTML = "<p style=\\"color: #666;\\">" + _escapeMsg(__ARTIFACT_MSG.noComponentFound) + "</p>";' +
          '  }' +
          '})();';
        document.body.appendChild(scriptEl);
        // Trigger Babel to process the new script
        if (typeof Babel !== 'undefined' && Babel.transformScriptTags) {
          Babel.transformScriptTags();
        }
      } catch (error) {
        document.getElementById('root').innerHTML = '<div style="color: red; padding: 16px; background: #fee; border-radius: 8px;"><strong>Error:</strong> ' + _escapeMsg(error.message) + '</div>';
        window.parent.postMessage({ type: 'artifact-preview-error', message: error.message }, '*');
      }
    });
  </script>
</body>
</html>`
}
