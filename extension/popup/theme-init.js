(() => {
  try {
    const pref = localStorage.getItem('pocketpigeon.theme') || 'system';
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = pref === 'dark' || pref === 'light' ? pref : (dark ? 'dark' : 'light');
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePref = pref;
  } catch {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.themePref = 'system';
  }
})();
