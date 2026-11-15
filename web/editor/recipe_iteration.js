import { cloneWorkspaceData, validateWorkspaceRecipe, workspaceCore, compileWorkspace, newField, fieldId, mergeVariantCore, EXPERIMENT_SCHEMA } from "./recipe_workspace_model.js";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameField = (a, b) => { if (!a || !b) return a === b; const left = { ...a }, right = { ...b }; delete left.collapsed; delete right.collapsed; return same(left, right); };
const nameOf = name => { const value = String(name || "").trim(); if (!value || value.length > 120) throw new Error("Use a name with 1–120 characters."); return value; };
export function historyOf(recipe) {
  return recipe.experiments || { schema: EXPERIMENT_SCHEMA, base: null, activeVariantId: null, snapshots: [], variants: [] };
}
function editableCore(recipe) {
  const core = workspaceCore(recipe); delete core.name; delete core.presetId; return core;
}
export function variantPatch(base, current) {
  const left = editableCore(base), right = editableCore(current), lookup = new Map(left.fields.map(f => [f.id, f]));
  const properties = {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (["fields", "segments", "experiments"].includes(key)) continue;
    if (!same(left[key], right[key])) properties[key] = right[key] ?? null;
  }
  return { fields: right.fields.filter(f => !sameField(lookup.get(f.id), f)), removed: left.fields.filter(f => !right.fields.some(x => x.id === f.id)).map(f => f.id), properties,
    ...(same(left.segments, right.segments) ? {} : { segments: right.segments }) };
}
export function captureBranch(recipe) {
  const next = cloneWorkspaceData(recipe), h = next.experiments;
  if (!h?.base) return next;
  if (h.activeVariantId) h.variants.find(v => v.id === h.activeVariantId).patch = variantPatch(h.base, next);
  else h.base = workspaceCore(next);
  return validateWorkspaceRecipe(next);
}
export function branchRecipe(recipe, id = null) {
  const h = historyOf(recipe);
  if (!h.base) return workspaceCore(recipe);
  if (!id) return workspaceCore(h.base);
  const variant = h.variants.find(v => v.id === id); if (!variant) throw new Error("Variant not found.");
  return validateWorkspaceRecipe(mergeVariantCore(h.base, variant.patch));
}
export function switchBranch(recipe, id = null) {
  const next = captureBranch(recipe), h = historyOf(next);
  if (!h.base) throw new Error("Create a variant first.");
  const core = branchRecipe(next, id); h.activeVariantId = id;
  return validateWorkspaceRecipe({ ...core, name: next.name, experiments: h });
}
export function saveVariant(recipe, name, overwriteId = null) {
  const next = captureBranch(recipe), h = cloneWorkspaceData(historyOf(next)); name = nameOf(name);
  h.base ||= workspaceCore(next);
  const existing = h.variants.find(v => v.name.toLowerCase() === name.toLowerCase());
  if (existing && existing.id !== overwriteId) throw new Error("A variant with this name exists. Confirm replacement first.");
  if (!existing && h.variants.length >= 64) throw new Error("Export or remove a variant before adding another (64 per workspace).");
  const v = { id: existing?.id || fieldId(), name, patch: variantPatch(h.base, next) };
  if (existing) h.variants[h.variants.indexOf(existing)] = v; else h.variants.push(v);
  h.activeVariantId = v.id; next.experiments = h; return validateWorkspaceRecipe(next);
}
export function resetInheritedField(recipe, id) {
  const next = captureBranch(recipe), h = historyOf(next);
  if (!h.activeVariantId) throw new Error("Switch to a variant first.");
  const v = h.variants.find(v => v.id === h.activeVariantId);
  if (!h.base.fields.some(f => f.id === id)) throw new Error("This field was added in the variant and has no base value.");
  v.patch.fields = v.patch.fields.filter(f => f.id !== id); v.patch.removed = v.patch.removed.filter(x => x !== id);
  return validateWorkspaceRecipe({ ...branchRecipe(next, v.id), name: next.name, experiments: h });
}
export function saveSnapshot(recipe, name, overwriteId = null) {
  const next = captureBranch(recipe), h = cloneWorkspaceData(historyOf(next)); name = nameOf(name);
  const existing = h.snapshots.find(s => s.name.toLowerCase() === name.toLowerCase());
  if (existing && existing.id !== overwriteId) throw new Error("A snapshot with this name exists. Confirm replacement first.");
  if (!existing && h.snapshots.length >= 100) throw new Error("Export or remove a snapshot before adding another (100 per workspace).");
  const snapshot = { id: existing?.id || fieldId(), name, createdAt: new Date().toISOString(), recipe: workspaceCore(next) };
  if (existing) h.snapshots[h.snapshots.indexOf(existing)] = snapshot; else h.snapshots.push(snapshot);
  next.experiments = h; return validateWorkspaceRecipe(next);
}
export function restoreSnapshot(recipe, id) {
  const next = captureBranch(recipe), h = historyOf(next), snapshot = h.snapshots.find(s => s.id === id);
  if (!snapshot) throw new Error("Snapshot not found.");
  // Restore into the current branch while keeping every snapshot and sibling branch.
  return captureBranch({ ...workspaceCore(snapshot.recipe), name: next.name, experiments: h });
}
export function fieldInheritance(recipe, id) {
  const h = historyOf(recipe); if (!h.activeVariantId || !h.base) return null;
  const base = h.base.fields.find(f => f.id === id), current = recipe.fields.find(f => f.id === id);
  return !base ? "added" : sameField(base, current) ? "inherited" : "overridden";
}
export function diffWorkspaces(before, after) {
  const left = workspaceCore(before), right = workspaceCore(after), old = new Map(left.fields.map(f => [f.id, f])), fresh = new Map(right.fields.map(f => [f.id, f]));
  const order = recipe => recipe.segments.filter(s => s.type === "field").map(s => s.id);
  const aOrder = order(left), bOrder = order(right), changes = [];
  for (const id of new Set([...bOrder, ...aOrder])) {
    const a = old.get(id), b = fresh.get(id);
    const attributes = ["label", "titleHidden", "accent", "accentTarget", "enabled", "channel", "separator", "experimentState", "variationMode", "dependsOn", "fieldType", "default", "variationTemplate", "hasInput", "inputPlacement", "hasOutput"];
    const metadata = a && b ? attributes.filter(key => !same(a[key], b[key])).map(key => ({ key, before: a[key], after: b[key] })) : [];
    if (!a || !b || a.value !== b.value || metadata.length || aOrder.indexOf(id) !== bOrder.indexOf(id)) changes.push({ id, label: b?.label || a?.label, type: !a ? "added" : !b ? "removed" : "changed", before: a?.value ?? "", after: b?.value ?? "", metadata, moved: !!a && !!b && aOrder.indexOf(id) !== bOrder.indexOf(id) });
  }
  const compiledBefore = compileWorkspace(left), compiledAfter = compileWorkspace(right);
  const properties = ["negative", "separator", "segments", "overrideBoundaries"].filter(key => !same(left[key], right[key]));
  return { changes, properties, compiledBefore, compiledAfter };
}
// MOSS formats are explicit starter choices, never an automatic model switch.
// Captions/tags resolve as usual. Valid JSON objects travel as literal prompts.
const MOSS_LAYOUT = JSON.stringify({
  summary: { meta: ['poster'], canvas: 'single', caption: 'A restrained charcoal and sage poster featuring an adult grey Russian Blue cat, a large title above the cat, and a small footer below.' },
  items: [
    { label: 'text', caption: 'Large pale-sage uppercase sans-serif title, centered, on two lines.', text: 'PROMPT\nPALETTE', bbox: [-448, -448, -256, 448] },
    { label: 'object', caption: 'An adult grey Russian Blue cat with green eyes, sitting upright, softly lit from the left.', bbox: [-200, -320, 350, 320] },
    { label: 'text', caption: 'Small pale-sage uppercase sans-serif footer, centered.', text: 'CREATE LOCALLY', bbox: [380, -400, 460, 400] },
  ], bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx',
}, null, 2);

