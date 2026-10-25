self.errors = []
self.addEventListener("error", (e) => self.errors.push(String(e.message)))
try {
  chrome.webRequest.onBeforeRequest.addListener(
    (d) => (d.url.includes("s=s3") ? { cancel: true } : {}),
    { urls: ["<all_urls>"] },
    ["blocking"]
  )
  self.added = "added"
} catch (e) {
  self.added = "threw: " + e.message
}
