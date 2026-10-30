import { api } from '../../../scripts/api.js';
import { API } from '../prompt_palette_api.js';
const BASE = '/zf-prompt-palette/api/v1/relationships';
const copy = value => JSON.parse(JSON.stringify(value));
const make = (tag, text='') => { const el=document.createElement(tag); el.textContent=text; return el; };
async function request(path, data, method='POST') {
  const response=await api.fetchApi(BASE+path,{method,headers:{'Content-Type':'application/json'},...(data ? {body:JSON.stringify(data)} : {})});
  const result=await response.json().catch(()=>({error:'Relationship request failed'}));
  if(!response.ok) throw new Error(result.message || result.error || 'Relationship request failed');
  return result;
}
export function createRelationshipEditor(host,{getLibrary=()=>[],getConfig=()=>null,getTarget=()=>null,onApply=()=>{}}={}) {
  let disposed=false, revision=0, catalogVersion=0, catalogs={}, history=[], config=copy(getConfig() || {schema_version:1,id:crypto.randomUUID(),enabled:false,entries:{},rules:[]});
  let targetBaseline = JSON.stringify(getConfig() || null);
  let draftBaseline = JSON.stringify(config);
  config.scope ||= {type:'entry',id:config.id};
  const scope=make('select'), scopeName=make('input');scope.setAttribute('aria-label','Rule scope');scopeName.setAttribute('aria-label','Scope name or identity');
  for(const key of ['entry','recipe','collection','global']){const option=make('option',key==='global'?'Explicit global set':key);option.value=key;scope.append(option);}
  scope.value=config.scope.type;scopeName.value=config.scope.id;
  scope.onchange=()=>{remember();config.scope={type:scope.value,id:scopeName.value};};scopeName.onchange=scope.onchange;
  const root=make('section'); root.className='pp-relationship-editor';
  const title=make('h4','Smart wildcard relationships');
  const note=make('p','Choose participating TXT entries, then connect particular choices. Rules apply only to the selected node. Every participating entry must occur in its prompt. Field Lock/Vary/Follow decisions constrain compatible neighbors; conflicts stop generation.');
  const status=make('p');status.setAttribute('role','status');
  const enable=make('input');enable.type='checkbox';enable.checked=!!config.enabled;
  const enableLabel=make('label',' Enable smart relationships');enableLabel.prepend(enable);
  const search=make('input');search.type='search';search.placeholder='Find a wildcard entry…';search.setAttribute('aria-label','Find relationship entry');
  const entries=make('select');entries.setAttribute('aria-label','Participating wildcard entry');
  const add=make('button','Add entry');add.type='button';
  const participants=make('div'), rules=make('div'), builder=make('div');
  const source=make('select'),target=make('select'),operator=make('select');source.setAttribute('aria-label','Source choice');target.setAttribute('aria-label','Target choice');operator.setAttribute('aria-label','Relationship');
  for(const [value,label] of [['requires','Requires'],['excludes','Excludes'],['prefers','Prefers'],['when','When chosen → requires']]){const option=make('option',label);option.value=value;operator.append(option);}
  const tags=make('input'),setTags=make('button','Set target choice tags'),targetTag=make('input');tags.placeholder='Target choice tags, comma separated';tags.setAttribute('aria-label','Target choice tags');targetTag.placeholder='Target tag instead of one choice (optional)';targetTag.setAttribute('aria-label','Target rule tag');setTags.type='button';
  const addRule=make('button','Add rule');addRule.type='button';builder.append(source,operator,target,tags,setTags,targetTag,addRule);
  const validate=make('button','Preview compatibility'),apply=make('button','Apply to target'),undo=make('button','Undo'),save=make('button','Save rule set'),load=make('select'),open=make('button','Load rule set');
  load.setAttribute('aria-label','Saved rule sets'); for(const b of [validate,apply,undo,save,open])b.type='button';
  const actions=make('div');actions.append(validate,apply,undo,save,load,open);
  root.append(title,note,enableLabel,scope,scopeName,search,entries,add,participants,builder,rules,actions,status);host.append(root);
  function announce(message){if(!disposed)status.textContent=message;}
  function remember(){history.push(copy(config));if(history.length>30)history.shift();}
  function filter(){entries.replaceChildren();for(const item of getLibrary().filter(item=>(!item.type||item.type==='txt')&&String(item.path).toLowerCase().includes(search.value.toLowerCase())).slice(0,300)){const option=make('option',item.path);option.value=item.path;entries.append(option);}}
  function render(){
    config.scope ||= {type:'entry',id:config.id};scope.value=config.scope.type;scopeName.value=config.scope.id;
    enable.checked=!!config.enabled;participants.replaceChildren();rules.replaceChildren();source.replaceChildren();target.replaceChildren();
    for(const path of Object.keys(config.entries)){
      const line=make('div',path+' '), role=make('input'), remove=make('button','Remove');role.placeholder='Role (subject, outfit…)';role.setAttribute('aria-label','Role for '+path);role.value=config.entries[path].role||'';role.onchange=()=>{remember();config.entries[path].role=role.value;};line.append(role);remove.type='button';remove.onclick=()=>{remember();delete config.entries[path];config.rules=config.rules.filter(r=>r.source.entry!==path&&r.target.entry!==path);delete catalogs[path];render();};line.append(remove);participants.append(line);
      for(const choice of catalogs[path]?.choices||[])for(const select of [source,target]){const option=make('option',path+' → '+choice.text.slice(0,120));option.value=JSON.stringify({entry:path,choice_id:choice.id});select.append(option);}
    }
    for(const rule of config.rules){const describe=endpoint=>endpoint.tag ? `${endpoint.entry} tagged ${endpoint.tag}` : `${endpoint.entry} → ${catalogs[endpoint.entry]?.choices.find(c=>c.id===endpoint.choice_id)?.text || 'Needs review: missing choice'}`;const line=make('div',`${describe(rule.source)} ${rule.operator==='when'?'When chosen → requires':rule.operator} ${describe(rule.target)} `), toggle=make('input'),remove=make('button','Remove');toggle.type='checkbox';toggle.checked=rule.enabled!==false;toggle.setAttribute('aria-label','Enable rule');toggle.onchange=()=>{remember();rule.enabled=toggle.checked;};remove.type='button';remove.onclick=()=>{remember();config.rules=config.rules.filter(r=>r.id!==rule.id);render();};line.prepend(toggle);line.append(remove);rules.append(line);}
    undo.disabled=!history.length; addRule.disabled=!source.options.length;
  }
  async function refreshCatalog({review=false}={}){
    const current=++catalogVersion, snapshot=config, paths=Object.keys(config.entries);if(!paths.length){catalogs={};render();return;}
    const result=await request('/catalog',{entries:paths});
    // A delayed catalog must not revive removed participants or overwrite the
    // catalog of a different target/draft after a tab or selection change.
    if(disposed||current!==catalogVersion||config!==snapshot||paths.length!==Object.keys(config.entries).length||paths.some(path=>!Object.hasOwn(config.entries,path)))return;
    catalogs=result.entries;
    if(review)for(const path of paths)if(!config.entries[path]?.revision)config.entries[path]={revision:catalogs[path].revision};
    render();
  }
  async function check(candidate=config){return request('/validate',{config:{...candidate,enabled:true},seed:0});}
  enable.onchange=()=>{remember();config.enabled=enable.checked;};search.oninput=filter;
  add.onclick=async()=>{if(!entries.value)return;try{remember();config.entries[entries.value] ||= {};await refreshCatalog({review:true});announce('Review choices and add a rule.');}catch(e){announce(e.message);}};
  addRule.onclick=()=>{try{remember();config.rules.push({id:crypto.randomUUID(),enabled:true,operator:operator.value,source:JSON.parse(source.value),target:targetTag.value.trim()?{entry:JSON.parse(target.value).entry,tag:targetTag.value.trim()}:JSON.parse(target.value),weight:1});render();}catch(e){announce(e.message);}};
  setTags.onclick=()=>{try{const selected=JSON.parse(target.value);remember();config.entries[selected.entry].tags ||= {};config.entries[selected.entry].tags[selected.choice_id]=tags.value.split(',').map(v=>v.trim()).filter(Boolean);announce('Tags updated for target choice.');}catch(e){announce(e.message);}};
  validate.onclick=async()=>{try{const result=await check();announce(JSON.stringify(result,null,2));}catch(e){announce(e.message);}};
  apply.onclick=async()=>{try{const candidate=copy(config),target=getTarget();if(candidate.enabled)await check(candidate);if(disposed||getTarget()!==target||JSON.stringify(config)!==JSON.stringify(candidate))throw new Error('The target or relationship draft changed during validation. Review it and Apply again.');await onApply(candidate);targetBaseline=JSON.stringify(getConfig() || null);draftBaseline=JSON.stringify(config);API.publishMetadataChange?.({ namespace: 'relationships', action: 'apply', id: config.id });announce(config.enabled?'Relationships active on target.':'Relationships disabled on target.');}catch(e){announce(e.message);}};
  undo.onclick=()=>{if(history.length){config=history.pop();refreshCatalog().catch(e=>announce(e.message));render();}};
  async function saved(){const result=await request('',null,'GET');if(disposed)return;load.replaceChildren();for(const item of result.items){const option=make('option',item.name||item.id);option.value=item.id;option.dataset.record=JSON.stringify(item);load.append(option);}}
  save.onclick=async()=>{try{if(config.enabled)await check();const result=await request('/'+encodeURIComponent(config.id),{config,expected_revision:revision},'PUT');revision=result.revision;API.publishMetadataChange?.({ namespace: 'relationships', action: 'save', id: config.id });await saved();announce('Rule set saved.');}catch(e){announce(e.message);}};
  open.onclick=async()=>{try{const record=JSON.parse(load.selectedOptions[0]?.dataset.record||'null');if(!record)return;remember();config=record;revision=record.revision;await refreshCatalog();announce('Loaded. Review and Apply to target to activate.');}catch(e){announce(e.message);}};
  filter();render();refreshCatalog().catch(e=>announce(e.message));saved().catch(e=>announce(e.message));
  const unsubMetadata = API.onMetadataChange?.(detail => {
    if (['relationships', 'all'].includes(detail.namespace)) {
      saved().catch(e => announce(e.message));
      refreshCatalog().catch(e => announce(e.message));
    }
  });
  return {cleanup(){disposed=true;catalogVersion++;unsubMetadata?.();root.remove();},refresh(){
    const next = JSON.stringify(getConfig() || null);
    if(next !== targetBaseline){
      if(JSON.stringify(config) !== draftBaseline && !globalThis.confirm('The target changed. Discard this relationship draft and load the selected target?')) return;
      config=copy(getConfig() || {schema_version:1,id:crypto.randomUUID(),enabled:false,entries:{},rules:[]});
      revision=0;history=[];targetBaseline=next;draftBaseline=JSON.stringify(config);
    }
    filter();render();return refreshCatalog();
  }};
}