const MOSS_STARTERS = {
  caption: {
    subject: 'An adult grey Russian Blue cat with green eyes sits on a wooden desk.',
    environment: 'The desk is in a quiet design studio with shelves in the background.',
    composition: '{The cat is centered in a medium shot.|A close-up frames the cat’s head and shoulders.}',
    lighting: '{Soft daylight enters from the left.|Warm studio light falls across the grey fur.}',
    style: 'Editorial photography with realistic fur, natural textures, and a muted charcoal and sage palette.',
    lettering: 'A small card at the bottom right reads "PROMPT PALETTE" on the first line and "CREATE LOCALLY" on the second line, in clean uppercase sans-serif letters.',
    negative: 'worst quality, bad anatomy, watermark, jpeg artifact',
  },
  tags: {
    quality: '{masterpiece, best quality|high quality}',
    score: '{score_9, score_8_up|score_8_up}',
    meta: '{highres, absurdres|highres}',
    year: '{dated 2024|dated 2023}',
    character: '{original character|cat mascot}',
    series: '{original|concept art}',
    artist: '{trending on artstation|clean digital lineart}',
    general: 'cat, animal_focus, grey_fur, green_eyes, sitting, indoors, window, soft_lighting',
    negative: 'worst quality, bad anatomy, watermark, jpeg artifact',
  },
  layout: { json: MOSS_LAYOUT },
};

export const BUILTIN_PRESETS = [];

