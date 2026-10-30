import { copyPromptPaletteThemeScope } from "../prompt_palette_shared.js";
export function reviewHistoryRestore(editor, text, apply, channel = "positive") {
  if (!editor?.isConnected || editor.disabled || editor.readOnly) throw new Error('Choose an editable positive prompt field first.');
  const original = editor.value;
  const dialog = document.createElement('dialog'); dialog.className='wg-root pp-history-restore';
  const title=document.createElement('h3');title.textContent=`Restore ${channel} prompt`;dialog.append(title);
  const note=document.createElement('p');note.textContent=`Review the replacement. The ${channel === 'negative' ? 'positive' : 'negative'} prompt is preserved.`;dialog.append(note);
  for (const [label,value] of [['Current',original],['Replacement',text]]) { const heading=document.createElement('label');heading.textContent=label;const preview=document.createElement('textarea');preview.readOnly=true;preview.value=value;heading.append(preview);dialog.append(heading); }
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';const confirm=document.createElement('button');confirm.type='button';confirm.textContent='Restore';dialog.append(cancel,confirm);
  copyPromptPaletteThemeScope(editor.closest?.(".wg-root") || editor, dialog);
  document.body.append(dialog);
  return new Promise((resolve,reject)=>{
    const done=value=>{dialog.close();dialog.remove();resolve(value);};
    cancel.onclick=()=>done(false);dialog.addEventListener('cancel',event=>{event.preventDefault();done(false);},{once:true});
    confirm.onclick=()=>{try {if (!editor.isConnected || editor.value!==original || editor.readOnly || editor.disabled) throw new Error('The target prompt changed. Review the replacement again.');apply(editor,text);done(true);}catch(error){dialog.close();dialog.remove();reject(error);}};
    dialog.showModal();cancel.focus();
  });
}
export function applyHistoryText(editor,text) {
  if (!editor.__ppPromptTools?.apply) throw new Error('This target does not expose Prompt Palette undo support. Open its editor first.');
  editor.focus({preventScroll:true});editor.__ppPromptTools.apply(text,text.length,text.length);editor.dispatchEvent(new Event('input',{bubbles:true}));
}

export function historyTargetEditor(node, fallback, channel='positive') {
  const active=node?._ppActiveRecipeEditor;
  const activeChannel=active?.closest?.('.pp-recipe-field')?.querySelector('[data-channel]')?.dataset.channel;
  if(active?.isConnected && activeChannel===channel) return active;
  if(channel==='positive') return fallback;
  const editor=node?.widgets?.find(widget=>widget.name==='negative_text')?.inputEl;
  if(editor?.isConnected && editor.__ppPromptTools?.apply) return editor;
  throw new Error('Open and focus a negative field in the Fields workspace before restoring negative text.');
}
