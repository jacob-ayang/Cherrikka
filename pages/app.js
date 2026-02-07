(function () {
  const storageKey = 'cherrikka-pages-theme';
  const body = document.body;
  const buttons = Array.from(document.querySelectorAll('.theme-btn'));

  function applyTheme(theme) {
    const resolved = theme === 'light' ? 'light' : 'dark';
    body.setAttribute('data-theme', resolved);
    buttons.forEach((btn) => {
      const active = btn.getAttribute('data-theme-target') === resolved;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    try {
      localStorage.setItem(storageKey, resolved);
    } catch (_) {
      // ignore storage errors
    }
  }

  let initialTheme = 'dark';
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'dark' || saved === 'light') {
      initialTheme = saved;
    }
  } catch (_) {
    // ignore storage errors
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      applyTheme(btn.getAttribute('data-theme-target') || 'dark');
    });
  });

  applyTheme(initialTheme);
})();
