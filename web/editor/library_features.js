import { createSmartCollections } from './smart_collections.js';
import { createGenerationHistory } from './generation_history.js';
import { createRelationshipEditor } from './relationship_editor.js';
import { relationshipConfig, applyRelationshipConfig } from './relationship_runtime.js';
import { readEditorPreference, writeEditorPreference } from '../prompt_palette_state.js';

const PREF_SHOW_SHORTCUT = 'showRecentGenerationsShortcut';

// One host adapter for the existing Library surfaces. Components remain shared,
// and all metadata controls live in the existing library settings/menu area.
export function mountLibraryFeatures({ host, settingsHost = host, node = null, getNode = () => node,
  getItems, getPinned, getThumbnails, onFilter, onView, onOpenEntry, announce = () => {}, restore,
  content = [], includeHistory = true } = {}) {
  if (!host) {
    return {
      filter: items => items,
      refresh() {},
      setActive() {},
      cleanup() {}
    };
  }
  const targetSettingsHost = settingsHost || host;
  let disposed = false, historyOpen = false;

  const menu = document.createElement('details'); menu.className = 'pp-library-features';
  const summary = document.createElement('summary'); summary.textContent = 'Collections, relationships & dependencies';
  const body = document.createElement('div'); body.className = 'pp-library-feature-body'; menu.append(summary, body);
  targetSettingsHost.append(menu);
  const smartHost = document.createElement('section'); body.append(smartHost);
  const smart = createSmartCollections(smartHost, {
    getItems, getPinned, getThumbnails,
    onFilter: controller => { const view=controller?.getView?.(); if(view) onView?.(view); onFilter?.(); },
    onOpenEntry: (path, options) => onOpenEntry?.(path, options),
    getRelationshipConfig: () => relationshipConfig(getNode()),
    announce
  });
  const relationDetails = document.createElement('details'), relationSummary = document.createElement('summary'); relationSummary.textContent = 'Smart wildcard relationships'; relationDetails.append(relationSummary); body.append(relationDetails);
  const relations = createRelationshipEditor(relationDetails, { getLibrary: getItems, getConfig: () => relationshipConfig(getNode()), getTarget: getNode, onApply: config => {
    const target = getNode(); if (!target) throw new Error('Choose a Prompt Palette node as the target first.');
    applyRelationshipConfig(target, config); announce('Relationship rules applied to the selected node.');
  } });

  let toggle = null, historyHost = null, history = null, histSettingsSection = null;
  let toggleHistory = null, shortcutCheckbox = null, onShortcutChange = null, openHistBtn = null, onOpenClick = null;

  if (includeHistory) {
    // Optional shortcut toggle button in the library panel
    let showShortcut = readEditorPreference(PREF_SHOW_SHORTCUT, false) === true;
    toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'pp-library-history-toggle'; toggle.textContent = 'Recent generations'; toggle.setAttribute('aria-expanded','false');
    toggle.style.display = showShortcut ? '' : 'none';

    historyHost = document.createElement('section'); historyHost.className = 'pp-library-history-host'; historyHost.hidden = true;
    host.prepend(toggle); host.append(historyHost);

    const priorHidden = new Map();
    toggleHistory = () => {
      historyOpen = !historyOpen;
      toggle.setAttribute('aria-expanded', String(historyOpen));
      toggle.textContent = historyOpen ? '← Back to library' : 'Recent generations';
      historyHost.hidden = !historyOpen;
      for (const element of content.filter(Boolean)) {
        if (historyOpen) { priorHidden.set(element, element.hidden); element.hidden = true; }
        else { element.hidden = priorHidden.get(element) || false; priorHidden.delete(element); }
      }
      history.setActive?.(historyOpen);
    };

    history = createGenerationHistory(historyHost, {
      restore, getNode,
      onBack: () => { if (historyOpen) toggleHistory(); }
    });
    history.setActive?.(false);

    toggle.addEventListener('click', toggleHistory);

    // Recent generations settings entry in library settings/customize panel
    histSettingsSection = document.createElement('div');
    histSettingsSection.className = 'wg-lib-cust-section pp-library-history-cust-section';
    histSettingsSection.innerHTML = `
      <div class="wg-lib-cust-head">
        <span class="wg-lib-cust-title">Recent Generations</span>
      </div>
      <div class="pp-lib-history-settings-row">
        <button type="button" class="pp-lib-history-open-btn">Browse recent generations →</button>
        <label class="pp-lib-history-pref-label">
          <input type="checkbox" class="pp-lib-history-shortcut-checkbox" ${showShortcut ? 'checked' : ''}>
          <span>Show "Recent generations" button in library</span>
        </label>
      </div>
    `;
    targetSettingsHost.append(histSettingsSection);

    shortcutCheckbox = histSettingsSection.querySelector('.pp-lib-history-shortcut-checkbox');
    onShortcutChange = () => {
      showShortcut = shortcutCheckbox.checked;
      writeEditorPreference(PREF_SHOW_SHORTCUT, showShortcut);
      toggle.style.display = showShortcut ? '' : 'none';
    };
    shortcutCheckbox.addEventListener('change', onShortcutChange);

    openHistBtn = histSettingsSection.querySelector('.pp-lib-history-open-btn');
    onOpenClick = () => {
      if (!historyOpen) toggleHistory();
    };
    openHistBtn.addEventListener('click', onOpenClick);
  }
  const setActive = active => { history?.setActive?.(Boolean(active && historyOpen)); };

  return {
    filter: items => smart.filter(items),
    refresh() {
      if (disposed) return;
      history?.refreshTarget?.();
      return Promise.allSettled([smart.refresh?.(), relations.refresh?.()]).then(results => {
        if (disposed) return;
        for (const result of results) if (result.status === 'rejected') announce(result.reason?.message || String(result.reason), true);
      });
    },
    setActive,
    cleanup() {
      disposed = true;
      toggle?.removeEventListener('click', toggleHistory);
      shortcutCheckbox?.removeEventListener('change', onShortcutChange);
      openHistBtn?.removeEventListener('click', onOpenClick);
      smart.cleanup?.();
      relations.cleanup?.();
      history?.cleanup?.();
      menu.remove();
      histSettingsSection?.remove();
      toggle?.remove();
      historyHost?.remove();
    }
  };
}
