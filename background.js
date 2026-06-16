// background.js

function doDownload(url, filename, sendResponse) {
  chrome.downloads.download(
    { url, filename, saveAs: false },
    (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) { sendResponse({ success: false, error: err.message }); return; }

      // Cancel immediately if the server sends back HTML instead of a file
      const listener = (delta) => {
        if (delta.id !== downloadId) return;
        const mime = delta.mime?.current || '';
        if (mime && mime.includes('text/html')) {
          chrome.downloads.cancel(downloadId);
          chrome.downloads.erase({ id: downloadId });
          chrome.downloads.onChanged.removeListener(listener);
          sendResponse({ success: false, error: 'html_page' });
        } else if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          if (delta.state.current === 'complete') {
            sendResponse({ success: true, downloadId });
          }
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    }
  );
}

// Parse fetched HTML text for a direct PDF URL (static HTML, no JS rendering).
async function extractPdfFromFetch(pageUrl) {
  let res, html;
  try {
    res = await fetch(pageUrl, { credentials: 'include' });
    // If the redirect landed directly on a PDF (or other binary), return the final URL
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/html')) return res.url || pageUrl;
    html = await res.text();
  } catch {
    return null;
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');

  const metaPdf = doc.querySelector('meta[name="citation_pdf_url"]')?.content;
  if (metaPdf) return metaPdf;

  for (const el of doc.querySelectorAll('iframe[src], embed[src]')) {
    const src = el.getAttribute('src') || '';
    if (/\.pdf|\bpdf\b/i.test(src)) return new URL(src, pageUrl).href;
  }

  const PDF_HREF = /\.pdf(\?|$)|\/pdf\/|\/full[-_]?pdf|\/download.*pdf|pdfft|\/epdf/i;
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (PDF_HREF.test(href) && !/references|bibliography|login|register/i.test(href)) {
      return new URL(href, pageUrl).href;
    }
  }

  const refresh = doc.querySelector('meta[http-equiv="refresh"]')?.content || '';
  const m = refresh.match(/url=([^\s;]+)/i);
  if (m) return new URL(m[1], pageUrl).href;

  return null;
}

// Run a finder in the tab's live DOM (handles JS-rendered pages).
// This is the same logic as above but executed inside the page via scripting.
function extractPdfFromTab(tabId) {
  return new Promise(resolve => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: () => {
          const metaPdf = document.querySelector('meta[name="citation_pdf_url"]')?.content;
          if (metaPdf) return metaPdf;

          for (const el of document.querySelectorAll('iframe[src], embed[src]')) {
            const src = el.getAttribute('src') || '';
            if (/\.pdf|\bpdf\b/i.test(src)) return el.src;
          }

          const PDF_HREF = /\.pdf(\?|$)|\/pdf\/|\/full[-_]?pdf|\/download.*pdf|pdfft|\/epdf/i;
          const SKIP = /references|bibliography|login|register|sitemap/i;
          for (const a of document.querySelectorAll('a[href]')) {
            if (PDF_HREF.test(a.href) && !SKIP.test(a.href)) return a.href;
          }

          return null;
        }
      },
      (results) => {
        if (chrome.runtime.lastError || !results?.[0]?.result) {
          resolve(null);
        } else {
          resolve(results[0].result);
        }
      }
    );
  });
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Wait until a tab finishes loading (or a timeout elapses).
function waitForTabComplete(tabId, timeoutMs = 12000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    // It may already be complete by the time we start listening.
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') finish(); }).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

// Open the page in a background tab, let it render, and pull a downloadable
// file out of it. Handles JS-rendered viewers (Sage reader), landing pages
// (AHA/Nature), and interstitials/cookie-walls (PMC) that block a plain HEAD.
// Returns a direct file URL, or null if nothing downloadable was found.
async function navigateAndExtract(url) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch {
    return null;
  }
  const tabId = tab.id;

  try {
    await waitForTabComplete(tabId);
    // Give late/JS-rendered content (PDF viewers, embeds) time to attach.
    await delay(1500);

    // 1) Did navigating resolve straight to a real file? (e.g. PMC .pdf links
    //    that 403/HTML on HEAD but serve the PDF once cookies are set.)
    const info = await chrome.tabs.get(tabId).catch(() => null);
    const finalUrl = info?.url || url;
    try {
      const r = await fetch(finalUrl, { method: 'GET', credentials: 'include' });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.includes('text/html')) return r.url || finalUrl;
    } catch { /* fall through to DOM extraction */ }

    // 2) Extract a PDF link/embed from the now-rendered DOM.
    const found = await extractPdfFromTab(tabId);
    if (found) return found;

    return null;
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'download') {
    (async () => {
      let targetUrl = request.url;

      try {
        const headRes = await fetch(targetUrl, { method: 'HEAD', credentials: 'include' });
        const ct = (headRes.headers.get('content-type') || '').toLowerCase();

        if (ct.includes('text/html')) {
          // Layer 1: parse the static fetched HTML (fast path, no tab needed).
          const fromFetch = await extractPdfFromFetch(targetUrl);
          if (fromFetch) {
            targetUrl = fromFetch;
          } else {
            // Layer 2: actually navigate to the page in a background tab, wait
            // for it to render, then extract the file. Handles JS viewers,
            // landing pages, and PMC interstitials that block a plain fetch.
            const fromNav = await navigateAndExtract(targetUrl);
            if (fromNav) {
              targetUrl = fromNav;
            } else {
              sendResponse({ success: false, error: 'html_page' });
              return;
            }
          }
        }
      } catch {
        // HEAD failed (e.g. CORS on redirect URLs like links.lww.com) —
        // fall through to doDownload which will cancel if the server returns HTML
      }

      doDownload(targetUrl, request.filename, sendResponse);
    })();
    return true;
  }
});
