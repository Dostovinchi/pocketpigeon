const blobUrls = new Map();

function sanitizeName(name) {
  const raw = String(name || 'pocketpigeon-file').trim();
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 160);
  return cleaned || 'pocketpigeon-file';
}

async function copyText(text) {
  const value = String(text || '');
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {}
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy_failed');
}

function base64ToBytes(text) {
  const bin = atob(String(text || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function createBlobUrl({ name, mime, dataB64 }) {
  const bytes = base64ToBytes(dataB64);
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  blobUrls.set(url, Date.now());
  setTimeout(() => {
    URL.revokeObjectURL(url);
    blobUrls.delete(url);
  }, 120000);
  return { ok: true, url, size: bytes.byteLength, name: sanitizeName(name) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (sender && sender.id !== chrome.runtime.id) return false;

  if (msg.type === 'copy') {
    copyText(msg.text)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'blob') {
    try {
      sendResponse(createBlobUrl(msg));
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return false;
  }
  if (msg.type === 'revoke' && msg.url) {
    URL.revokeObjectURL(msg.url);
    blobUrls.delete(msg.url);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
