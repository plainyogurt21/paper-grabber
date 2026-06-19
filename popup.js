// popup.js

let scrapedData = null;

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim()
    .substring(0, 60);
}

function getExtension(url) {
  const u = url.toLowerCase().split('?')[0]; // strip query params before checking extension
  if (u.endsWith('.docx')) return '.docx';
  if (u.endsWith('.doc'))  return '.doc';
  if (u.endsWith('.xlsx')) return '.xlsx';
  return '.pdf';
}

function setStatus(msg, kind = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = kind;
}

function setButtons(disabled) {
  ['btn-download-folder', 'btn-download-selected']
    .forEach(id => document.getElementById(id).disabled = disabled);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendMsg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

// ── Assign filenames ──────────────────────────────────────────────────────────
// Main paper:        Author_Year_Title.pdf
// Supplements:       Author_Year_Title_supplement.pdf
//                    Author_Year_Title_supplement_2.pdf  (if multiple)
// Inside folder:     Author_Year_Title/Author_Year_Title.pdf
//                    Author_Year_Title/Author_Year_Title_supplement.pdf
function assignFilenames(pdfLinks, baseName) {
  let mainIdx = 0, suppIdx = 0, otherIdx = 0;
  const usedNames = new Map();

  pdfLinks.forEach(file => {
    const ext = getExtension(file.url);
    if (file.type === 'main') {
      // First main = plain name; extras get _2, _3 to avoid collisions
      const suffix = mainIdx === 0 ? '' : `_${mainIdx + 1}`;
      mainIdx++;
      file._name = `${baseName}${suffix}${ext}`;
    } else if (file.type === 'supplement') {
      const suffix = suppIdx === 0 ? '_supplement' : `_supplement_${suppIdx + 1}`;
      suppIdx++;
      file._name = `${baseName}${suffix}${ext}`;
    } else {
      // Generic PDF links: name by link text so each file gets a meaningful name
      otherIdx++;
      const rawLabel = file.label || file.text || '';
      const slug = slugify(rawLabel).substring(0, 60);
      const base = slug || `file_${otherIdx}`;
      const count = usedNames.get(base) || 0;
      usedNames.set(base, count + 1);
      file._name = count === 0 ? `${base}${ext}` : `${base}_${count + 1}${ext}`;
    }
  });
}

// ── Render file list ──────────────────────────────────────────────────────────
function renderFiles(pdfLinks, baseName) {
  const list = document.getElementById('file-list');
  list.innerHTML = '';

  if (!pdfLinks?.length) {
    list.innerHTML = `<div class="empty-state">No PDF or DOCX links found on this page.</div>`;
    return;
  }

  assignFilenames(pdfLinks, baseName);

  pdfLinks.forEach((file, i) => {
    const preChecked = file.type === 'main' || file.type === 'supplement';
    const row = document.createElement('div');
    row.className = `file-row${preChecked ? ' selected' : ''}`;
    row.innerHTML = `
      <input type="checkbox" id="chk_${i}" ${preChecked ? 'checked' : ''}>
      <span class="file-badge badge-${file.type}">${file.type}</span>
      <span class="file-label" title="${file._name}">${file.label || file._name}</span>
    `;
    row.addEventListener('click', e => {
      if (e.target.tagName !== 'INPUT') row.querySelector('input').checked ^= true;
      row.classList.toggle('selected', row.querySelector('input').checked);
    });
    list.appendChild(row);
  });

  setButtons(false);
}

function getSelected(files) {
  return files.filter((_, i) => document.querySelector(`#chk_${i}`)?.checked);
}

// ── Download: into a folder (baseName/filename) ───────────────────────────────
async function downloadToFolder(files, baseName, tabId) {
  const selected = getSelected(files);
  if (!selected.length) { setStatus('No files selected.', 'error'); return; }

  setButtons(true);
  setStatus(`Downloading ${selected.length} file(s) into folder…`, 'info');

  let done = 0, skipped = 0;
  for (const file of selected) {
    // Chrome downloads API: if filename contains a slash, it creates a subfolder
    const folderPath = `${baseName}/${file._name}`;
    const resp = await sendMsg({ action: 'download', url: file.url, filename: folderPath, tabId });
    if (resp?.success) {
      done++;
    } else if (resp?.error === 'html_page') {
      skipped++;
      console.warn('Paper Grabber: skipped HTML page (not a direct file):', file.url);
    }
    await sleep(350); // slight gap so Chrome doesn't batch-rename them
  }

  const skipNote = skipped ? ` (${skipped} skipped — not a direct PDF link)` : '';
  setStatus(`✓ ${done}/${selected.length} saved to "${baseName}/" folder${skipNote}`);
  setButtons(false);
}

// ── Download: flat, no folder ─────────────────────────────────────────────────
async function downloadFlat(files, tabId) {
  const selected = getSelected(files);
  if (!selected.length) { setStatus('No files selected.', 'error'); return; }

  setButtons(true);
  let done = 0, skipped = 0;
  for (const file of selected) {
    setStatus(`⬇ ${file._name}`, 'info');
    const resp = await sendMsg({ action: 'download', url: file.url, filename: file._name, tabId });
    if (resp?.success) {
      done++;
    } else if (resp?.error === 'html_page') {
      skipped++;
      console.warn('Paper Grabber: skipped HTML page (not a direct file):', file.url);
    }
    await sleep(350);
  }
  const skipNote = skipped ? ` (${skipped} skipped — not a direct PDF link)` : '';
  setStatus(`✓ Downloaded ${done} file(s)${skipNote}`);
  setButtons(false);
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (_) {}

  chrome.tabs.sendMessage(tab.id, { action: 'scrape' }, response => {
    if (chrome.runtime.lastError || !response) {
      document.getElementById('filename-preview').textContent = 'Could not scan page.';
      document.getElementById('file-list').innerHTML =
        `<div class="empty-state">Reload the page and try again.</div>`;
      return;
    }
    scrapedData = response;
    const { metadata, pdfLinks } = response;
    document.getElementById('filename-preview').textContent = metadata.baseName + '/';
    renderFiles(pdfLinks, metadata.baseName);
  });

  document.getElementById('btn-download-folder').addEventListener('click', () => {
    if (scrapedData) downloadToFolder(scrapedData.pdfLinks, scrapedData.metadata.baseName, tab.id);
  });

  document.getElementById('btn-download-selected').addEventListener('click', () => {
    if (scrapedData) downloadFlat(scrapedData.pdfLinks, tab.id);
  });
});