const PRESET_DEFINITIONS = [
  {
    id: 'flux-natural',
    name: 'FLUX · Natural language',
    note: 'Descriptive natural language for FLUX.1 & SD3.5: quoted signage, photographic optics, lighting, and weighted styling.',
    fields: [
      { label: 'Subject', fieldType: 'subject', accent: '#d49a52' },
      { label: 'Environment', fieldType: 'environment', accent: '#82c6a2' },
      { label: 'Lighting', fieldType: 'lighting', accent: '#75b7e8' },
      { label: 'Camera', fieldType: 'camera', accent: '#bb8ee8' },
      { label: 'Visible text', fieldType: 'text', accent: '#d49a52' },
      { label: 'Style & Polish', fieldType: 'style', accent: '#d86f70', hasOutput: true },
    ],
  },
  {
    id: 'photo',
    name: 'Realistic photo',
    note: 'Photorealistic editorial setup with optics, f-stops, natural lighting, wardrobe variations, and film stock.',
    fields: [
      { label: 'Subject', fieldType: 'subject', accent: '#d49a52' },
      { label: 'Wardrobe', fieldType: 'outfit', accent: '#75b7e8' },
      { label: 'Environment', fieldType: 'environment', accent: '#82c6a2' },
      { label: 'Lighting', fieldType: 'lighting', accent: '#d49a52' },
      { label: 'Camera & Optics', fieldType: 'camera', accent: '#bb8ee8' },
      { label: 'Film & Grading', fieldType: 'style', accent: '#d86f70' },
    ],
  },
  {
    id: 'cinematic-video',
    name: 'Video & Motion (Wan / Hunyuan)',
    note: 'Dynamic video prompt architecture for Wan2.1, Hunyuan & LTX: camera moves, temporal action, atmospheric motion, and pacing.',
    fields: [
      { label: 'Subject & Action', fieldType: 'action', accent: '#d49a52' },
      { label: 'Camera movement', fieldType: 'camera', accent: '#bb8ee8' },
      { label: 'Atmosphere & Motion', fieldType: 'environment', accent: '#82c6a2' },
      { label: 'Lighting & Mood', fieldType: 'lighting', accent: '#75b7e8' },
      { label: 'Pacing & Style', fieldType: 'style', accent: '#d86f70' },
    ],
  },
  {
    id: 'anime',
    name: 'Anime image',
    note: 'Booru & Pony ordered tags: quality score anchors, character traits, costume, pose, detailed scenery, and LoRA accents.',
    fields: [
      { label: 'Score & Rating', fieldType: 'score', accent: '#d49a52' },
      { label: 'Character', fieldType: 'character', accent: '#bb8ee8' },
      { label: 'Outfit', fieldType: 'outfit', accent: '#75b7e8' },
      { label: 'Pose & Action', fieldType: 'pose', accent: '#82c6a2' },
      { label: 'Background', fieldType: 'background', accent: '#82c6a2' },
      { label: 'Style & LoRA', fieldType: 'style', accent: '#d86f70' },
    ],
  },
  {
    id: 'portrait',
    name: 'Portrait',
    note: 'Close-up portraiture with dedicated facial expressions, studio and natural lighting schemes, and optical depth.',
    fields: [
      { label: 'Subject', fieldType: 'subject', accent: '#d49a52' },
      { label: 'Expression & Gaze', fieldType: 'expression', accent: '#75b7e8' },
      { label: 'Lighting setup', fieldType: 'lighting', accent: '#d49a52' },
      { label: 'Background', fieldType: 'background', accent: '#82c6a2' },
      { label: 'Camera & Lens', fieldType: 'camera', accent: '#bb8ee8' },
      { label: 'Style & Finish', fieldType: 'style', accent: '#d86f70' },
    ],
  },
  {
    id: 'character-sheet',
    name: 'Character sheet',
    note: 'Concept art model sheet: multi-view turnaround, costume breakdowns, facial expression studies, and neutral backdrop.',
    fields: [
      { label: 'Character concept', fieldType: 'character', accent: '#d49a52' },
      { label: 'Turnaround views', fieldType: 'pose', accent: '#bb8ee8' },
      { label: 'Costume details', fieldType: 'outfit', accent: '#75b7e8' },
      { label: 'Expressions', fieldType: 'expression', accent: '#82c6a2' },
      { label: 'Background & Layout', fieldType: 'background', accent: '#d49a52' },
      { label: 'Art style', fieldType: 'style', accent: '#d86f70' },
    ],
  },
  {
    id: 'scene',
    name: 'Scene',
    note: 'Cinematic matte painting with focal characters, epic environmental scale, weather dynamics, and atmospheric lighting.',
    fields: [
      { label: 'Focal subject', fieldType: 'character', accent: '#d49a52' },
      { label: 'Action & Story', fieldType: 'action', accent: '#75b7e8' },
      { label: 'Environment & Scale', fieldType: 'environment', accent: '#82c6a2' },
      { label: 'Atmosphere & Weather', fieldType: 'composition', accent: '#82c6a2' },
      { label: 'Lighting & Palette', fieldType: 'lighting', accent: '#d49a52' },
      { label: 'Camera & Framing', fieldType: 'camera', accent: '#bb8ee8' },
      { label: 'Style & Medium', fieldType: 'style', accent: '#d86f70' },
    ],
  },
  {
    id: 'product',
    name: 'Product render',
    note: 'Commercial packshot and 3D render: hero materials, display plinths, studio softbox lighting, and macro optics.',
    fields: [
      { label: 'Product', fieldType: 'product', accent: '#d49a52' },
      { label: 'Materials & Finish', fieldType: 'materials', accent: '#75b7e8' },
      { label: 'Surface & Stage', fieldType: 'surface', accent: '#82c6a2' },
      { label: 'Studio lighting', fieldType: 'lighting', accent: '#d49a52' },
      { label: 'Camera & Macro', fieldType: 'camera', accent: '#bb8ee8' },
      { label: 'Render engine', fieldType: 'style', accent: '#d86f70' },
    ],
  },
  {
    id: 'anima',
    name: 'Anima Structure',
    note: 'Scene prose + separate character tag fields with paragraph separators, optimized for multi-subject prompt compilation.',
    fields: [
      { label: 'Environment / Scene Prose', fieldType: 'environment', accent: '#82c6a2', separator: '' },
      { label: 'Character 1 Tags', fieldType: 'character', accent: '#bb8ee8', separator: '\n\n' },
      { label: 'Character 2 Tags', fieldType: 'character', accent: '#75b7e8', separator: '\n' },
    ],
  },
  {
    id: 'negative',
    name: 'Negative prompt set',
    note: 'Negative prompt architecture: positive quality anchor paired with granular quality, anatomy, artifact, and style exclusions.',
    fields: [
      { label: 'Prompt', fieldType: 'prompt', channel: 'positive', accent: '#82c6a2' },
      { label: 'Quality exclusions', fieldType: 'quality', channel: 'negative', accent: '#d86f70' },
      { label: 'Anatomy exclusions', fieldType: 'anatomy', channel: 'negative', accent: '#d86f70' },
      { label: 'Text exclusions', fieldType: 'text', channel: 'negative', accent: '#d86f70' },
      { label: 'Style exclusions', fieldType: 'style', channel: 'negative', accent: '#d86f70' },
    ],
  },
];

const PRESET_DEPENDENCIES = {
  'flux-natural': { lighting: 'environment' },
  'cinematic-video': { environment: 'action' },
  photo: { lighting: 'environment' },
  portrait: { background: 'lighting' },
  product: { lighting: 'surface' },
  scene: { lighting: 'composition' },
};

