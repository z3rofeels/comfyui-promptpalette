import { app } from "../../../scripts/app.js";
import { API } from "../prompt_palette_api.js";
import {
  hideNativeWidget, installResponsiveDomWidgetWidth, getDomWidgetAvailableHeight, scheduleDomWidgetRemeasure,
  ensureNodeLifecycle, nodeIsActive, installPromptStateGuard, installPromptMetadataCapture,
  cleanupSocketRailLayout, queueSocketRailLayout,
} from "../prompt_palette_compat.js";
import { notify } from "./notifications.js";
import { editorStylesReady } from "./styles.js";

export function registerPromptPaletteEditor({ buildWildcardWidget, livePromptPaletteNodes, cleanupSharedPromptPaletteDom }) {
  app.registerExtension({
    name: "comfyui.promptpalette.editor",

    settings: [
      {
        id: "PromptPalette.WildcardsPath",
        category: ["Prompt Palette", "Prompt Library", "Folder path"],
        name: "Prompt Library folder path",
        type: "text",
        defaultValue: "",
        tooltip:
          "Full path to the folder holding My Library entries in wildcard .txt/.yaml format. " +
          "Leave blank to clear Prompt Palette's override and return to automatic discovery " +
          "through an existing wildcard config, extra_model_paths.yaml, or ComfyUI/wildcards. " +
          "A custom path is saved in Prompt Palette's user settings and takes effect immediately.",
        async onChange(newValue, oldValue) {
          if (newValue === oldValue) return;
          const requestedPath = typeof newValue === "string" ? newValue.trim() : "";
          const res = await API.setPath(requestedPath);
          if (!res.ok) {
            notify("error", "Prompt Library folder not changed", res.error || "couldn't set the library folder path");
            return;
          }
          try {
            for (const node of livePromptPaletteNodes) {
              if (node._wgRefreshLibrary) await node._wgRefreshLibrary();
            }
            notify("success", requestedPath ? "Prompt Library folder updated" : "Prompt Library folder reset", res.root_dir);
          } catch (error) {
            notify("error", "Prompt Library folder changed", error?.message || "The library could not be refreshed.");
          }
        },
      },
    ],

    async nodeCreated(node) {
      if (node.comfyClass !== "PromptPaletteEditor") return;
      if (node.__promptPaletteEditorInitialized) return;
      const lifecycle = ensureNodeLifecycle(node);
      await editorStylesReady;
      if (!nodeIsActive(node)) return;

      const hiddenWidget = node.widgets?.find((widget) => widget.name === "text");
      if (!hiddenWidget) return;
      Object.defineProperty(node, "__promptPaletteEditorInitialized", {
        value: true,
        configurable: true,
      });

      hideNativeWidget(hiddenWidget);
      installPromptStateGuard(node, hiddenWidget);
      installPromptMetadataCapture(node);
      node.resizable = true;

      const { root: container, refreshFromHidden, refreshVisuals, reassertHiddenWidgets, reapplyTheme, cleanup } = buildWildcardWidget(node, hiddenWidget);
      let domWidget;
      domWidget = node.addDOMWidget("prompt_palette_ui", "div", container, {
        getValue: () => node._ppPromptStateGuard?.current() ?? hiddenWidget.value,
        setValue: (value) => {
          node._ppPromptStateGuard?.acceptRendererValue(value);
          node._wgRefreshFromHidden?.();
        },
        serialize: false,
        hideOnZoom: false,
        // Keep the DOM row subordinate to the user's node height. A zero minimum
        // means the row never imposes a hard floor; the dynamic max/preferred
        // height is simply the space ComfyUI has already allocated to this row.
        getMinHeight: () => 0,
        getMaxHeight: () => getDomWidgetAvailableHeight(node, domWidget),
        getHeight: () => getDomWidgetAvailableHeight(node, domWidget),
        afterResize: () => scheduleDomWidgetRemeasure(node),
      });
      installResponsiveDomWidgetWidth(node, domWidget);
      node._wgRefreshFromHidden = refreshFromHidden;
      node._wgRefreshVisuals = refreshVisuals;
      node._wgReassertHiddenWidgets = reassertHiddenWidgets;
      node._wgReapplyTheme = reapplyTheme;
      node._wgRendererModeChanged = () => {
        // ComfyUI remounts the DOM widget when switching Nodes 1/2. Native CSS
        // Highlight ranges are tied to that mounted editor tree, so rebuild the
        // visual layer after the renderer transition even when prompt text did
        // not change. This is paint/state synchronization, not node sizing.
        node._wgReassertHiddenWidgets?.();
        node._wgReapplyTheme?.();
        scheduleDomWidgetRemeasure(node);
      };
      livePromptPaletteNodes.add(node);

      // Install the socket renderer only after the DOM widget exists. One frame later is
      // deliberate: it lets ComfyUI finish its own nodeCreated/addDOMWidget layout first.
      const scheduleRendererInstall = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
      scheduleRendererInstall(() => {
        if (!nodeIsActive(node)) return;
        node._wgInstallSocketRailWhenReady?.();
        queueSocketRailLayout(node);
        scheduleDomWidgetRemeasure(node);
      });
      queueMicrotask(() => reassertHiddenWidgets());
      scheduleDomWidgetRemeasure(node);

      lifecycle.add(() => {
        livePromptPaletteNodes.delete(node);
        cleanupSocketRailLayout(node);
        delete node._wgRendererModeChanged;
        delete node._wgReapplyTheme;
        delete node._wgRefreshVisuals;
        cleanup?.();
        if (livePromptPaletteNodes.size === 0) cleanupSharedPromptPaletteDom();
      });

    },

    loadedGraphNode(node) {
      if (node.comfyClass !== "PromptPaletteEditor") return;
      queueMicrotask(() => {
        if (!node.__promptPaletteEditorInitialized || !nodeIsActive(node)) return;
        node._wgRefreshFromHidden?.();
        node._wgRefreshIoToggles?.();
        node._wgReassertHiddenWidgets?.();
        node._wgReapplyTheme?.();
        queueSocketRailLayout(node);
        scheduleDomWidgetRemeasure(node);
      });
    },

    afterConfigureGraph() {
      // ComfyUI restores serialized node shell colors during graph configuration.
      // Reapply Prompt Palette appearance only after that supported lifecycle has
      // completed so Editor + Combinatorial keep their selected suite theme.
      const reapplySuiteAppearance = () => {
        for (const liveNode of Array.from(livePromptPaletteNodes)) {
          if (!nodeIsActive(liveNode)) continue;
          liveNode._wgReapplyTheme?.();
          liveNode.graph?.setDirtyCanvas?.(true, true);
        }
      };
      queueMicrotask(reapplySuiteAppearance);
      const raf = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
      raf(reapplySuiteAppearance);
    },
  });
}
