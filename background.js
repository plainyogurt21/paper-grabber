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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'download') {
    (async () => {
      let targetUrl = request.url;

      try {
        const headRes = await fetch(targetUrl, { method: 'HEAD', credentials: 'include' });
        const ct = (headRes.headers.get('content-type') || '').toLowerCase();

        if (ct.includes('text/html')) {
          // Layer 1: parse the static fetched HTML
          const fromFetch = await extractPdfFromFetch(targetUrl);
          if (fromFetch) {
            targetUrl = fromFetch;
          } else if (request.tabId) {
            // Layer 2: run in the live tab DOM (handles JS-rendered viewers)
            const fromTab = await extractPdfFromTab(request.tabId);
            if (fromTab) {
              targetUrl = fromTab;
            } else {
              sendResponse({ success: false, error: 'html_page' });
              return;
            }
          } else {
            sendResponse({ success: false, error: 'html_page' });
            return;
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