const PRESET_STARTERS = {
  'flux-natural': {
    natural: {
      subject: 'an athletic cybernetic engineer in her late 20s, with short copper hair and sharp hazel eyes, wearing a {tailored tactical jumpsuit|weathered leather aviator jacket|minimalist carbon-fiber exosuit}',
      environment: '{a rain-slicked neo-Tokyo alleyway at twilight|a sun-drenched industrial loft filled with holographic schematics|a misty botanical greenhouse on an orbital station}',
      lighting: '{2::warm amber rim lighting with soft volumetric dusk shadows|1::cool cyan neon reflections across wet asphalt|0.5::diffused golden morning light filtering through dust motes}',
      camera: '{medium shot at eye level, shallow depth of field, 50mm f/1.4 lens|cinematic wide shot, low angle, anamorphic lens flare|intimate close-up portrait, crisp focus on facial details}',
      text: 'a weathered neon sign overhead that reads "{"NIGHT SHIFT"|"ORBIT 09"|"NEO TOKYO"}" in bold glowing letters',
      style: '(award-winning editorial photography:1.15), natural skin texture, realistic raytraced reflections, 35mm film aesthetic <lora:flux_detail:0.6>',
    },
    tags: {
      subject: '1woman, cybernetic_engineer, short_hair, copper_hair, hazel_eyes, {tactical_jumpsuit|leather_jacket|exosuit}',
      environment: '{cyberpunk_alley, rain, puddles, twilight|industrial_loft, holograms, daylight|space_station, greenhouse, mist}',
      lighting: '{2::warm_lighting, rim_light, soft_shadows|1::neon_lights, cyan_glow, reflections|0.5::sunlight, god_rays}',
      camera: '{medium_shot, eye_level, depth_of_field, 50mm|wide_shot, low_angle, anamorphic|close-up, face_focus}',
      text: 'neon_sign, text, "{"NIGHT SHIFT"|"ORBIT 09"|"NEO TOKYO"}", glowing',
      style: '(photorealistic:1.2), (high_detail:1.15), raytracing, 8k, film_grain <lora:flux_detail:0.6>',
    },
  },
  photo: {
    natural: {
      subject: 'an authentic portrait of an adult subject, natural skin texture with subtle fine pores, {relaxed candid expression|thoughtful gaze looking slightly off-camera|subtle confident smile}',
      outfit: 'wearing a {tailored wool trench coat over a crewneck sweater|casual washed linen button-down shirt|distressed denim jacket over a white cotton tee}',
      environment: '{a sun-dappled café terrace on a cobblestone European street|a sunlit industrial loft with large steel-framed windows|a quiet pine forest clearing with soft morning mist}',
      lighting: '{2::natural golden hour side lighting with warm rim light|1::soft overcast daylight through clouds|0.5::diffused north-facing window light}',
      camera: '{shot on 85mm f/1.4 lens, shallow depth of field, creamy background bokeh|35mm street photography, sharp edge-to-edge detail, f/4 aperture|50mm prime lens, eye-level candid framing}',
      style: '(editorial 35mm film photograph:1.15), subtle Kodak Portra 400 grain, balanced contrast, authentic color science <lora:film_realism:0.7>',
    },
    tags: {
      subject: '1person, adult, realistic_skin_texture, detailed_face, {calm_expression|looking_away|slight_smile}',
      outfit: '{trench_coat, wool_sweater|linen_shirt, casual|denim_jacket, white_t-shirt}',
      environment: '{outdoor_cafe, cobblestone_street|modern_loft, large_windows|pine_forest, morning_mist}',
      lighting: '{2::golden_hour, warm_lighting, rim_light|1::soft_daylight, overcast|0.5::window_light, soft_shadows}',
      camera: '{85mm_lens, shallow_depth_of_field, bokeh|35mm_photo, sharp_focus|50mm_lens, eye_level}',
      style: '(photorealistic:1.2), film_grain, portra_400, color_grading, high_contrast',
    },
  },
  'cinematic-video': {
    natural: {
      action: 'a lone astronaut in a reflective white pressure suit, {walking steadily across a red planetary ridge|reaching out toward a hovering crystalline artifact|examining telemetry data on a glowing wrist display}',
      camera: '{slow cinematic push-in toward the face visor|smooth orbital tracking shot circling clockwise|dynamic crane shot rising from ground level to reveal the horizon}',
      environment: '{swirling crimson dust motes dancing in the thin atmosphere|fine mist drifting rapidly across jagged basalt rocks|faint aurora ribbons waving slowly across the dark sky}',
      lighting: '{2::stark low-angle solar glare casting elongated shadows|1::flickering helmet visor reflections under cold starlight|0.5::warm orange planetary eclipse bleeding along the horizon}',
      style: '(cinematic film still:1.2), 24fps motion blur, fluid continuous movement, IMAX 70mm grain, highly detailed, photorealistic',
    },
    tags: {
      action: '1astronaut, spacesuit, {walking, planetary_surface|reaching_out, floating_crystal|using_wrist_device, glowing_screen}',
      camera: '{camera_zoom_in, push_in|orbit_shot, rotating_camera|crane_shot, rising_camera}',
      environment: '{dust_storm, floating_particles|drifting_fog, volcanic_rocks|aurora, waving_sky}',
      lighting: '{2::harsh_sunlight, long_shadows|1::starlight, visor_reflection|0.5::solar_eclipse, orange_glow}',
      style: '(cinematic_video:1.2), motion_blur, smooth_motion, 70mm_film, photorealistic',
    },
  },
  anime: {
    natural: {
      score: '(masterpiece anime artwork:1.2), high aesthetic rating, pristine illustration quality',
      character: '1girl, solo, an original anime heroine with {twin silver drills and bright blue eyes|sleek black hair with straight bangs and crimson eyes|amber hair in a messy ponytail}, expressive face',
      outfit: 'wearing {a crisp pleated school uniform with sailor collar|ornate fantasy knight armor with gold filigree|a cozy oversized pastel hoodie with striped thigh-high socks}',
      pose: '{standing with one hand on hip, looking at viewer|(sitting gracefully on desk, head tilted:1.05)|dynamic action pose with flowing hair and outstretched hand}',
      background: '{a sunlit school classroom with dust particles in window light|a romantic path beneath blooming sakura blossoms with falling petals|a neon-lit anime rooftop overlooking a futuristic cityscape}',
      style: '(clean digital anime illustration:1.2), sharp vector linework, vibrant Kyoto Animation aesthetic, saturated colors <lora:anime_enhancer:0.7>',
    },
    tags: {
      score: '{score_9, score_8_up, score_7_up, rating:general|masterpiece, best quality, highly detailed}',
      character: '1girl, solo, {silver hair, twin drills, blue eyes|long black hair, hime cut, red eyes|amber hair, messy ponytail, green eyes}, ahoge, expressive face',
      outfit: '{sailor uniform, pleated skirt, necktie|fantasy battle armor, ornate pauldron, cape|oversized hoodie, thighhighs, sneakers}',
      pose: '{standing, hand on hip, looking at viewer|sitting on desk, crossed legs, slight head tilt|dynamic jumping pose, floating hair, reaching forward}',
      background: '{classroom, sunlight filtering through windows, desks|cherry blossom trees in full bloom, falling petals, school gate|cyberpunk city rooftop, neon billboards, night sky}',
      style: '(clean lineart:1.15), vibrant anime color palette, cel shading, detailed background <lora:anime_enhancer:0.7>',
    },
  },
  portrait: {
    natural: {
      subject: 'a close-up portrait of an adult subject with {striking hazel eyes and fine freckles|sharp defined cheekbones and silver-streaked hair|expressive warm eyes and a natural complexion}',
      expression: '{calm contemplative expression looking directly into camera|(subtle enigmatic smile:1.1)|intense focused gaze with relaxed brow}',
      lighting: '{dramatic Rembrandt lighting with defined triangle highlight on cheek|soft beauty dish lighting with circular catchlights in eyes|2::warm golden hour rim light with cool fill on shadowed side}',
      background: '{smooth neutral charcoal studio seamless backdrop|softly blurred botanical garden greenery with circular bokeh|moody urban city street at dusk with colorful out-of-focus lights}',
      camera: '{tight head-and-shoulders crop, 85mm prime lens, f/1.8 aperture|medium portrait bust shot, 105mm macro lens, tack sharp eyelashes|environmental portrait waist-up, 50mm f/1.4}',
      style: '(masterpiece portrait photography:1.15), fine pore detail, natural skin luster, professional color grading',
    },
    tags: {
      subject: '1person, portrait, detailed_eyes, {hazel_eyes, freckles|high_cheekbones, silver_hair|warm_eyes, natural_skin}',
      expression: '{looking_at_viewer, calm_expression|(slight_smile:1.1)|direct_gaze, focused_expression}',
      lighting: '{rembrandt_lighting, dramatic_shadows|beauty_lighting, catchlights_in_eyes|golden_hour, rim_lighting, fill_light}',
      background: '{solid_background, grey_background|bokeh, garden_background|city_at_dusk, blurry_background}',
      camera: '{close-up, headshot, 85mm_lens|medium_portrait, bust_shot, 105mm|upper_body, 50mm_lens}',
      style: '(masterpiece:1.2), (photorealistic:1.15), ultra_detailed, 8k_resolution, studio_quality',
    },
  },
  'character-sheet': {
    natural: {
      character: 'concept model sheet of {a cybernetic samurai with sleek matte-black armor and glowing katana|a young steampunk alchemist with leather bandoliers and brass goggles|a nomadic desert scout with draped woven garments and recurve bow}',
      pose: '{full body turnaround, front view, side view, back view, 3/4 angle|character design sheet, multiple views, standing orthographic pose|full turnaround sheet, neutral A-pose and dynamic combat gesture}',
      outfit: 'detailed costume breakdown showing {fabric textures, stitched seams, holster details|brass gears, glass vial containers, etched runic plates|weathered leather straps, pouches, quiver accessories}',
      expression: '{inset headshot expressions: neutral, determined smirk, fierce combat cry|facial study inset showing smiling, surprised, and stoic expressions}',
      background: 'clean neutral light-grey blueprint background, subtle grid lines, color swatch palette at bottom, orthographic presentation',
      style: '(professional video game concept art:1.2), clean production lineart, flat digital color grading, sharp character proportions',
    },
    tags: {
      character: 'character_sheet, reference_sheet, {cyberpunk_samurai|steampunk_alchemist|desert_scout}, original_character',
      pose: '{multiple_views, full_body, front_view, side_view, back_view|orthographic, model_sheet, turnaround|full_body, multi-view}',
      outfit: 'detailed_clothing, {accessories, weapons|gadgets, gear|pouches, straps}',
      expression: '{expression_sheet, multiple_expressions, facial_study|neutral_expression, smile, angry}',
      background: 'simple_background, grey_background, grid_background, color_palette, reference_sheet',
      style: '(concept_art:1.2), model_sheet, production_art, clean_lineart, official_art',
    },
  },
  scene: {
    natural: {
      character: '{a solitary traveler in a hooded cloak|a giant moss-covered ancient automaton|an exploratory rover with solar panels}',
      action: '{standing at the precipice of a vast canyon, looking out at ancient ruins|resting quietly beside a crystalline stream under monolithic pillars|surveying uncharted alien terrain under dual moons}',
      environment: '{a colossal subterranean cavern illuminated by glowing bioluminescent fungi|a sprawling gothic citadel perched on jagged seaside sea cliffs|an endless rolling emerald highland shrouded in low morning mist}',
      composition: '{heavy rain with volumetric mist and dramatic wind-whipped clouds|golden hour sunbeams cutting through atmospheric haze|gentle snowfall drifting between monumental stone arches}',
      lighting: '{2::deep twilight indigo sky contrasted with warm glowing lanterns|1::blazing amber sunset illuminating cloud formations|0.5::cool monochromatic moonlight with sharp silver highlights}',
      camera: '{ultra-wide panoramic landscape composition, rule of thirds, deep focal depth|epic low-angle establishing shot looking upward at monumental scale|cinematic 2.39:1 widescreen framing}',
      style: '(epic cinematic matte painting:1.15), ArtStation trending aesthetic, rich environmental brushwork, atmospheric perspective',
    },
    tags: {
      character: '{1traveler, cloak, hood|giant_robot, moss_covered|rover, vehicle}',
      action: '{standing, looking_at_view, ruins|resting, beside_water|exploring, planetary_landscape}',
      environment: '{underground_cavern, bioluminescence|gothic_city, cliffside, ocean|grassy_hills, morning_fog}',
      composition: '{rain, mist, dramatic_sky|sunbeams, god_rays, haze|snow, winter}',
      lighting: '{2::twilight, lantern_light|1::sunset, orange_sky|0.5::moonlight, silver_lighting}',
      camera: '{wide_shot, landscape, deep_focus|low_angle, epic_scale|cinematic_framing}',
      style: '(matte_painting:1.2), fantasy_art, highly_detailed, atmospheric_perspective',
    },
  },
  product: {
    natural: {
      product: 'a luxury commercial packshot of {an artisan glass perfume flacon with brushed brass atomizer|a minimalist ceramic teapot and matching cup|a high-end wireless matte-black mechanical chronograph}',
      materials: '{fluted frosted glass, polished 24k gold accents, refractive liquid contents|matte volcanic stoneware, untreated oak handle, satin glaze|brushed titanium casing, sapphire crystal face, textured silicone band}',
      surface: '{resting on a wet black slate slab with delicate water droplets|perched on a carved travertine stone plinth with cast shadows|set on a warm Scandinavian walnut tabletop}',
      lighting: '{commercial three-point studio lighting with high-contrast rim light and softbox reflections|dramatic single overhead spotlight casting sharp dark shadows|clean diffused daylight with caustic water caustics}',
      camera: '{macro close-up shot, 90mm tilt-shift lens, selective focus with razor-sharp details|front eye-level catalog hero shot, crisp depth across entire subject|low-angle dynamic hero perspective, f/8 aperture}',
      style: '(award-winning industrial design render:1.2), Octane Render aesthetic, physically based raytracing, 8k resolution, advertising quality',
    },
    tags: {
      product: '{perfume_bottle, luxury_cosmetics|ceramic_tea_set, minimalist|luxury_watch, chronograph}',
      materials: '{frosted_glass, gold_trim|matte_ceramic, wood_texture|titanium, sapphire_glass}',
      surface: '{slate_pedestal, water_droplets|stone_plinth, architectural_podium|wooden_tabletop}',
      lighting: '{studio_lighting, softbox, rim_lighting|spotlight, high_contrast_shadows|natural_diffused_light}',
      camera: '{macro_photography, tilt-shift, shallow_depth_of_field|catalog_shot, sharp_focus|low_angle}',
      style: '(3d_render:1.2), octane_render, raytracing, photorealistic, product_shot',
    },
  },
  anima: {
    natural: {
      environment: 'A sun-drenched library in late afternoon. Dust motes drift lazily through tall arched windows, casting warm geometric light across towering dark mahogany bookshelves and reading tables.',
      character: '1girl, solo, {silver hair, twin braids|long black hair, ribbon|short auburn hair}, violet eyes, reading glasses, {pleated blouse, dark trousers|knit sweater, pleated skirt}, sitting at wooden table, turning page of antique book, (calm focused expression:1.1)',
      'character 1 tags': '1girl, solo, {silver hair, twin braids|long black hair, ribbon|short auburn hair}, violet eyes, reading glasses, {pleated blouse, dark trousers|knit sweater, pleated skirt}, sitting at wooden table, turning page of antique book, (calm focused expression:1.1)',
      'character 2 tags': '1boy, solo, tousled {brown|black|silver} hair, hazel eyes, loose knit cardigan, standing beside bookshelf, reaching for volume on upper shelf, glancing over shoulder, (warm smile:1.05)',
      character1: '1girl, solo, {silver hair, twin braids|long black hair, ribbon|short auburn hair}, violet eyes, reading glasses, {pleated blouse, dark trousers|knit sweater, pleated skirt}, sitting at wooden table, turning page of antique book, (calm focused expression:1.1)',
      character2: '1boy, solo, tousled {brown|black|silver} hair, hazel eyes, loose knit cardigan, standing beside bookshelf, reaching for volume on upper shelf, glancing over shoulder, (warm smile:1.05)',
    },
    tags: {
      environment: 'A sun-drenched library in late afternoon. Dust motes drift lazily through tall arched windows, casting warm geometric light across towering dark mahogany bookshelves and reading tables.',
      character: '1girl, solo, {silver hair, twin braids|long black hair, ribbon|short auburn hair}, violet eyes, reading glasses, {pleated blouse, dark trousers|knit sweater, pleated skirt}, sitting at wooden table, turning page of antique book, (calm focused expression:1.1)',
      'character 1 tags': '1girl, solo, {silver hair, twin braids|long black hair, ribbon|short auburn hair}, violet eyes, reading glasses, {pleated blouse, dark trousers|knit sweater, pleated skirt}, sitting at wooden table, turning page of antique book, (calm focused expression:1.1)',
      'character 2 tags': '1boy, solo, tousled {brown|black|silver} hair, hazel eyes, loose knit cardigan, standing beside bookshelf, reaching for volume on upper shelf, glancing over shoulder, (warm smile:1.05)',
      character1: '1girl, solo, {silver hair, twin braids|long black hair, ribbon|short auburn hair}, violet eyes, reading glasses, {pleated blouse, dark trousers|knit sweater, pleated skirt}, sitting at wooden table, turning page of antique book, (calm focused expression:1.1)',
      character2: '1boy, solo, tousled {brown|black|silver} hair, hazel eyes, loose knit cardigan, standing beside bookshelf, reaching for volume on upper shelf, glancing over shoulder, (warm smile:1.05)',
    },
  },
  negative: {
    natural: {
      prompt: '(photorealistic masterpiece:1.15), highly detailed, sharp focus, authentic textures, clean composition',
      quality: '{worst quality, low quality, normal quality|lowres, JPEG artifacts, compressed, grainy, blurry, bad quality}',
      anatomy: '{bad anatomy, bad hands, missing fingers, extra fingers, deformed limbs, malformed limbs, mutated hands, disfigured}',
      text: '{watermark, signature, artist name, logo, copyright, text, timestamp, username}',
      style: '{oversaturated, high contrast blowouts, amateur illustration, cartoonish skin, plastic look|monochrome, washed out colors}',
    },
    tags: {
      prompt: '(masterpiece:1.2), best quality, highly detailed, sharp focus, 8k resolution',
      quality: '{worst quality, low quality, normal quality, lowres|jpeg artifacts, compressed, blurry, grainy, bad quality}',
      anatomy: '{bad anatomy, bad hands, missing fingers, extra fingers, deformed limbs, malformed limbs, mutated hands, disfigured}',
      text: '{watermark, signature, artist name, logo, copyright, text, timestamp, username}',
      style: '{oversaturated, amateur, cartoon, plastic skin|monochrome, greyscale, washed out}',
    },
  },
};

