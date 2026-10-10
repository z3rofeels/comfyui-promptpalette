import { cloneWorkspaceData } from "./recipe_workspace_model.js";
import { API } from "../prompt_palette_api.js";
import { validateRecipe, recipeDependencies } from "./prompt_refinement.js";
export async function exportRecipePack(input) {
  const recipe = validateRecipe(cloneWorkspaceData(input)), dependencies = Object.create(null);
  const queue = recipeDependencies(recipe);
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > 256) throw new Error("This recipe uses more than 256 dependencies. Export a smaller recipe pack.");
    const path = queue[index]; if (Object.hasOwn(dependencies, path)) continue;
    const result = await API.content(path);
    if (!result?.found) throw new Error(`Missing dependency: ${path}`);
    if (!result.editable) throw new Error(`Export this dependency separately: ${path} is not a TXT list.`);
    dependencies[path] = result.content;
    for (const name of recipeDependencies({ source: result.content, negative: "", fields: [] })) if (!queue.includes(name)) queue.push(name);
  }
  const blob = new Blob([JSON.stringify({ schema: "prompt-palette.recipe-pack.v1", recipe, dependencies }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = "prompt_palette_adjustable_recipe.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
