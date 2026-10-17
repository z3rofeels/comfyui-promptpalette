import { svgIcon } from "../prompt_palette_shared.js";

export function libraryEditShell() {
  return `        <div class="wg-drawer-inner pp-ledit">
          <div class="wg-drawer-head">
            <h4 data-el="editTitle">Library editor</h4>
            <span class="pp-ledit-badge" data-el="editBadge" data-state="new">New entry</span>
            <button class="wg-close-btn" data-act="closeEditDrawer" title="Close" aria-label="Close Edit My Library">${svgIcon("close", 14)}</button>
          </div>
          <div class="pp-ledit-scroll">
            <section class="pp-ledit-hero">
              <div class="pp-ledit-thumb" data-el="editThumb">
                <button type="button" class="pp-ledit-thumb-add" data-el="editThumbAdd" title="Choose a PNG or JPEG thumbnail for this entry" aria-label="Add thumbnail"><span class="pp-ledit-plus" aria-hidden="true">+</span><span>Add</span></button>
                <img class="pp-ledit-thumb-img" data-el="editThumbImg" alt="Entry thumbnail" hidden decoding="async">
                <div class="pp-ledit-thumb-actions">
                  <button type="button" data-el="editThumbReplace" title="Replace thumbnail" aria-label="Replace thumbnail" hidden>${svgIcon("image", 12)}</button>
                  <button type="button" data-el="editThumbRemove" title="Remove thumbnail" aria-label="Remove thumbnail" hidden>${svgIcon("trash", 12)}</button>
                </div>
                <span class="pp-ledit-thumb-note" data-el="editThumbNote" hidden></span>
              </div>
              <div class="pp-ledit-ident">
                <label data-for="editName">Entry path</label>
                <input type="text" data-el="editName" placeholder="category/subcategory/name" autocomplete="off" spellcheck="false">
                <datalist data-el="editFolders"></datalist>
                <div class="pp-ledit-hint" data-el="editPathHint"></div>
                <div class="pp-ledit-use">
                  <code data-el="editSyntax" title="Type this in a prompt to use the entry"></code>
                  <button type="button" class="pp-ledit-icon" data-el="editCopy" title="Copy the wildcard syntax" aria-label="Copy wildcard syntax">${svgIcon("copy", 12)}</button>
                </div>
              </div>
            </section>
            <section class="pp-ledit-content">
              <div class="pp-ledit-content-head">
                <label data-for="editContent">Prompt options</label>
                <span class="pp-ledit-stats" data-el="editStats"></span>
              </div>
              <p class="pp-ledit-help" data-el="editHelp">One option per line. Each line can be a word or a full prompt. Lines starting with # are notes.</p>
              <div class="pp-ledit-tools" role="group" aria-label="Prompt editing tools">
                <button type="button" data-el="editSuggest" title="Suggestions at the cursor (Ctrl+Space)">Suggest</button>
                <button type="button" data-el="editSyntaxTool" title="Build syntax around your selection or at the cursor">Syntax</button>
                <button type="button" data-el="editFindToggle" aria-expanded="false" title="Find text in this entry (Ctrl+F)">Find</button>
                <button type="button" data-el="editExpand" aria-pressed="false" title="Give the prompt more editing space">Expand</button>
                <details class="pp-ledit-cleanup">
                  <summary>Clean up</summary>
                  <div class="pp-ledit-tools" role="group" aria-label="Option cleanup tools">
                    <button type="button" data-el="editSort" title="Sort options A to Z. Comments and blank lines stay where they are.">Sort A–Z</button>
                    <button type="button" data-el="editDedupe" title="Remove repeated options, keeping the first">Remove duplicates</button>
                    <button type="button" data-el="editTidy" title="Trim spaces and collapse extra blank lines">Tidy</button>
                  </div>
                </details>
              </div>
              <div class="pp-ledit-find" data-el="editFindBar" hidden>
                <input type="search" data-el="editFind" placeholder="Find in this entry…" aria-label="Find text in this library entry" autocomplete="off">
                <span data-el="editFindCount" role="status"></span>
                <button type="button" data-el="editFindPrev" title="Previous match" aria-label="Previous match">↑</button>
                <button type="button" data-el="editFindNext" title="Next match" aria-label="Next match">↓</button>
                <button type="button" data-el="editFindClose" title="Close find" aria-label="Close find">×</button>
              </div>
              <textarea data-el="editContent" spellcheck="false" placeholder="One option per line. Lines starting with # are notes."></textarea>
              <div class="pp-ledit-caret" data-el="editCaret"></div>
              <p class="pp-ledit-help pp-ledit-shortcuts">__ wildcards · @ artists · { syntax · Ctrl+Space suggestions</p>
            </section>
          </div>
          <div class="wg-status" data-el="editStatus" role="status" aria-live="polite"></div>
          <div class="wg-drawer-btns pp-ledit-btns">
            <button type="button" data-el="editRevert" title="Discard changes and restore the saved version">Revert</button>
            <button data-act="delete" class="pp-ledit-danger">Delete</button>
            <button class="primary" data-act="save" title="Save (Ctrl+S)">Save</button>
          </div>
        </div>`;
}