for (const def of PRESET_DEFINITIONS) {
  const { id, name, note, fields: fieldDefs } = def;
  const fields = fieldDefs.map((fd, i) => {
    const f = newField(fd.label);
    f.id = `preset_${id}_${i}`;
    f.fieldType = fd.fieldType;
    if (fd.accent) f.accent = fd.accent;
    f.channel = fd.channel || 'positive';
    if (fd.separator != null) f.separator = fd.separator;
    if (fd.hasInput) { f.hasInput = true; f.inputPlacement = fd.inputPlacement || 'before'; }
    if (fd.hasOutput) f.hasOutput = true;
    const starterVal = PRESET_STARTERS[id]?.natural?.[fd.fieldType] || PRESET_STARTERS[id]?.natural?.[fd.label.toLowerCase()] || '';
    f.value = f.default = starterVal;
    f.experimentState = starterVal.includes('|') ? 'vary' : starterVal ? 'lock' : null;
    f.variationMode = 'cycle';
    return f;
  });

  const deps = PRESET_DEPENDENCIES[id];
  if (deps) {
    for (const [depType, srcType] of Object.entries(deps)) {
      const depField = fields.find(f => f.fieldType === depType);
      const srcField = fields.find(f => f.fieldType === srcType || f.label.toLowerCase().includes(srcType));
      if (depField && srcField && depField !== srcField) {
        depField.experimentState = 'follow';
        depField.dependsOn = [srcField.id];
      }
    }
  }

  BUILTIN_PRESETS.push({
    id,
    name,
    note,
    recipe: {
      schema: 'prompt-palette.adjustable-recipe.v2',
      name,
      presetId: id,
      separator: ', ',
      fields,
      segments: fields.map(f => ({ type: 'field', id: f.id, join: true })),
      negative: '',
    },
  });
}

