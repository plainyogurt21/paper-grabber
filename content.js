// content.js - Paper Grabber scraper

// Guard against double-injection. content.js is registered as a content_script
// (auto-injected at document_idle) AND injected programmatically by popup.js each
// time the popup opens. Without this guard the second run re-declares EXCLUDE_CSS
// and throws "Identifier 'EXCLUDE_CSS' has already been declared". The first
// injection's message listener stays active, so a re-injection can safely no-op.
if (!window.__paperGrabberInjected) {
  window.__paperGrabberInjected = true;

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim()
    .substring(0, 60);
}

function extractMetadata() {
  const meta = {};

  meta.title =
    document.querySelector('meta[name="citation_title"]')?.content ||
    document.querySelector('meta[property="og:title"]')?.content ||
    document.querySelector('h1.article-title, h1.title, h1')?.innerText ||
    document.title || 'untitled';
  meta.title = meta.title.split('|')[0].split(' - ')[0].trim();

  const authorMeta =
    document.querySelector('meta[name="citation_author"]')?.content ||
    document.querySelector('meta[name="author"]')?.content ||
    document.querySelector('meta[property="article:author"]')?.content;

  if (authorMeta) {
    const parts = authorMeta.split(',');
    meta.firstAuthor = parts.length > 1 ? parts[0].trim() : authorMeta.split(' ').pop();
  } else {
    const authorEl = document.querySelector(
      '.author-name, .contrib-author, [class*="author"] a, .authors a'
    );
    if (authorEl) {
      const name = authorEl.innerText.trim().split(' ');
      meta.firstAuthor = name[name.length - 1];
    } else {
      meta.firstAuthor = 'Unknown';
    }
  }

  meta.year =
    document.querySelector('meta[name="citation_publication_date"]')?.content?.substring(0, 4) ||
    document.querySelector('meta[name="citation_date"]')?.content?.substring(0, 4) ||
    document.querySelector('meta[name="DC.Date"]')?.content?.substring(0, 4) ||
    document.querySelector('time[datetime]')?.getAttribute('datetime')?.substring(0, 4) ||
    new Date().getFullYear().toString();

  // Filename is the slugified title, truncated to the first 20 characters.
  meta.baseName = slugify(meta.title).substring(0, 20) || 'untitled';
  return meta;
}

// ── Two-layer exclusion ──────────────────────────────────────────────────────
//
// Layer 1: CSS selector — catches containers by identity
// Layer 2: URL pattern — catches reference linkout URLs that escape the DOM
//          (e.g. Elsevier renders some ref links outside the backmatter div)

// CSS selectors for containers whose links are never paper downloads
const EXCLUDE_CSS = [
  // References / bibliography — cover all known patterns
  '#references', '#bibliography', '#backmatter',
  '[role="doc-bibliography"]',
  '.references', '.reference-list', '.ref-list',
  '.citations',        // Elsevier individual citation blocks
  '.citation-list',
  // Elsevier-specific: the external-links block inside each citation
  '.external-links',   // ← this is the key one: all ref PDF links live here
  '.core-xlink-pdf', '.core-xlink-fulltext',

  // Footer containers — use class-contains to catch vendor variants
  'footer', '#footer',
  '[class*="footer"]',   // footer__bottom, footerLink, footerHeading, etc.
  '.site-footer', '.page-footer',

  // Navigation
  'nav', 'header',
  '[role="navigation"]', '[role="banner"]',
  '.navbar', '.navigation', '.nav-bar',

  // Social / share / cite
  '[class*="share"]', '[class*="social"]',
  '[class*="cite-this"]', '[class*="citation-tool"]',
  '.altmetric', '.article-tools',

  // Ads
  '.advertisement', '.ad-slot', '[class*="promo"]',
].join(', ');

// URL patterns that are always reference linkout URLs, never the paper itself
// These catch Elsevier/SpringerLink/Wiley reference resolution links
const EXCLUDE_URL_PATTERNS = [
  /\/servlet\/linkout/,          // Elsevier reference resolver
  /linkinghub\.elsevier\.com\/retrieve/,
  /link\.springer\.com\/article.*\?.*ref=/,
  /onlinelibrary\.wiley\.com\/doi.*\?.*ref=/,
  /scholar\.google\.com\/scholar/,  // Google Scholar links
  /scopus\.com/,                 // Scopus links
  /doi\.org\/10\.\d{4,}/,        // bare DOI links in reference lists (heuristic)
  /pubmed\.ncbi\.nlm\.nih\.gov/, // PubMed links
  /ncbi\.nlm\.nih\.gov\/pmc/,    // PMC links (these are OTHER papers' pages, not files)
  /crossref\.org/,
];

function isExcludedLink(el, href) {
  // Layer 1: DOM ancestry — use element.closest() for speed
  // If the link is inside any excluded container, skip it
  try {
    if (el.closest(EXCLUDE_CSS)) return true;
  } catch (_) {
    // If closest() fails (malformed selector), fall back to manual walk
    let node = el.parentElement;
    while (node) {
      for (const sel of EXCLUDE_CSS.split(', ')) {
        try { if (node.matches(sel)) return true; } catch (_) {}
      }
      node = node.parentElement;
    }
  }

  // Layer 2: URL pattern — catches links that escaped DOM exclusion
  for (const pattern of EXCLUDE_URL_PATTERNS) {
    if (pattern.test(href)) return true;
  }

  return false;
}

