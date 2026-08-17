import { app } from "../../scripts/app.js";
import { getPowerToolPreferences } from "./prompt_palette_state.js";
import { invokePromptPaletteCommand } from "./prompt_palette_command_bus.js";

const prefs = getPowerToolPreferences();

if (prefs.nativeCommands) {
  const definitions = [
    ["prompt-palette.open-library", "Prompt Palette: Open Prompt Library", "openLibrary"],
    ["prompt-palette.focus-editor", "Prompt Palette: Focus Prompt Editor", "focusEditor"],
    ["prompt-palette.preview", "Prompt Palette: Toggle Resolved Preview", "togglePreview"],
    ["prompt-palette.io", "Prompt Palette: Toggle I/O Manager", "toggleIo"],
    ["prompt-palette.stash", "Prompt Palette: Open Prompt Stash", "openStash"],
    ["prompt-palette.day-night", "Prompt Palette: Toggle Day / Night Theme", "toggleDayNight"],
    ["prompt-palette.doctor", "Prompt Palette: Open Prompt Doctor", "openDoctor"],
    ["prompt-palette.variations", "Prompt Palette: Open Variation Lab", "openVariations"],
    ["prompt-palette.library-health", "Prompt Palette: Open Library Manager", "openLibraryManager"],
  ];

  app.registerExtension({
    name: "comfyui.promptpalette.commands",
    commands: definitions.map(([id, label, handler]) => ({
      id,
      label,
      function: () => invokePromptPaletteCommand(handler),
    })),
  });
}