// Concise starter choices use ordinary prompt vocabulary as a fallback for custom or unmapped fields.
const STYLE_STARTERS = {
  'Realistic photo': ['editorial photography with natural detail', 'photography'],
  'Anime image': ['clean linework and a restrained color palette', 'lineart, limited_palette'],
  'Character sheet': ['consistent character proportions and clear design details', 'character_design'],
  Scene: ['a cohesive scene with detailed surroundings', 'detailed_background'],
};

const STARTERS = {
  subject: ['an authentic adult subject with {expressive eyes|warm confident smile|thoughtful candid gaze}', '1person, adult, {expressive_eyes|slight_smile|calm_expression}'],
  character: ['an original adult character, {tailored jacket and scarf|casual layered outfit|minimalist styling}', '1person, original_character, {jacket|casual_wear|minimalist_clothing}'],
  outfit: ['{tailored wool coat over knit sweater|casual washed linen shirt|distressed denim jacket over cotton tee}', '{trench_coat, sweater|linen_shirt|denim_jacket, t-shirt}'],
  pose: ['{standing with natural posture|sitting relaxed on edge of table|walking candidly toward camera}', '{standing, relaxed_posture|sitting, casual|walking, candid}'],
  expression: ['{calm contemplative expression|(subtle warm smile:1.1)|intense focused gaze}', '{calm_expression|(slight_smile:1.1)|focused_expression}'],
  action: ['{walking through the scene|reading from an open journal|looking thoughtfully toward the horizon}', '{walking|reading|looking_at_view}'],
  environment: ['{a quiet sunlit architectural courtyard|a modern design studio with shelves|a misty pine forest clearing}', '{sunlit_courtyard, architecture|modern_studio|misty_forest}'],
  background: ['{a clean neutral studio backdrop with soft gradient|a softly blurred garden with circular bokeh|a moody dusk urban street}', '{simple_background, studio_backdrop|garden, bokeh|city_street, dusk, blur}'],
  lighting: ['{2::natural golden hour side lighting with warm rim|1::diffused overcast daylight|0.5::moody chiaroscuro with soft fill}', '{2::golden_hour, rim_lighting|1::soft_daylight, overcast|0.5::dramatic_shadows, chiaroscuro}'],
  camera: ['{85mm portrait prime, shallow depth of field, f/1.8|35mm street lens, sharp edge detail, f/4|50mm prime, eye level}', '{85mm_lens, depth_of_field, bokeh|35mm_photo, sharp_focus|50mm_lens}'],
  composition: ['{balanced rule-of-thirds composition|centered symmetrical framing with breathing room|dynamic off-center diagonal framing}', '{rule_of_thirds, balanced|centered_composition, symmetry|dynamic_angle}'],
  style: ['(award-winning editorial photography:1.15), fine natural texture, balanced film contrast <lora:detail_tweaker:0.6>', '(masterpiece:1.2), high_detail, sharp_focus, clean_lineart <lora:detail_enhancer:0.7>'],
  product: ['a luxury commercial packshot of {an artisan glass flacon with brass trim|a minimalist stoneware teapot|a precision mechanical watch}', '{perfume_flacon, glass, brass|ceramic_teapot, minimalist|luxury_watch}'],
  materials: ['{frosted fluted glass with 24k gold accents|matte volcanic stoneware with untreated oak|brushed titanium and sapphire crystal}', '{frosted_glass, gold_trim|matte_ceramic, wood|brushed_titanium, sapphire}'],
  surface: ['{a wet slate plinth with delicate water droplets|a carved travertine stone block|a Scandinavian walnut tabletop}', '{slate_pedestal, water_droplets|stone_plinth|wooden_tabletop}'],
  quality: ['(masterpiece:1.2), (high quality:1.15), sharp focus, professional color grading', '{score_9, score_8_up, rating:general|masterpiece, best quality, highly detailed}'],
  score: ['(high aesthetic rating:1.2)', '{score_9, score_8_up|score_8_up}'],
  text: ['a weathered sign overhead reading "{"OPEN 24H"|"PROMPT PALETTE"|"STUDIO"}" in clean lettering', 'sign, text, "{"OPEN"|"PALETTE"}"'],
  prompt: ['(photorealistic masterpiece:1.15), highly detailed, sharp focus, authentic textures, clean composition', '(masterpiece:1.2), best quality, highly detailed, sharp focus, 8k resolution'],
  negative: ['worst quality, low quality, normal quality, blurry, deformed limbs, watermark', 'worst quality, low quality, normal quality, lowres, bad anatomy, bad hands, watermark, signature'],
  anatomy: ['bad anatomy, bad hands, missing fingers, extra fingers, deformed limbs, malformed limbs, mutated hands, disfigured', 'bad anatomy, bad hands, missing fingers, extra fingers, deformed limbs, mutated hands, disfigured'],
};

