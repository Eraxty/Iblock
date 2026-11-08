// Runs before the stylesheet paints so the popup never flashes the wrong theme.
try {
  const theme = localStorage.getItem('iblock:theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage can be unavailable; the system theme is a fine fallback.
}
