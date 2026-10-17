// Search existing controls and navigate to them; no mirrored settings or state.
export function installSettingsDiscovery(popup, activateTab) {
  const shell = popup.querySelector('.wg-settings-shell');
  if (!shell) return () => {};
  const box = document.createElement('div'); box.className = 'wg-settings-find';
  const search = document.createElement('input'); search.type = 'search';
  search.placeholder = 'Find a setting: toolbar, Anima, color…';
  search.setAttribute('aria-label', 'Find a Prompt Palette setting');
  const count = document.createElement('small'); count.setAttribute('role', 'status');
  const results = document.createElement('div'); results.className = 'wg-settings-find-results'; results.hidden = true;
  box.append(search, count, results); shell.before(box);
  let marked = null;
  const clearMark = () => { marked?.classList.remove('wg-setting-found'); marked = null; };
  function render() {
    results.replaceChildren();
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    results.hidden = !terms.length; count.textContent = '';
    if (!terms.length) return;
    const candidates = [], seen = new Set();
    for (const control of shell.querySelectorAll('input, select, textarea, button')) {
      if (control.closest('.wg-theme-gallery, .wg-theme-pack-strip, [data-toolbar-order]')) continue;
      const panel = control.closest('[data-settings-panel]'); if (!panel) continue;
      const row = control.closest('label, .wg-toggle-card, .wg-color-field, .wg-swatch-item') || control;
      if (seen.has(row)) continue;
      seen.add(row);
      const label = row.querySelector('strong, .wg-swatch-label, span')?.textContent || control.getAttribute('aria-label') || control.textContent || control.placeholder;
      if (!label?.trim()) continue;
      const tab = [...shell.querySelectorAll('[data-settings-tab]')].find(el => el.dataset.settingsTab === panel.dataset.settingsPanel);
      const text = `${row.textContent} ${label} ${control.getAttribute('aria-label') || ''} ${tab?.textContent || ''}`.toLowerCase();
      if (terms.every(term => text.includes(term))) candidates.push({ row, control, panel, label: label.trim(), tab });
    }
    count.textContent = candidates.length ? `${candidates.length} matching settings${candidates.length > 20 ? ' · showing first 20' : ''}` : 'No matching settings. Try a shorter term.';
    for (const { row, control, panel, label, tab } of candidates.slice(0, 20)) {
      const button = document.createElement('button'); button.type = 'button';
      const title = document.createElement('strong'); title.textContent = label;
      const category = document.createElement('small'); category.textContent = tab?.querySelector('span')?.textContent || panel.dataset.settingsPanel;
      button.append(title, category);
      button.addEventListener('click', () => {
        activateTab(panel.dataset.settingsPanel);
        for (let el = control.parentElement; el && el !== panel; el = el.parentElement) if (el.tagName === 'DETAILS') el.open = true;
        clearMark(); marked = row; row.classList.add('wg-setting-found');
        search.value = ''; results.hidden = true; count.textContent = '';
        row.scrollIntoView({ block: 'center', behavior: 'instant' });
        if (!control.disabled) control.focus({ preventScroll: true });
        else panel.querySelector('summary, button, input:not(:disabled)')?.focus({ preventScroll: true });
      });
      results.append(button);
    }
  }
  function keydown(event) {
    if (event.key === 'ArrowDown' && !results.hidden) { event.preventDefault(); results.querySelector('button')?.focus(); }
    if (event.key === 'Escape' && search.value) { event.preventDefault(); event.stopPropagation(); search.value = ''; render(); }
  }
  search.addEventListener('input', render); search.addEventListener('keydown', keydown);
  return () => { clearMark(); search.removeEventListener('input', render); search.removeEventListener('keydown', keydown); box.remove(); };
}