export function starterPreset(recipe, language = 'natural', { includeValues = true } = {}) {
  const next = presetRecipe(recipe);
  if (!includeValues) return next;
  if (next.mossFormat) {
    for (const f of next.fields) {
      f.value = f.default = MOSS_STARTERS[next.mossFormat]?.[f.fieldType] || '';
      f.experimentState = next.mossFormat === 'layout' ? null : f.value.includes('|') ? 'vary' : f.value ? 'lock' : null;
      f.variationMode = 'cycle';
    }
    return validateWorkspaceRecipe(next);
  }
  const tagged = language === 'tags' || language === 'anima';
  const langKey = tagged ? 'tags' : 'natural';
  const presetId = recipe.presetId || BUILTIN_PRESETS.find(p => p.recipe.name === recipe.name || p.id === recipe.name)?.id;
  const starters = PRESET_STARTERS[presetId]?.[langKey];

  for (const f of next.fields) {
    const type = f.fieldType;
    if (presetId === 'anima' || next.fields.some(x => /Environment \/ Scene Prose/.test(x.label))) {
      if (/Environment/.test(f.label)) f.value = 'A sun-drenched library in late afternoon. Dust motes drift lazily through tall arched windows, casting warm geometric light across towering dark mahogany bookshelves and reading tables.';
      else if (/Character 1/.test(f.label)) f.value = '1girl, solo, {silver hair, twin braids|long black hair, ribbon|short auburn hair}, violet eyes, reading glasses, {pleated blouse, dark trousers|knit sweater, pleated skirt}, sitting at wooden table, turning page of antique book, (calm focused expression:1.1)';
      else if (/Character 2/.test(f.label)) { f.value = '1boy, solo, tousled {brown|black|silver} hair, hazel eyes, loose knit cardigan, standing beside bookshelf, reaching for volume on upper shelf, glancing over shoulder, (warm smile:1.05)'; f.enabled = false; }
    } else if (starters && starters[type] != null) {
      f.value = starters[type];
    } else if (starters && starters[f.label.toLowerCase()] != null) {
      f.value = starters[f.label.toLowerCase()];
    } else {
      f.value = (STARTERS[type] || STARTERS[f.label.toLowerCase()] || ['', ''])[tagged ? 1 : 0];
      if (f.fieldType === 'style' && STYLE_STARTERS[recipe.name]) f.value = STYLE_STARTERS[recipe.name][tagged ? 1 : 0];
    }
    f.default = f.value;
    f.experimentState = f.value.includes('|') ? 'vary' : f.value ? 'lock' : null;
    f.variationMode = 'cycle';
  }

  // Wire up Follow dependencies
  const deps = PRESET_DEPENDENCIES[presetId];
  if (deps) {
    for (const [depType, srcType] of Object.entries(deps)) {
      const depField = next.fields.find(f => f.fieldType === depType);
      const srcField = next.fields.find(f => f.fieldType === srcType || f.label.toLowerCase().includes(srcType));
      if (depField && srcField && depField.id !== srcField.id) {
        depField.experimentState = 'follow';
        depField.dependsOn = [srcField.id];
      }
    }
  } else {
    const trigger = next.fields.find(f => ['pose', 'action', 'camera'].includes(f.fieldType) && f.experimentState === 'vary');
    const lighting = next.fields.find(f => f.fieldType === 'lighting' && f.experimentState === 'vary');
    if (lighting && trigger) { lighting.experimentState = 'follow'; lighting.dependsOn = [trigger.id]; }
  }

  return validateWorkspaceRecipe(next);
}

