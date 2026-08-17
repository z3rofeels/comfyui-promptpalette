import { svgIcon } from "../prompt_palette_shared.js";

export function createEditorShell() {
  const root = document.createElement("div");
  root.className = "wg-node wg-root";
  root.innerHTML = `
    <div class="wg-toolbar" data-el="toolbar">
      <div class="wg-toolbar-group left" data-el="toolbarMajor" aria-label="Prompt tools">
        <button class="wg-icon-btn" data-act="picker" data-el="btnGallery" title="Prompt Library — Starter Packs and My Library" aria-label="Open Prompt Library" aria-expanded="false">${svgIcon("gallery")}</button>
        <button class="wg-icon-btn" data-act="edit" data-el="btnEdit" title="Create or edit a My Library entry" aria-label="Create or edit My Library entry">${svgIcon("edit")}</button>
        <button class="wg-icon-btn" data-act="recipesShortcut" data-el="btnRecipes" title="Open RECIPES" aria-label="Open recipes">${svgIcon("recipe")}</button>
        <button class="wg-icon-btn" data-act="stash" data-el="btnStash" title="Prompt Stash — save and restore drafts" aria-label="Open Prompt Stash" aria-expanded="false">${svgIcon("stash")}</button>
      </div>
      <div class="wg-toolbar-center">
        <button class="wg-pill wg-pill-resolve" data-act="resolve" data-el="btnResolve" title="Preview the wildcard-resolved result" aria-label="Preview resolved prompt" aria-pressed="false">Preview result</button>
        <button class="wg-pill wg-power-pill" data-act="variations" data-el="btnVariations" title="Variation Lab — compare deterministic wildcard resolutions" aria-label="Open Variation Lab" hidden>Variations</button>
      </div>
      <div class="wg-toolbar-group right" aria-label="Prompt Palette utilities">
        <button class="wg-icon-btn" data-act="refresh" data-el="btnRefresh" title="Rescan My Library files" aria-label="Rescan My Library">${svgIcon("refresh")}</button>
        <button class="wg-icon-btn" data-act="undo" data-el="btnUndo" title="Undo prompt edit (Ctrl+Z)" aria-label="Undo prompt edit">${svgIcon("undo")}</button>
        <button class="wg-icon-btn" data-act="redo" data-el="btnRedo" title="Redo prompt edit (Ctrl+Shift+Z)" aria-label="Redo prompt edit">${svgIcon("redo")}</button>
        <button class="wg-icon-btn" data-act="copy" data-el="btnCopy" title="Copy current prompt" aria-label="Copy prompt">${svgIcon("copy")}</button>
        <button class="wg-icon-btn" data-act="clear" data-el="btnClear" title="Clear prompt after confirmation" aria-label="Clear prompt">${svgIcon("trash")}</button>
        <button type="button" class="wg-icon-btn wg-io-toggle-btn" data-act="ioRailToggle" aria-expanded="false" title="Manage inputs, outputs, and socket labels" aria-label="Manage inputs, outputs, and socket labels">${svgIcon("io", 13)}<span data-io-count></span></button>
        <button class="wg-icon-btn" data-el="dayNightBtn" data-act="dayNightToggle" title="Switch day/night theme" aria-label="Switch day or night theme">${svgIcon("moon")}</button>
        <button class="wg-icon-btn" data-el="zenBtn" data-act="zenToggle" title="Toggle Zen mode" aria-label="Toggle Zen mode">${svgIcon("zen")}</button>
        <button class="wg-icon-btn wg-settings-anchor" data-el="settingsBtn" data-act="settings" title="Prompt Palette settings" aria-label="Open Prompt Palette settings" aria-expanded="false">${svgIcon("settings")}</button>
      </div>
      <div class="wg-toolbar-extra" data-el="seedbar">
        <span class="wg-seed-label">Seed</span>
        <input type="number" class="wg-seed-input" data-el="seedInput" min="0" step="1" title="Prompt seed">
        <button class="wg-icon-btn" data-act="seedRandomizeNow" title="Roll a new random seed now" aria-label="Randomize seed">${svgIcon("dice")}</button>
        <select class="wg-seed-mode" data-el="seedModeSelect" title="What happens to the seed after each run"></select>
        <select class="wg-seed-mode" data-el="processingModeSelect" title="How multi-line prompts are resolved" style="flex: 0 0 148px;">
          <option value="entire text as one">Entire text as one</option>
          <option value="line by line">Line by line</option>
        </select>
      </div>
    </div>
    <div class="wg-main">
      <div class="wg-drawer left wg-library-popup" data-drawer="picker" role="region" aria-label="Prompt Library" aria-hidden="true" hidden inert>
        <div class="wg-drawer-resize-handle wg-library-resize-handle" data-el="libraryResizeHandle" role="separator" aria-orientation="vertical" aria-label="Resize Prompt Library" tabindex="0" title="Drag to resize Prompt Library · Double-click to reset"></div>
        <div class="wg-library-head">
          <div>
            <strong>Prompt Library</strong>
            <small data-el="librarySubtitle">Model-ready starters, syntax examples, and your wildcard-backed library.</small>
          </div>
          <div class="wg-library-head-tools">
            <div class="wg-library-density" role="group" aria-label="Thumbnail size">
              <button type="button" data-library-density="small" title="Small thumbnails" aria-label="Small thumbnails">S</button>
              <button type="button" data-library-density="medium" title="Medium thumbnails" aria-label="Medium thumbnails">M</button>
              <button type="button" data-library-density="large" title="Large thumbnails" aria-label="Large thumbnails">L</button>
            </div>
            <button class="wg-icon-btn wg-library-manager-btn" data-act="libraryManager" data-el="libraryManagerBtn" title="Library Manager" aria-label="Open Library Manager" hidden>${svgIcon("settings", 13)}</button>
            <button class="wg-close-btn" data-act="closePickerDrawer" title="Close Prompt Library" aria-label="Close Prompt Library">${svgIcon("close", 14)}</button>
          </div>
        </div>
        <div class="wg-library-tabs" role="tablist" aria-label="Prompt Library sections">
          <button type="button" class="active" data-library-tab="starter" role="tab" aria-selected="true">Starter Packs</button>
          <button type="button" data-library-tab="personal" role="tab" aria-selected="false">My Library</button>
        </div>
        <section class="wg-library-panel wg-starter-panel active" data-library-panel="starter" role="tabpanel">
          <div class="wg-starter-controls">
            <label class="wg-starter-model-select-wrap"><span>Pack</span><select data-el="starterModelSelect" aria-label="Starter Pack collection"></select></label>
            <div class="wg-search wg-starter-search"><input type="search" placeholder="Search this pack…" data-el="starterSearch" aria-label="Search selected Starter Pack collection"></div>
          </div>
          <div class="wg-starter-model-summary" data-el="starterModelSummary"></div>
          <div class="wg-starter-results-row">
            <div class="wg-starter-filters" role="group" aria-label="Starter Pack filter">
              <button type="button" class="active" data-starter-filter="all" aria-pressed="true">All</button>
              <button type="button" data-starter-filter="favorites" aria-pressed="false">★ Favorites</button>
              <button type="button" data-starter-filter="recent" aria-pressed="false">↺ Recent</button>
            </div>
            <div class="wg-starter-results-head"><span data-el="starterCount"></span><span class="wg-starter-status" data-el="starterStatus" role="status"></span></div>
          </div>
          <div class="wg-starter-tree" data-el="starterTree" aria-label="Starter Pack categories"></div>
        </section>
        <section class="wg-library-panel wg-personal-panel" data-library-panel="personal" role="tabpanel" hidden>
          <div class="wg-personal-head">
            <div><strong>My Library</strong><span>Your private wildcard-backed entries, lists, and RECIPES.</span></div>
            <div class="wg-drawer-head-actions">
              <button class="wg-icon-btn" data-act="recipeSelect" data-el="recipeSelectToggle" title="Select entries to combine into a Palette Recipe" aria-label="Select entries for a Palette Recipe">${svgIcon("palette")}</button>
              <button class="wg-icon-btn" data-act="pickerViewToggle" data-el="pickerViewToggle" title="Toggle card or list view" aria-label="Toggle My Library view">${svgIcon("grid")}</button>
            </div>
          </div>
          <div class="wg-search"><input type="search" placeholder="Search My Library…" data-el="search" aria-label="Search My Library"></div>
          <div class="wg-recipe-bar" data-el="recipeBar">
            <span data-el="recipeBarCount">0 selected</span>
            <div class="wg-recipe-bar-btns">
              <button type="button" class="wg-pill" data-act="recipeSave">Add to RECIPES</button>
              <button type="button" class="wg-pill" data-act="recipeCancel">Clear</button>
            </div>
          </div>
          <div class="wg-list" data-el="pickerList"></div>
        </section>
      </div>
      <div class="wg-body">
        <div class="wg-editor-wrap">
          <div class="wg-editor-real" data-el="editorReal">
            <div class="wg-editor-layer wg-highlight" data-el="highlight"></div>
            <textarea class="wg-editor-layer wg-textarea" data-el="textarea" spellcheck="true"></textarea>
          </div>
          <div class="wg-resolved" data-el="resolvedView"></div><div class="wg-preview-status" data-el="previewStatus" hidden aria-live="polite"></div>
        </div>
        <div class="wg-legend" data-el="legend" title="Wildcard colors follow your My Library category palette."></div>
        <div class="wg-footer">
          <span class="wg-hint" data-el="charCount"></span>
          <span class="wg-hint" data-el="tokenCount" data-el-token title="CLIP-L token count of the resolved prompt (visible while Preview result is open)"></span>
          <button type="button" class="wg-doctor-chip" data-el="doctorChip" data-act="doctor" aria-label="Open Prompt Doctor" title="Prompt Doctor" hidden><span data-el="doctorDot"></span><span data-el="doctorLabel">Doctor</span></button>
          <span class="wg-hint" data-el="hintRight"></span>
        </div>
      </div>
      <div class="wg-drawer right" data-drawer="edit">
        <div class="wg-drawer-inner">
          <div class="wg-drawer-head">
            <h4>Edit My Library</h4>
            <button class="wg-close-btn" data-act="closeEditDrawer" title="Close">${svgIcon("close", 14)}</button>
          </div>
          <label>Entry path (TXT only)</label>
          <input type="text" data-el="editName" placeholder="category/subcategory/name">
          <label>Options or reusable prompt text</label>
          <textarea data-el="editContent"></textarea>
          <div class="wg-status" data-el="editStatus"></div>
          <div class="wg-drawer-btns">
            <button data-act="delete">Delete</button>
            <button class="primary" data-act="save">Save</button>
          </div>
        </div>
      </div>
      <div class="wg-drawer right wg-settings-popup wg-stash-popup" data-el="stashPopup" role="region" aria-label="Prompt Stash" aria-hidden="true" hidden inert>
        <div class="wg-settings-head">
          <span>Prompt Stash</span>
          <button class="wg-close-btn" data-act="closeStash" title="Close Prompt Stash" aria-label="Close Prompt Stash">${svgIcon("close", 14)}</button>
        </div>
        <div class="wg-settings-body">
          <div class="wg-stash-tabs" role="tablist" aria-label="Prompt recovery sections">
            <button type="button" class="active" data-stash-tab="drafts" role="tab" aria-selected="true">Saved drafts</button>
            <button type="button" data-stash-tab="history" role="tab" aria-selected="false">History</button>
          </div>
          <section class="wg-stash-panel active" data-stash-panel="drafts" role="tabpanel">
            <button type="button" class="wg-stash-save" data-act="stashSave" title="Save the current prompt text as a local draft">${svgIcon("stash", 13)} Save current prompt</button>
            <div data-el="stashList"></div>
          </section>
          <section class="wg-stash-panel" data-stash-panel="history" role="tabpanel" hidden>
            <div class="wg-history-head"><span>Automatic local recovery</span><button type="button" data-act="historyClear">Clear unpinned</button></div>
            <div data-el="historyList"></div>
          </section>
        </div>
      </div>
      <div class="wg-drawer right wg-settings-popup wg-power-popup" data-el="doctorPopup" role="region" aria-label="Prompt Doctor" aria-hidden="true" hidden inert>
        <div class="wg-settings-head"><span>Prompt Doctor</span><button class="wg-close-btn" data-act="closeDoctor" title="Close Prompt Doctor" aria-label="Close Prompt Doctor">${svgIcon("close", 14)}</button></div>
        <div class="wg-settings-body"><div class="wg-power-summary" data-el="doctorSummary"></div><div class="wg-power-list" data-el="doctorList"></div></div>
      </div>
      <div class="wg-drawer right wg-settings-popup wg-power-popup" data-el="variationPopup" role="region" aria-label="Variation Lab" aria-hidden="true" hidden inert>
        <div class="wg-settings-head"><span>Variation Lab</span><button class="wg-close-btn" data-act="closeVariations" title="Close Variation Lab" aria-label="Close Variation Lab">${svgIcon("close", 14)}</button></div>
        <div class="wg-settings-body">
          <div class="wg-panel-title"><div><h3>Resolve before you queue</h3><p>Same source prompt, predictable seed steps. Nothing is generated.</p></div></div>
          <div class="wg-field-row"><label class="wg-field"><span>Versions</span><select data-el="variationCount" class="wg-theme-select"><option>4</option><option>8</option><option>12</option><option>16</option></select></label><button class="wg-button primary" data-act="variationRefresh">Resolve</button></div>
          <div class="wg-status" data-el="variationStatus"></div>
          <div class="wg-variation-grid" data-el="variationList"></div>
        </div>
      </div>
      <div class="wg-drawer right wg-settings-popup wg-power-popup" data-el="libraryManagerPopup" role="region" aria-label="Library Manager" aria-hidden="true" hidden inert>
        <div class="wg-settings-head"><span>Library Manager</span><button class="wg-close-btn" data-act="closeLibraryManager" title="Close Library Manager" aria-label="Close Library Manager">${svgIcon("close", 14)}</button></div>
        <div class="wg-settings-body">
          <div class="wg-panel-title"><div><h3>Library health</h3><p>Read-only audit first. Destructive actions always require an explicit click.</p></div><button class="wg-button" data-act="libraryAuditRefresh">Rescan</button></div>
          <div class="wg-library-health-summary" data-el="libraryHealthSummary"></div>
          <div class="wg-search-field wg-manager-search"><input type="search" data-el="libraryManagerSearch" placeholder="Filter My Library entries…" aria-label="Filter My Library entries"></div>
          <div class="wg-panel-title wg-manager-subhead"><div><h3>Manage entries</h3><p>Rename, copy, edit, or delete TXT-backed entries. Nothing is changed by the audit itself.</p></div></div>
          <div class="wg-manager-bulk" data-el="libraryManagerBulk"><span data-el="libraryManagerSelectedCount">0 selected</span><div><button type="button" class="wg-button" data-act="librarySelectVisible">Select visible</button><button type="button" class="wg-button" data-act="libraryBulkMove">Move…</button><button type="button" class="wg-button" data-act="libraryBulkCopy">Copy…</button><button type="button" class="wg-button" data-act="libraryBulkPrefix">Prefix…</button><button type="button" class="wg-button" data-act="libraryUndo" disabled title="Undo the last safely reversible library change">Undo last</button><button type="button" class="wg-button" data-act="libraryBulkClear">Clear</button></div></div>
          <div class="wg-library-manager-entries" data-el="libraryManagerEntries"></div>
          <div class="wg-panel-title wg-manager-subhead"><div><h3>Audit findings</h3><p>Potential cleanup items found in the current library.</p></div></div>
          <div class="wg-power-list" data-el="libraryHealthList"></div>
        </div>
      </div>
      <div class="wg-drawer right wg-settings-popup wg-power-popup" data-el="recipeBuilderPopup" role="region" aria-label="Recipe Builder" aria-hidden="true" hidden inert>
        <div class="wg-settings-head"><span>Recipe Builder</span><button class="wg-close-btn" data-act="closeRecipeBuilder" title="Close Recipe Builder" aria-label="Close Recipe Builder">${svgIcon("close", 14)}</button></div>
        <div class="wg-settings-body">
          <div class="wg-panel-title"><div><h3>Build a Palette Recipe</h3><p>Reorder ingredients, choose how they resolve, preview the source, then save.</p></div></div>
          <label class="wg-field"><span>Recipe name</span><input type="text" class="wg-theme-select" data-el="recipeBuilderName" placeholder="portrait-stack"></label>
          <div class="wg-two-col">
            <label class="wg-field"><span>Wildcard mode</span><select class="wg-theme-select" data-el="recipeBuilderOperator"><option value="seeded">Seeded</option><option value="unseeded">Unseeded</option><option value="forward">Sequential +</option><option value="backward">Sequential −</option><option value="combinatorial">Combinatorial %</option></select></label>
            <label class="wg-field"><span>Separator</span><select class="wg-theme-select" data-el="recipeBuilderSeparator"><option value=", ">Comma</option><option value="; ">Semicolon</option><option value="&#10;">New line</option><option value=" ">Space</option></select></label>
          </div>
          <div class="wg-two-col"><label class="wg-field"><span>Prefix</span><input type="text" class="wg-theme-select" data-el="recipeBuilderPrefix" placeholder="optional"></label><label class="wg-field"><span>Suffix</span><input type="text" class="wg-theme-select" data-el="recipeBuilderSuffix" placeholder="optional"></label></div>
          <div class="wg-recipe-builder-list" data-el="recipeBuilderList"></div>
          <label class="wg-field"><span>Recipe source preview</span><textarea data-el="recipeBuilderPreview" class="wg-recipe-builder-preview" readonly></textarea></label>
          <div class="wg-status" data-el="recipeBuilderStatus"></div>
          <div class="wg-button-row"><button class="wg-button" data-act="recipeBuilderCancel">Cancel</button><button class="wg-button primary" data-act="recipeBuilderSave">Save to RECIPES</button></div>
        </div>
      </div>
      <div class="wg-drawer right wg-settings-popup wg-settings-pro" data-el="settingsPopup" role="dialog" aria-label="Prompt Palette settings" aria-hidden="true" hidden inert>
        <div class="wg-settings-head wg-settings-head-pro">
          <div>
            <span>Prompt Palette</span>
            <small>Live controls — your prompt stays visible</small>
          </div>
          <button class="wg-close-btn" data-act="closeSettings" title="Close settings" aria-label="Close Prompt Palette settings">${svgIcon("close", 15)}</button>
        </div>
        <div class="wg-settings-shell">
          <nav class="wg-settings-nav" role="tablist" aria-label="Settings sections">
            <button role="tab" aria-selected="true" class="active" data-settings-tab="appearance"><span>Appearance</span><small>Themes, text, effects</small></button>
            <button role="tab" aria-selected="false" data-settings-tab="layout"><span>Workspace</span><small>Toolbar &amp; density</small></button>
            <button role="tab" aria-selected="false" data-settings-tab="power"><span>Power tools</span><small>Optional advanced tools</small></button>
            <button role="tab" aria-selected="false" data-settings-tab="colors"><span>Categories</span><small>Wildcard color system</small></button>
            <button role="tab" aria-selected="false" data-settings-tab="data"><span>Backup</span><small>Import, export, reset</small></button>
            <button role="tab" aria-selected="false" data-settings-tab="guide"><span>Guide</span><small>Search local help</small></button>
          </nav>
          <div class="wg-settings-body">
            <section role="tabpanel" class="wg-settings-panel active" data-settings-panel="appearance">
              <div class="wg-panel-title wg-settings-intro"><div><h3>Theme studio</h3><p>Choose a collection, then a palette. The same look applies across all three Prompt Palette nodes.</p></div><span class="wg-badge" data-el="uiThemeCount">Curated packs + custom</span></div>

              <div class="wg-theme-studio">
                <div class="wg-theme-pack-strip" data-el="uiThemePackStrip" aria-label="Theme collections"></div>
                <div class="wg-theme-gallery" data-el="uiThemeGallery" aria-label="Theme gallery"></div>
                <div class="wg-theme-selection-bar">
                  <div class="wg-theme-selection-copy">
                    <small>Selected palette</small>
                    <strong data-el="uiThemeActiveName">Cinder</strong>
                    <span data-el="uiThemeActivePack">Night · Dark</span>
                  </div>
                  <button class="wg-button primary" data-act="uiThemeNew">Customize theme</button>
                </div>
              </div>
              <div class="wg-status" data-el="uiThemeStatus"></div>

              <section class="wg-settings-card wg-day-night-card">
                <div class="wg-panel-title"><div><h3>Day / night quick switch</h3><p>Pick two favorites for the optional toolbar toggle.</p></div></div>
                <div class="wg-day-night-layout">
                  <div class="wg-two-col">
                    <label class="wg-field"><span>Day</span><select class="wg-theme-select" data-el="dayThemeSelect"></select></label>
                    <label class="wg-field"><span>Night</span><select class="wg-theme-select" data-el="nightThemeSelect"></select></label>
                  </div>
                  <label class="wg-toggle-card"><div><strong>Toolbar shortcut</strong><small>Show the day / night switch in the node toolbar.</small></div><input type="checkbox" data-el="toggleDayNightBtn"></label>
                </div>
              </section>

              <details class="wg-settings-disclosure">
                <summary><span><strong>Advanced palette editor</strong><small>Duplicate a built-in palette to unlock all 12 color tokens.</small></span><b>12 colors</b></summary>
                <div class="wg-settings-disclosure-body">
                  <div class="wg-button-row">
                    <button class="wg-button" data-act="uiThemeRename">Rename custom</button>
                    <button class="wg-button danger-quiet" data-act="uiThemeDelete">Delete custom</button>
                  </div>
                  <div class="wg-swatch-grid" data-el="uiThemeSwatches"></div>
                </div>
              </details>

              <div class="wg-settings-card-grid">
                <section class="wg-settings-card">
                  <div class="wg-panel-title"><div><h3>Wildcard token palette</h3><p>Shape automatic folder colors without touching custom pinned colors.</p></div></div>
                  <label class="wg-range-field"><span>Auto shift <output data-el="hueOut">0°</output></span><input type="range" class="wg-range" data-el="hueRange" min="0" max="359" value="0" title="Auto Shift affects automatic colors. Custom colors are locked."></label>
                  <label class="wg-range-field"><span>Color intensity <output data-el="satOut">58%</output></span><input type="range" class="wg-range" data-el="satRange" min="30" max="90" step="1" value="58"></label>
                  <div class="wg-inline-note">Custom category colors stay locked exactly as you set them.</div>
                </section>

                <section class="wg-settings-card">
                  <div class="wg-panel-title"><div><h3>Typography</h3><p>Readable defaults, with full control when you want it.</p></div></div>
                  <label class="wg-field"><span>Font family</span><input type="text" class="wg-theme-select" data-el="fontFamilyInput" list="wg-font-suggestions" placeholder="Default system / monospace stack"></label>
                  <datalist id="wg-font-suggestions"><option value="Atkinson Hyperlegible"><option value="OpenDyslexic"><option value="Arial"><option value="Verdana"><option value="Segoe UI"><option value="Georgia"><option value="Consolas"><option value="Cascadia Code"><option value="Courier New"></datalist>
                  <div class="wg-button-row"><button class="wg-button" data-act="fontBrowseLocal">Browse fonts</button><button class="wg-button" data-act="fontClear">Default</button></div>
                  <div class="wg-status" data-el="fontStatus"></div>
                  <label class="wg-range-field"><span>Prompt text <output data-el="editorFontOut">12.5px</output></span><input type="range" class="wg-range" data-el="editorFontRange" min="10" max="64" step="0.5" value="12.5"></label>
                  <label class="wg-range-field"><span>Interface text <output data-el="uiFontOut">100%</output></span><input type="range" class="wg-range" data-el="uiFontRange" min="80" max="200" step="5" value="100"></label>
                  <label class="wg-range-field"><span>Corner roundness <output data-el="cornerRadiusOut">10px</output></span><input type="range" class="wg-range" data-el="cornerRadiusRange" min="4" max="18" step="1" value="10"></label>
                  <label class="wg-toggle-card"><div><strong>Match theme text</strong><small>Keep prompt text cohesive with the selected palette.</small></div><input type="checkbox" data-el="promptTextColorAuto" checked></label>
                  <label class="wg-color-field"><div><strong>Custom prompt text</strong><small>Used only when theme matching is off.</small></div><input type="color" data-el="promptTextColor" value="#f1eee8"></label>
                </section>
              </div>
            </section>

            <section role="tabpanel" class="wg-settings-panel" data-settings-panel="layout">
              <div class="wg-panel-title"><div><h3>Workspace level</h3><p>Optional presets only. They change existing toggles; every setting remains individually editable.</p></div><span class="wg-badge">2.0</span></div>
              <div class="wg-preset-grid wg-workspace-level-grid" role="group" aria-label="Prompt Palette workspace level">
                <button type="button" data-workspace-level="core"><strong>Core</strong><small>Editor + essentials</small></button>
                <button type="button" data-workspace-level="creator"><strong>Creator</strong><small>Familiar default</small></button>
                <button type="button" data-workspace-level="power"><strong>Power User</strong><small>Enable advanced tools</small></button>
              </div>
              <div class="wg-inline-note">Choosing a level is never required. It is only a shortcut for the same optional controls below.</div>
              <div class="wg-section-divider"></div>
              <div class="wg-panel-title"><div><h3>Workspace density</h3><p>Start from a preset, then tailor every control below.</p></div></div>
              <div class="wg-preset-grid">
                <button data-layout-preset="minimal"><strong>Minimal</strong><small>Writing first</small></button>
                <button data-layout-preset="balanced" class="active"><strong>Balanced</strong><small>Best default</small></button>
                <button data-layout-preset="studio"><strong>Studio</strong><small>Everything ready</small></button>
              </div>
              <label class="wg-zen-card"><div><strong>Zen mode</strong><small>Hide drawers, secondary chrome, legend, and utility controls. Settings always remains available.</small></div><input type="checkbox" data-el="toggleZenMode"></label>
              <label class="wg-toggle-card"><div><strong>Starter Packs</strong><small>Show the optional built-in prompt and syntax library. My Library remains available when this is off.</small></div><input type="checkbox" data-el="toggleStarterPacks"></label>
              <div class="wg-button-row">
                <button class="wg-button" data-act="toolbarAllOn">All toolbar on</button>
                <button class="wg-button" data-act="toolbarAllOff">All toolbar off</button>
              </div>
              <div class="wg-section-divider"></div>
              <div class="wg-panel-title"><div><h3>Toolbar modules</h3><p>Settings is permanently available and cannot be hidden.</p></div></div>
              <div class="wg-toggle-grid">
                <label class="wg-toggle-card"><div><strong>Prompt Library</strong><small>Starter Packs and your entries.</small></div><input type="checkbox" data-el="toggleGalleryBtn"></label>
                <label class="wg-toggle-card"><div><strong>Wildcard editor</strong><small>Create and edit files.</small></div><input type="checkbox" data-el="toggleEditBtn"></label>
                <label class="wg-toggle-card"><div><strong>Recipes</strong><small>Build combinatorial sets.</small></div><input type="checkbox" data-el="toggleRecipesBtn"></label>
                <label class="wg-toggle-card"><div><strong>Prompt stash</strong><small>Local drafts.</small></div><input type="checkbox" data-el="toggleStashBtn"></label>
                <label class="wg-toggle-card"><div><strong>Refresh</strong><small>Rescan My Library files.</small></div><input type="checkbox" data-el="toggleRefreshBtn"></label>
                <label class="wg-toggle-card"><div><strong>Undo</strong><small>Prompt history.</small></div><input type="checkbox" data-el="toggleUndoBtn"></label>
                <label class="wg-toggle-card"><div><strong>Redo</strong><small>Prompt history.</small></div><input type="checkbox" data-el="toggleRedoBtn"></label>
                <label class="wg-toggle-card"><div><strong>Resolved preview</strong><small>Inspect final text.</small></div><input type="checkbox" data-el="toggleResolveBtn"></label>
                <label class="wg-toggle-card"><div><strong>Preview update mode</strong><small>Manual never resolves while typing. After pause matches the familiar behavior. Live updates quickly.</small></div><select data-el="previewModeSelect" aria-label="Preview update mode"><option value="manual">Manual</option><option value="afterPause">After pause</option><option value="live">Live</option></select></label>
                <label class="wg-toggle-card"><div><strong>Copy</strong><small>Copy prompt text.</small></div><input type="checkbox" data-el="toggleCopyBtn"></label>
                <label class="wg-toggle-card"><div><strong>Clear</strong><small>Clear the editor.</small></div><input type="checkbox" data-el="toggleClearBtn"></label>
                <label class="wg-toggle-card"><div><strong>Seed controls</strong><small>Seed, mode, line handling.</small></div><input type="checkbox" data-el="toggleSeedControls"></label>
                <label class="wg-toggle-card"><div><strong>Syntax injector</strong><small>Contextual wildcard syntax.</small></div><input type="checkbox" data-el="toggleSyntaxInjector"></label>
                <label class="wg-toggle-card"><div><strong>Automatic history</strong><small>Keep local recovery checkpoints after editing pauses and queues.</small></div><input type="checkbox" data-el="togglePromptHistory"></label>
              </div>
            </section>
  
            <section role="tabpanel" class="wg-settings-panel" data-settings-panel="power">
              <div class="wg-panel-title"><div><h3>Optional power tools</h3><p>Every power tool is independent. Turn on only what earns space in your workflow.</p></div><span class="wg-badge">All optional</span></div>
              <div class="wg-power-note">The classic Prompt Palette workflow remains the baseline. Disabling a tool removes its UI rather than leaving dead controls behind.</div>
              <div class="wg-toggle-grid">
                <label class="wg-toggle-card"><div><strong>Prompt Doctor</strong><small>Local syntax and prompt health checks. Adds one small themed status chip in the footer.</small></div><input type="checkbox" data-power-tool="promptDoctor"></label>
                <label class="wg-toggle-card"><div><strong>Variation Lab</strong><small>Compare 4–16 deterministic resolved versions before queueing.</small></div><input type="checkbox" data-power-tool="variationLab"></label>
                <label class="wg-toggle-card"><div><strong>Resolved Diff</strong><small>Highlight text that changed between your source prompt and resolved preview.</small></div><input type="checkbox" data-power-tool="resolvedDiff"></label>
                <label class="wg-toggle-card"><div><strong>Library Manager</strong><small>Audit empty entries, duplicate content, broken recipes, and orphan thumbnails.</small></div><input type="checkbox" data-power-tool="libraryManager"></label>
                <label class="wg-toggle-card"><div><strong>Recipe Builder 2</strong><small>Use the richer reorder, operator, separator, prefix, and suffix builder when saving RECIPES.</small></div><input type="checkbox" data-power-tool="recipeBuilder2"></label>
                <label class="wg-toggle-card"><div><strong>ComfyUI command palette</strong><small>Optionally register Prompt Palette commands. Prompt Palette assigns no keyboard shortcuts. Restart after changing this option.</small></div><input type="checkbox" data-power-tool="nativeCommands"></label>
              </div>
              <div class="wg-button-row">
                <button class="wg-button" data-act="powerToolsAllOn">Enable all</button>
                <button class="wg-button" data-act="powerToolsAllOff">Disable all</button>
              </div>
              <div class="wg-status" data-el="powerToolsStatus"></div>
              <div class="wg-section-divider"></div>
              <div class="wg-panel-title"><div><h3>Performance diagnostics</h3><p>Local developer profiler for finding UI stalls. Nothing is sent anywhere.</p></div><span class="wg-badge">Off by default</span></div>
              <label class="wg-toggle-card"><div><strong>Enable diagnostics</strong><small>Measure editor, library, preview, and Nodes 2 adapter work. Adds a tiny amount of profiling overhead while enabled.</small></div><input type="checkbox" data-el="togglePerformanceDiagnostics"></label>
              <div class="wg-performance-diagnostics" data-el="performanceDiagnosticsPanel" hidden>
                <pre data-el="performanceDiagnosticsReadout" aria-live="polite"></pre>
                <div class="wg-button-row"><button class="wg-button" data-act="performanceReset">Reset samples</button><button class="wg-button" data-act="performanceCopy">Copy report</button></div>
                <div class="wg-inline-note">Targets: normal editor work under 16.7 ms, library search feedback around 50 ms or less, zero repeated work from hidden or collapsed nodes.</div>
              </div>
              <div class="wg-section-divider"></div>
              <div class="wg-panel-title"><div><h3>Accessibility & motion</h3><p>Optional comfort controls. They affect Prompt Palette only.</p></div><span class="wg-badge">Local</span></div>
              <div class="wg-toggle-grid">
                <label class="wg-toggle-card"><div><strong>Reduce motion</strong><small>Prefer restrained transitions and movement.</small></div><input type="checkbox" data-workspace-pref="reduceMotion"></label>
                <label class="wg-toggle-card"><div><strong>Disable animations</strong><small>Remove Prompt Palette transitions entirely.</small></div><input type="checkbox" data-workspace-pref="disableAnimations"></label>
                <label class="wg-toggle-card"><div><strong>Disable hover previews</strong><small>Do not fetch or show wildcard previews on hover.</small></div><input type="checkbox" data-workspace-pref="disableHoverPreviews"></label>
                <label class="wg-toggle-card"><div><strong>High contrast</strong><small>Increase separation between text, borders, and controls.</small></div><input type="checkbox" data-workspace-pref="highContrast"></label>
                <label class="wg-toggle-card"><div><strong>Larger UI text</strong><small>Increase Prompt Palette interface text without changing prompt content.</small></div><input type="checkbox" data-workspace-pref="largeText"></label>
                <label class="wg-toggle-card"><div><strong>Keyboard navigation</strong><small>Keep arrow-key navigation and focus helpers enabled.</small></div><input type="checkbox" data-workspace-pref="keyboardNavigation"></label>
              </div>
            </section>

            <section role="tabpanel" class="wg-settings-panel" data-settings-panel="colors">
              <div class="wg-panel-title"><div><h3>Category color manager</h3><p>Search, preview, pin, or return categories to automatic color assignment.</p></div><span class="wg-badge" data-el="categoryCount">0</span></div>
              <div class="wg-inline-note">Wildcard text and legend markers use your library category colors. This stays inside Prompt Palette.</div>
              <div class="wg-search-field"><input type="search" data-el="categoryColorSearch" placeholder="Search category names…"></div>
              <div class="wg-field-row">
                <select class="wg-theme-select" data-el="categoryPresetSelect" aria-label="Saved category palette"></select>
                <button class="wg-button" data-act="categoryPresetSave">Save</button>
              </div>
              <div class="wg-button-row">
                <button class="wg-button" data-act="categoryPresetRestore">Restore</button>
                <button class="wg-button danger-quiet" data-act="categoryPresetDelete">Delete</button>
                <button class="wg-button" data-act="categoryAutoPalette">Create fixed palette</button>
                <button class="wg-button" data-act="categoryResetAll">Use automatic colors</button>
              </div>
              <div class="wg-status" data-el="categoryPresetStatus"></div>
              <div class="wg-category-manager" data-el="catPins"></div>
            </section>
  
  
  
            <section role="tabpanel" class="wg-settings-panel" data-settings-panel="data">
              <div class="wg-panel-title"><div><h3>Theme packs</h3><p>One versioned file contains interface colors, token colors, typography, and layout choices.</p></div><span class="wg-badge">v4 schema</span></div>
              <div class="wg-import-drop" data-el="themeDropZone"><strong>Drop a Prompt Palette theme here</strong><small>or use Import file below. Older theme JSON is migrated automatically.</small></div>
              <div class="wg-button-row">
                <button class="wg-button primary" data-act="uiThemeImport">Import file</button>
                <button class="wg-button" data-act="uiThemeExport">Export file</button>
              </div>
              <div class="wg-button-row">
                <button class="wg-button" data-act="copyTheme">Copy pack</button>
                <button class="wg-button" data-act="pasteTheme">Paste pack</button>
                <button class="wg-button danger-quiet" data-act="resetTheme">Reset preferences</button>
              </div>
              <div class="wg-theme-export"><textarea data-el="themeJson" readonly aria-label="Theme pack JSON preview"></textarea></div>
              <div class="wg-status" data-el="themePackStatus"></div>
            </section>

            <section role="tabpanel" class="wg-settings-panel" data-settings-panel="guide">
              <div class="wg-panel-title"><div><h3>Prompt Palette guide</h3><p>Search the shortcuts and power features already built into the node.</p></div><span class="wg-badge">Local help</span></div>
              <div class="wg-search-field"><input type="search" data-el="helpSearch" placeholder="Search wildcard, history, metadata…" aria-label="Search Prompt Palette guide"></div>
              <div class="wg-help-results" data-el="helpResults"></div>
            </section>
          </div>
        </div>
        <div class="wg-settings-footer">
          <a class="wg-credit-link" href="https://github.com/z3rofeels/comfyui-promptpalette" target="_blank" rel="noopener noreferrer" title="Prompt Palette on GitHub">
            <span class="wg-credit-icon">${svgIcon("github", 13)}</span><span>made by <strong>z3rofeels</strong></span>
          </a>
        </div>
      </div>
    </div>
  `;
  return root;
}
