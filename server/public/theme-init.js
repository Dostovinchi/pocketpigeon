(() => {
  try {
    const pref = localStorage.getItem('pocketpigeon.theme') || 'system';
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = pref === 'dark' || pref === 'light' ? pref : (dark ? 'dark' : 'light');
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePref = pref;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0a0f14' : '#f6f1e7');
  } catch {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.themePref = 'system';
  }
})();
