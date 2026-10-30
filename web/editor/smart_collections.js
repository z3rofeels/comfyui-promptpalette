import { api } from "../../../scripts/api.js";
import { API } from "../prompt_palette_api.js";
import { loadPinned, savePinned } from "./preferences.js";
import { changeLibraryThumbnail } from "./thumbnails.js";
const PREFIX = '/zf-prompt-palette/api/v1';
async function request(path, options = {}) {
  const response = await api.fetchApi(PREFIX + path, options);
  if (!response.ok) throw new Error(await response.text() || `Request failed (${response.status})`);
  return response.json();
}
const node = (tag, text = '') => { const element = document.createElement(tag); element.textContent = text; return element; };
const BOOL = new Set(['favorite','thumbnail','recent','recipe','run','missing','circular','compatible']);
const FIELDS = [['path','Path / folder'],['type','File type'],['tag','User tag'],['favorite','Pinned'],['thumbnail','Has thumbnail'],['recent','Edited in last 7 days'],['recipe','Used in recipes'],['run','Used in captured run context'],['missing','Missing dependencies'],['circular','Circular dependencies'],['compatible','Relationship-compatible']];
const DEFAULTS = [
  {id:'virtual:previews',name:'Missing previews',groups:[[{field:'thumbnail',value:false}]]},
  {id:'virtual:favorites',name:'Favorites',groups:[[{field:'favorite',value:true}]]},
  {id:'virtual:recent',name:'Recently edited',groups:[[{field:'recent',value:true}]]},
  {id:'virtual:recipes',name:'Used in recipes',groups:[[{field:'recipe',value:true}]]},
  {id:'virtual:attention',name:'Needs attention',groups:[[{field:'missing',value:true}],[{field:'circular',value:true}]]},
];
export function matchesCollection(item, groups, context = {}) {
  if (!groups?.length) return true;
  const path = item.path || '', dependency = context.dependencies?.get(path), annotation = context.annotations?.get(path);
  const one = term => {
    const value = term.value;
    switch (term.field) {
      case 'path': return path.toLocaleLowerCase().includes(String(value).toLocaleLowerCase());
      case 'type': return String(item.type || 'txt').toLowerCase() === String(value).toLowerCase();
      case 'tag': return (annotation?.tags || []).some(tag => tag.toLocaleLowerCase() === String(value).toLocaleLowerCase());
      case 'favorite': return !!context.pins?.has(path) === value;
      case 'thumbnail': return !!context.thumbnails?.[path] === value;
      case 'recent': return dependency ? (dependency.modified_at > Date.now()/1000 - 7*86400) === value : false;
      case 'recipe': return dependency ? (dependency.used_in_recipes > 0) === value : false;
      case 'missing': return dependency ? !!dependency.missing?.length === value : false;
      case 'circular': return dependency ? !!dependency.circular === value : false;
      case 'run': return context.runEntries ? context.runEntries.has(path) === value : false;
      case 'compatible': {
        const relConfig = context.relationshipConfig;
        if (!relConfig || !relConfig.enabled || !relConfig.entries) return value === false;
        const isParticipant = Object.prototype.hasOwnProperty.call(relConfig.entries, path);
        if (!isParticipant) return value === false;
        const isCompatible = !context.incompatibleEntries?.has(path);
        return isCompatible === value;
      }
      default: return false;
    }
  };
  return groups.some(group => group.every(one));
}
export function createSmartCollections(host, options = {}) {
  const {getItems = () => [], getPinned = loadPinned, getThumbnails = () => ({}), onFilter = () => {}, onOpenEntry = () => {}, announce = () => {}, getRelationshipConfig = () => null} = options;
  let libraryId = '';
  let disposed = false, version = 0, records = [], selected = null, dependencies = new Map(), annotations = new Map(), runEntries = new Set(), selectedPaths = new Set();
  const root = node('details'); root.className = 'pp-smart-collections'; root.append(node('summary','Smart collections & dependencies'));
  const message = node('p'); message.setAttribute('role','status');
  const choose = node('select'); choose.setAttribute('aria-label','Saved smart collection');
  const controls = node('div'), editor = node('div'), groupsHost = node('div'), chips = node('div'), bulk = node('details'), inspector = node('div');
  const name = node('input'); name.placeholder = 'Collection name'; name.setAttribute('aria-label','Collection name');
  const view = node('select'); view.setAttribute('aria-label','Collection view');
  for (const value of ['list','gallery','masonry','filmstrip']) { const option=node('option',value);option.value=value;view.append(option); }
  const sort=node('select');sort.setAttribute('aria-label','Collection sort');for(const value of ['default','az','za']){const option=node('option',value);option.value=value;sort.append(option);}
  let draft = {groups:[],view:'list',sort:'default'};
  const report = error => { if (!disposed) { message.textContent = error.message || String(error); announce(message.textContent,true); } };
  const run = fn => async () => { try { await fn(); } catch(error) { report(error); } };
  const button = (label,fn,parent=controls) => { const b=node('button',label);b.type='button';b.addEventListener('click',run(fn));parent.append(b);return b; };
  function computeIncompatibleEntries(config) {
    if (!config || !config.enabled || !config.entries) return new Set();
    const bad = new Set(), entryNames = new Set(Object.keys(config.entries));
    for (const rule of config.rules || []) {
      if (rule.enabled === false) continue;
      const src = rule.source?.entry, dst = rule.target?.entry;
      if (!src || !dst || !entryNames.has(src) || !entryNames.has(dst)) {
        if (src) bad.add(src); if (dst) bad.add(dst);
      }
    }
    return bad;
  }
  const context = () => {
    const relConfig = getRelationshipConfig?.() || null;
    return { pins: getPinned(), thumbnails: getThumbnails(), dependencies, annotations, runEntries, relationshipConfig: relConfig, incompatibleEntries: computeIncompatibleEntries(relConfig) };
  };
  const apply = () => { chips.replaceChildren(); for (const group of draft.groups) {const chip=node('small',group.map(x=>`${x.field}: ${x.value}`).join(' AND '));chips.append(chip);} onFilter(controller); };
  function renderGroups() {
    groupsHost.replaceChildren();
    draft.groups.forEach((group,gi) => {
      const wrapper=node('fieldset');wrapper.append(node('legend',gi?'OR group':'Match all in this group'));
      group.forEach((term,ti) => {
        const row=node('div'),field=node('select'),value=node('input');field.setAttribute('aria-label','Filter field');
        for(const [key,label] of FIELDS){const option=node('option',label);option.value=key;field.append(option);}field.value=term.field;
        value.type=BOOL.has(term.field)?'checkbox':'text';if(value.type==='checkbox')value.checked=term.value;else value.value=term.value;
        value.setAttribute('aria-label','Filter value');field.addEventListener('change',()=>{term.field=field.value;term.value=BOOL.has(field.value)?true:'';renderGroups();apply();});
        value.addEventListener('change',()=>{term.value=value.type==='checkbox'?value.checked:value.value;apply();});
        row.append(field,value);button('Remove',()=>{group.splice(ti,1);if(!group.length)draft.groups.splice(gi,1);renderGroups();apply();},row);wrapper.append(row);
      });
      button('AND filter',()=>{if(group.length>=12)throw Error('At most 12 filters per group');group.push({field:'path',value:''});renderGroups();},wrapper);groupsHost.append(wrapper);
    });
  }
  function setDraft(record) { selected=record;draft=structuredClone(record || {groups:[],view:'list',sort:'default'});name.value=record?.name||'';view.value=record?.view||'list';sort.value=record?.sort||'default';renderGroups();apply(); }
  function paintChoices() {
    const current=choose.value;choose.replaceChildren();const all=node('option','All entries');all.value='';choose.append(all);
    for(const record of [...DEFAULTS,...records]){const option=node('option',record.name);option.value=record.id;choose.append(option);}choose.value=current;
  }
  choose.addEventListener('change',()=>setDraft([...DEFAULTS,...records].find(x=>x.id===choose.value)||null));
  button('New',()=>{choose.value='';setDraft(null);});
  button('Duplicate',()=>{selected=null;name.value=(name.value||'Collection')+' copy';});
  button('Save',async()=>{
    const id=selected && !selected.id.startsWith('virtual:')?selected.id:crypto.randomUUID();
    const record=await request(`/collections/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...draft,name:name.value,view:view.value,sort:sort.value,revision:id===selected?.id?selected.revision:0})});
    API.publishMetadataChange?.({ namespace: 'collections', action: 'save', id: record.id });await refresh();choose.value=record.id;setDraft(record);message.textContent='Collection saved; source files unchanged.';
  });
  button('Delete',async()=>{if(!selected||selected.id.startsWith('virtual:'))throw Error('Choose a saved collection');if(!confirm(`Delete collection “${selected.name}”? Source entries remain.`))return;await request(`/collections/${selected.id}?revision=${selected.revision}`,{method:'DELETE'});API.publishMetadataChange?.({ namespace: 'collections', action: 'delete', id: selected.id });setDraft(null);await refresh();});
  button('OR group',()=>{if(draft.groups.length>=12)throw Error('At most 12 groups');draft.groups.push([{field:'path',value:''}]);renderGroups();},editor);
  const exportData = () => ({schema_version:1,kind:'prompt-palette-collections',collections:records.map(({name,groups,view,sort})=>({name,groups,view,sort}))});
  button('Export',()=>{const blob=new Blob([JSON.stringify(exportData(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download='PromptPalette_Collections.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),0);});
  const importInput=node('input');importInput.type='file';importInput.accept='.json,application/json';importInput.hidden=true;
  button('Import',()=>importInput.click());importInput.addEventListener('change',run(async()=>{const file=importInput.files?.[0];if(!file)return;if(file.size>1024*1024)throw Error('Import exceeds 1 MB');const data=JSON.parse(await file.text());if(data.schema_version!==1||data.kind!=='prompt-palette-collections'||!Array.isArray(data.collections)||data.collections.length>100)throw Error('Invalid collection manifest');const validated=await request('/collections/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({collections:data.collections})});if(!confirm(`Import ${validated.collections.length} collections as new copies?`))return;for(const record of validated.collections)await request(`/collections/${crypto.randomUUID()}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...record,revision:0})});API.publishMetadataChange?.({ namespace: 'collections', action: 'import' });await refresh();}));
  bulk.append(node('summary','Batch actions'));const batchStatus=node('small');bulk.append(batchStatus);
  const batchList=node('div'),tag=node('input');tag.placeholder='Tag to add';tag.setAttribute('aria-label','Batch user tag');bulk.append(tag,batchList);
  const matches=()=>controller.filter(getItems());
  const syncSelection=()=>{batchStatus.textContent=`${selectedPaths.size} selected`;};
  button('Select matching (up to 500)',()=>{const items=matches();if(items.length>500)throw Error('Narrow the collection to 500 entries before a bulk operation');selectedPaths=new Set(items.map(x=>x.path));syncSelection();},bulk);
  button('Clear selection',()=>{selectedPaths.clear();syncSelection();paintBatch();},bulk);
  async function annotatePaths(favorite=null) {
    if(!selectedPaths.size)throw Error('Select entries first');
    const pins=new Set(getPinned());
    for(const entry of selectedPaths){const previous=annotations.get(entry)||{};const tags=tag.value.trim()?Array.from(new Set([...(previous.tags||[]),tag.value.trim()])):previous.tags||[];
      const bytes=new TextEncoder().encode(libraryId+':'+entry),id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
      const saved=await request(`/annotations/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...previous,entry,library_id:libraryId,tags,favorite:favorite===null?pins.has(entry):favorite,revision:previous.revision||0})});annotations.set(entry,saved);if(favorite===true)pins.add(entry);if(favorite===false)pins.delete(entry);
    }savePinned(pins);API.publishMetadataChange?.({ namespace: 'annotations', action: 'batch' });apply();message.textContent='Batch metadata saved.';
  }
  button('Pin selected',()=>annotatePaths(true),bulk);button('Unpin selected',()=>annotatePaths(false),bulk);button('Add tag',()=>{if(!tag.value.trim())throw Error('Enter a tag');return annotatePaths();},bulk);
  button('Copy tokens',()=>navigator.clipboard.writeText([...selectedPaths].map(path=>`__${path}__`).join(', ')),bulk);
  button('Copy paths',()=>navigator.clipboard.writeText([...selectedPaths].join('\n')),bulk);
  const thumbnailFile=node('input');thumbnailFile.type='file';thumbnailFile.accept='image/png,image/jpeg';thumbnailFile.hidden=true;bulk.append(thumbnailFile);
  button('Set thumbnail',()=>{if(!selectedPaths.size)throw Error('Select entries first');thumbnailFile.click();},bulk);
  thumbnailFile.addEventListener('change',run(async()=>{const file=thumbnailFile.files?.[0];if(file)for(const path of selectedPaths)await changeLibraryThumbnail(path,{file,isActive:()=>!disposed});}));
  button('Remove thumbnails',async()=>{if(!selectedPaths.size||!confirm(`Remove thumbnails from ${selectedPaths.size} entries?`))return;for(const path of selectedPaths)await changeLibraryThumbnail(path,{remove:true,isActive:()=>!disposed});},bulk);
  function paintBatch(){batchList.replaceChildren();for(const item of matches().slice(0,100)){const label=node('label'),check=node('input');check.type='checkbox';check.checked=selectedPaths.has(item.path);check.addEventListener('change',()=>{if(check.checked)selectedPaths.add(item.path);else selectedPaths.delete(item.path);syncSelection();});label.append(check,node('span',item.path));batchList.append(label);}syncSelection();}
  bulk.addEventListener('toggle',()=>{if(bulk.open)paintBatch();});
  const dependencySearch=node('input');dependencySearch.type='search';dependencySearch.placeholder='Find dependency entry…';dependencySearch.setAttribute('aria-label','Find dependency entry');
  const dependencyEntry=node('select');dependencyEntry.setAttribute('aria-label','Inspect dependency entry');inspector.append(node('strong','Dependencies'),dependencySearch,dependencyEntry);const dependencyText=node('div');inspector.append(dependencyText);
  dependencyEntry.addEventListener('change',()=>{
    const inspected = dependencyEntry.value;
    const data = dependencies.get(inspected);
    dependencyText.replaceChildren();
    if(!data)return;
    dependencyText.append(node('p',`${data.used_in_recipes} recipes · ${data.circular?'Circular reference':'No circular reference'} · ${data.missing.length} missing targets`));

    if (data.references?.length) {
      const section = node('div');
      section.append(node('strong','References'));
      for (const ref of data.references) {
        const row = node('div');
        button(`__${ref.target}__`, () => onOpenEntry(ref.target), row);
        const jumpBtn = button(`Jump @ ${ref.offset}`, () => onOpenEntry(inspected, { cursor: { start: ref.offset, end: ref.offset + ref.target.length + 4, field_id: ref.field_id, channel: ref.channel } }), row);
        jumpBtn.title = `Jump to reference at offset ${ref.offset} in ${inspected}`;
        section.append(row);
      }
      dependencyText.append(section);
    }

    if (data.referenced_by?.length) {
      const section = node('div');
      section.append(node('strong','Referenced by'));
      for (const sourcePath of [...new Set(data.referenced_by)]) {
        const srcData = dependencies.get(sourcePath);
        const refInSrc = srcData?.references?.find(r => r.target === inspected || (r.target.includes('*') && inspected.includes(r.target.replace('*', ''))));
        const cursor = refInSrc ? { start: refInSrc.offset, end: refInSrc.offset + inspected.length + 4, field_id: refInSrc.field_id, channel: refInSrc.channel } : null;
        button(sourcePath + (cursor ? ` (jump @ ${cursor.start})` : ''), () => onOpenEntry(sourcePath, cursor ? { cursor } : {}), section);
      }
      dependencyText.append(section);
    }

    if (data.missing?.length) {
      const section = node('div');
      section.append(node('strong','Missing targets'));
      for (const missingTarget of [...new Set(data.missing)]) {
        const ref = data.references?.find(r => r.target === missingTarget);
        button(`Missing: ${missingTarget}${ref ? ` (jump @ ${ref.offset})` : ''}`, () => {
          if (ref) onOpenEntry(inspected, { cursor: { start: ref.offset, end: ref.offset + missingTarget.length + 4 } });
        }, section);
      }
      dependencyText.append(section);
    }
  });
  function paintDependencyChoices(){const query=dependencySearch.value.toLocaleLowerCase();dependencyEntry.replaceChildren();for(const item of getItems().filter(x=>x.path.toLocaleLowerCase().includes(query)).slice(0,1000)){const option=node('option',item.path);option.value=item.path;dependencyEntry.append(option);}}
  dependencySearch.addEventListener('input',paintDependencyChoices);
  async function all(path){const items=[];let cursor='';do{const page=await request(path+(path.includes('?')?'&':'?')+'cursor='+encodeURIComponent(cursor));items.push(...page.items);cursor=page.next_cursor||'';if(items.length>50000)throw Error('Metadata collection exceeds safe limit');}while(cursor&&!disposed);return items;}
  const unsubMetadata = API.onMetadataChange?.(detail => {
    if (['collections', 'annotations', 'dependencies', 'relationships', 'all'].includes(detail.namespace)) {
      refresh().catch(report);
    }
  });
  async function refresh(){const current=++version;const [saved,notes,graph,usage,identity]=await Promise.all([all('/collections'),all('/annotations'),all('/library/dependencies'),request('/library/run-usage'),request('/library/identity')]);if(disposed||current!==version)return;libraryId=identity.library_id;runEntries=new Set(usage.entries);records=saved;annotations=new Map(notes.filter(x=>x.library_id===libraryId).map(x=>[x.entry,x]));dependencies=new Map(graph.map(x=>[x.entry,x]));paintChoices();paintDependencyChoices();message.textContent='Collections ready. Filters stay virtual; source entries remain in place.';apply();}
  root.addEventListener('toggle',()=>{if(root.open)refresh().catch(report);});
  view.addEventListener('change',()=>{draft.view=view.value;apply();});sort.addEventListener('change',()=>{draft.sort=sort.value;apply();});
  editor.prepend(name,view,sort);editor.append(groupsHost);root.append(choose,controls,editor,chips,message,bulk,inspector,importInput);host.append(root);paintChoices();
  const controller={refresh,filter(items){const snapshot=context();const result=items.filter(item=>matchesCollection(item,draft.groups,snapshot));if(draft.sort==='az')result.sort((a,b)=>a.path.localeCompare(b.path));if(draft.sort==='za')result.sort((a,b)=>b.path.localeCompare(a.path));return result;},getView:()=>selected?draft.view:null,cleanup(){disposed=true;version++;unsubMetadata?.();root.remove();}};
  return controller;
}