export function presetRecipe(recipe, { keepText = false } = {}) {
  const next = workspaceCore(recipe); delete next.presetId;
  if (!keepText) next.fields.forEach(f => { f.value = ""; f.default = ""; delete f.variationTemplate; });
  return validateWorkspaceRecipe(next);
}
export function instantiatePreset(recipe, presetId = null) {
  const next = workspaceCore(recipe), ids = new Map(next.fields.map(f => [f.id, fieldId()]));
  next.fields.forEach(f => {
    f.dependsOn = (f.dependsOn || []).map(id => ids.get(id)).filter(Boolean);
    f.id = ids.get(f.id);
  });
  next.segments.forEach(s => { if (s.type === "field") s.id = ids.get(s.id); });
  next.presetId = presetId; return validateWorkspaceRecipe(next);
}

for (const [format, name, definitions, note] of [
  ['caption', 'MOSS · caption', [['Subject', 'subject', '#d49a52'], ['Scene', 'environment', '#82c6a2'], ['Composition', 'composition', '#bb8ee8'], ['Lighting', 'lighting', '#75b7e8'], ['Medium / Style', 'style', '#d86f70'], ['Exact visible text', 'lettering', '#d49a52'], ['Negative · SFT / CFG', 'negative', '#d86f70']],
    'Describe the finished image in English. Quote printed words exactly and describe their placement and line breaks. Negatives depend on the sampler’s guidance; CFG 1 Turbo workflows may ignore them.'],
  ['tags', 'MOSS · ordered tags', [['Quality · optional', 'quality', '#d49a52'], ['Score · optional', 'score', '#d49a52'], ['Meta · optional', 'meta', '#d49a52'], ['Year · optional', 'year', '#d49a52'], ['Character · optional', 'character', '#bb8ee8'], ['Series · optional', 'series', '#bb8ee8'], ['Artist · optional', 'artist', '#75b7e8'], ['General tags', 'general', '#82c6a2'], ['Negative · SFT / CFG', 'negative', '#d86f70']],
    'Order: quality → score → meta → year → character → series → artist → general. Optional fields filled with starter examples for immediate use.'],
  ['layout', 'MOSS · layout JSON (1024²)', [['Layout JSON · literal', 'json', '#75b7e8']],
    'Experimental layout starter for a 1024×1024 canvas. Boxes are [top, left, bottom, right] in pixels from the canvas center (−512…512). Match generation dimensions. Valid JSON is literal: edit captions/text directly; choices and wildcards inside it are not expanded.'],
]) {
  const id = `moss-${format}`;
  const fields = definitions.map(([label, fieldType, accent], at) => {
    const f = newField(label);
    f.id = `preset_${id}_${at}`;
    f.fieldType = fieldType;
    if (accent) f.accent = accent;
    f.channel = fieldType === 'negative' ? 'negative' : 'positive';
    const val = MOSS_STARTERS[format]?.[fieldType] || '';
    f.value = f.default = val;
    f.experimentState = format === 'layout' ? null : val.includes('|') ? 'vary' : val ? 'lock' : null;
    f.variationMode = 'cycle';
    return f;
  });
  BUILTIN_PRESETS.push({ id, name, note, recipe: { schema: 'prompt-palette.adjustable-recipe.v2', name, presetId: id, mossFormat: format,
    separator: format === 'tags' ? ', ' : '\n', negative: '', fields, segments: fields.map(f => ({ type: 'field', id: f.id, join: true })) } });
}
