// Authoring guidance only. No model detection, encoder changes or global formatting.
export const PROMPT_LANGUAGE_GUIDE = [
  { id: "natural", title: "Plain language", models: "Krea 2 · Qwen-Image · Flux and other descriptive models", tip: "Describe the subject and action first, then placement, light and medium. Put wanted lettering in quotes. A Qwen text encoder does not determine the image model’s prompt format.", example: 'A grey Russian Blue cat sits beside a rain-streaked window. A warm desk lamp lights its fur against the cool blue city outside. Intimate eye-level photograph, soft depth of field.', source: "https://huggingface.co/krea/Krea-2-Turbo" },
  { id: "tags", title: "Tags & artist vocabulary", models: "Anima · Booru-trained checkpoints · Pony · Illustrious", tip: "Use short, relevant subject, setting and style tags. In Artists, select Anima for @artist formatting or Booru for stored artist tags. Quality prefixes and weighting depend on the checkpoint; none are added for you.", example: 'grey cat, green eyes, sitting, windowsill, rain, night, city lights, rim lighting', source: "" },
  { id: "moss", title: "Caption, tags & layout", models: "MOSS-Image · choose a format supported by your variant", tip: "Start with a clear caption or ordered tags. For spatial JSON, use the existing MOSS Layout starter in the node’s Layouts picker. Caption, tag and layout behavior varies by checkpoint. Turbo at CFG 1 does not provide normal negative guidance.", example: 'A clean illustrated poster with the word "NIGHT" centered at the top in large white lettering. A grey cat sits on a rooftop in the lower half. Deep blue sky, small golden stars, bold readable shapes.', source: "https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE.md" },
  { id: "edit", title: "Image editing instructions", models: "Qwen-Image-Edit and instruction-based editing models", tip: "State the change, its location and what to preserve. Connect the source image in your editing workflow. Qwen 2.x / 2.5 / 3.x encoder names are not interchangeable image-model syntax profiles.", example: 'Change the cat’s scarf to dark teal. Keep the same cat, pose, background, lighting and camera framing.', source: "https://huggingface.co/Qwen/Qwen-Image-Edit" },
];
export function createPromptLanguageGuide({ insert, announce }) {
  const make = (tag, text = "") => { const el = document.createElement(tag); el.textContent = text; return el; };
  const root = make("details"); root.className = "pp-model-guide pp-style-manage";
  root.append(make("summary", "Choose your prompting language"), make("p", "Prompt Palette resolves wildcards and choices before the model receives text. These starters change only the text you insert; your model and sampler stay under your control."));
  const picker = make("select"); picker.setAttribute("aria-label", "Prompting language guide");
  for (const item of PROMPT_LANGUAGE_GUIDE) picker.append(new Option(item.title, item.id));
  const body = make("article"); root.append(picker, body);
  const drafts = new Map();
  let currentText = null, currentId = null;
  function render() {
    if (currentText && currentId) drafts.set(currentId, currentText.value);
    const item = PROMPT_LANGUAGE_GUIDE.find(item => item.id === picker.value);
    const title = make("h4", item.models), tip = make("p", item.tip), text = make("textarea");
    text.value = drafts.get(item.id) ?? item.example;
    currentId = item.id; currentText = text; text.rows = 5; text.spellcheck = true; text.setAttribute("aria-label", "Editable prompt starter");
    const actions = make("div"); actions.className = "pp-sidebar-actions";
    const add = make("button", "Insert starter"); add.type = "button";
    add.addEventListener("click", async () => {
      if (!text.value.trim() || add.disabled) return;
      add.disabled = true;
      try { await insert(text.value); }
      catch (error) { announce(error.message, true); }
      finally { add.disabled = false; }
    });
    actions.append(add);
    body.replaceChildren(title, tip, text, actions);
    if (item.source) { const link = make("a", "Model author’s guide ↗"); link.href = item.source; link.target = "_blank"; link.rel = "noopener noreferrer"; body.append(link); }
  }
  picker.addEventListener("change", render); render(); return root;
}