// ── Scoring ──────────────────────────────────────────────────────────────────
function scoreLink(href, text) {
  const h = href.toLowerCase();
  const combined = h + ' ' + text.toLowerCase();
  let score = 0;

  if (h.includes('.pdf'))                                                    score += 40;
  if (h.includes('.docx') || (h.includes('.doc') && !h.includes('.docx'))) score += 40;
  if (/supplement|supplementary|supporting.info|appendix|suppl[_/]|sdc\d*/i.test(combined))  score += 30;
  if (/\[pdf\]/i.test(combined))                                                            score += 25;
  if (/s\d+[._-]?(fig|table|data|file)/i.test(combined))                    score += 25;
  if (/download/i.test(combined))                                            score += 15;
  if (/full.text|full.article|view.pdf/i.test(combined))                    score += 15;
  if (/data.availability|extended.data/i.test(combined))                    score += 20;
  if (/pdf/i.test(combined) && !h.includes('.pdf'))                         score += 10;
  if (/article|paper|manuscript/i.test(combined))                           score += 5;

  if (/cookie|login|sign.?in|register|subscribe|copyright|terms|privacy/i.test(combined)) score -= 60;
  if (/cite.this|how.to.cite|citation.manager|export.citation/i.test(combined))           score -= 40;
  if (/share|tweet|facebook|linkedin|email.article/i.test(combined))                      score -= 30;
  if (/sitemap|site.map/i.test(combined))                                                 score -= 60;
  if (/correction|erratum|retraction/i.test(combined))                                    score -= 10;
  if (h.includes('.epub'))                                                                score -= 80;
  if (h.startsWith('javascript') || h.startsWith('mailto'))                              score -= 100;
  if (h.startsWith('#'))                                                                  score -= 100;

  return score;
}

function classifyType(href, text) {
  const combined = (href + ' ' + text).toLowerCase();
  const h = href.toLowerCase();

  if (/^(download pdf|full.?text pdf|full article|view pdf|pdf$)/i.test(text.trim())) {
    return 'main';
  }
  if (/full.text|full.article|download.pdf/i.test(combined) && !/supplement|supplementary|appendix/i.test(combined)) {
    return 'main';
  }
  if (/supplement|supplementary|supporting.info|appendix|suppl[_/]|suppl_file|sdc\d*|extended.data|data\.s\d|table\.s\d|figure\.s\d|s\d+[._-]|analysis.code|_code\.|supp.meth/i.test(combined)) {
    return 'supplement';
  }
  if (h.includes('.pdf')) return 'main';
  return 'pdf';
}

// ── Main finder ──────────────────────────────────────────────────────────────
function findPDFLinks() {
  const results = [];

  const citationPdf = document.querySelector('meta[name="citation_pdf_url"]')?.content;
  if (citationPdf) {
    results.push({ url: citationPdf, type: 'main', label: 'Main PDF (meta)', score: 999 });
  }

  for (const link of document.querySelectorAll('a[href]')) {
    const href = link.href || '';
    if (isExcludedLink(link, href)) continue;

    const text = (link.innerText || link.title || link.getAttribute('aria-label') || '').trim();

    // For NEJM-style supplement blocks, the meaningful label lives in the
    // sibling .core-description element, not inside the <a> itself.
    const listItem = link.closest('[role="listitem"], li, .core-supplementary-material');
    const nearbyLabel = listItem?.querySelector('.core-label, .core-description')?.innerText?.trim();

    // For LWW/Wolters Kluwer, supplement links live in #ej-article-sam; inject
    // the section heading text so scoring and classification work correctly.
    const lwwSamSection = link.closest('#ej-article-sam, [id*="article-sam"]');
    const lwwPrefix = lwwSamSection ? 'Supplemental Digital Content ' : '';

    const effectiveText = lwwPrefix + (nearbyLabel || text);

    const score = scoreLink(href, effectiveText);

    if (score >= 20) {
      results.push({
        url: href,
        text: effectiveText,
        type: classifyType(href, effectiveText),
        label: effectiveText || href.split('/').pop(),
        score
      });
    }
  }

  const byUrl = new Map();
  for (const r of results) {
    if (!byUrl.has(r.url) || byUrl.get(r.url).score < r.score) {
      byUrl.set(r.url, r);
    }
  }

  const typeOrder = { main: 0, supplement: 1, pdf: 2 };
  return Array.from(byUrl.values()).sort((a, b) => {
    const td = typeOrder[a.type] - typeOrder[b.type];
    return td !== 0 ? td : b.score - a.score;
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrape') {
    const metadata = extractMetadata();
    const pdfLinks = findPDFLinks();
    sendResponse({ metadata, pdfLinks });
  }
  return true;
});

} // end double-injection guard
