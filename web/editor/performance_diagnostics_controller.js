import { performanceDiagnosticsEnabled, setPerformanceDiagnosticsEnabled } from "./performance_runtime.js";
import { notify } from "./notifications.js";

function formatDuration(value) {
  const n = Number(value) || 0;
  return n < 10 ? `${n.toFixed(2)} ms` : `${n.toFixed(1)} ms`;
}

function formatMetric(snapshot, key) {
  const metric = snapshot.metrics?.[key];
  if (!metric) return "—";
  return `${formatDuration(metric.last)} last · ${formatDuration(metric.average)} avg · ${formatDuration(metric.worst)} worst`;
}

function visibleThumbnailCount(root) {
  const viewportWidth = globalThis.innerWidth || globalThis.document?.documentElement?.clientWidth || 0;
  const viewportHeight = globalThis.innerHeight || globalThis.document?.documentElement?.clientHeight || 0;
  const nodes = Array.from(root.querySelectorAll("img.wg-thumb-img"));
  const visible = nodes.reduce((count, image) => {
    const rect = image.getBoundingClientRect?.();
    if (!rect) return count;
    return count + (rect.bottom >= 0 && rect.right >= 0 && rect.top <= viewportHeight && rect.left <= viewportWidth ? 1 : 0);
  }, 0);
  return { nodes, visible };
}

export function createPerformanceDiagnosticsController({
  node, root, settingsPopup, toggle, panel, readout,
  performanceRuntime, profiler, getLibraryController, getLibrarySize,
  syntaxCache, previewCache, reactiveRuntime, workerClient, getToolRegistry,
}) {
  if (!toggle || !panel || !readout) return { report: () => "", refresh() {}, cleanup() {} };

  let disposed = false;
  node._ppProfiler = profiler;

  function report() {
    const heapBytes = Number(globalThis.performance?.memory?.usedJSHeapSize || 0);
    const libraryPerf = getLibraryController?.()?.performanceStats?.() || {};
    const { nodes: thumbnailNodes, visible: visibleThumbnails } = visibleThumbnailCount(root);
    const snapshot = performanceRuntime.snapshot({
      activeObservers: (node._ppSocketObserverCount || 0)
        + (root.isConnected && typeof globalThis.IntersectionObserver !== "undefined" ? 1 : 0)
        + (libraryPerf.observerActive ? 1 : 0),
      libraryEntries: Number(getLibrarySize?.() || 0),
      libraryIndexEntries: libraryPerf.indexEntries || 0,
      renderedLibraryItems: libraryPerf.renderedItems || 0,
      visibleThumbnails,
      mountedThumbnails: thumbnailNodes.length,
      domNodes: root.querySelectorAll("*").length,
      parserCacheLines: syntaxCache.stats().cachedLines,
      previewCacheEntries: previewCache.size,
      heapBytes,
      reactive: reactiveRuntime.snapshot(),
      worker: workerClient.snapshot(),
      renderer: node._ppRendererAdapter?.snapshot?.() || null,
      tools: getToolRegistry?.()?.snapshot?.() || {},
    });
    const seconds = Math.max(0.001, snapshot.uptimeMs / 1000);
    const renderRate = (Number(snapshot.counters?.editorRenders || 0) / seconds).toFixed(1);
    const socketRate = (Number(snapshot.counters?.socketSyncs || 0) / seconds).toFixed(1);
    const heapText = heapBytes ? `${(heapBytes / 1048576).toFixed(1)} MiB JS heap` : "JS heap unavailable";
    return [
      `Editor frame   ${formatMetric(snapshot, "frame:editor-render")}`,
      `Parse          ${formatMetric(snapshot, "editor.parse")}`,
      `Highlight      ${formatMetric(snapshot, "editor.highlight")}`,
      `Editor DOM     ${formatMetric(snapshot, "editor.dom")}`,
      `Library search ${formatMetric(snapshot, "library.search")}`,
      `Library render ${formatMetric(snapshot, "library.render")}`,
      `Preview        ${formatMetric(snapshot, "preview.resolve")}`,
      `Nodes 2 sync   ${formatMetric(snapshot, "nodes2.sync")}`,
      "",
      `Activity       ${renderRate} editor renders/s · ${socketRate} socket syncs/s`,
      `Runtime        ${snapshot.activeObservers} observer(s) · ${snapshot.activeTimers} timer(s) · ${snapshot.activeFrames} frame(s) · ${snapshot.outstandingRequests} request(s)`,
      `Library        ${snapshot.libraryEntries} entries · ${snapshot.renderedLibraryItems} mounted item(s) · ${snapshot.visibleThumbnails}/${snapshot.mountedThumbnails} visible/mounted thumbnail(s)`,
      `DOM / caches   ${snapshot.domNodes} nodes · ${snapshot.parserCacheLines} parsed line(s) · ${snapshot.libraryIndexEntries} indexed item(s) · ${snapshot.previewCacheEntries} preview item(s)`,
      `Reactive       ${snapshot.reactive?.pendingEffects || 0} pending · ${snapshot.reactive?.scheduledFrames || 0} frame(s) · ${snapshot.reactive?.scheduledMicrotasks || 0} microtask(s)`,
      `Worker         ${snapshot.worker?.active ? "active" : snapshot.worker?.enabled ? "idle" : "off"} · ${snapshot.worker?.pending || 0} pending · ${snapshot.worker?.librarySize || 0} indexed`,
      `Renderer       ${snapshot.renderer?.mode || "unknown"} · ${snapshot.renderer?.observerCount || 0} shared Nodes 2 observer(s)`,
      `Power tools    ${Object.values(snapshot.tools || {}).filter((tool) => tool.enabled).length} enabled · ${Object.values(snapshot.tools || {}).filter((tool) => tool.mounted).length} mounted`,
      `Memory         ${heapText}`,
      `Visibility     ${snapshot.viewportVisible ? "active viewport" : "suspended offscreen"}${snapshot.nodeCollapsed ? " · node collapsed" : ""}`,
    ].join("\n");
  }

  function isVisible() {
    return !disposed
      && profiler.enabled
      && settingsPopup.classList.contains("open")
      && settingsPopup.querySelector('[data-settings-panel="power"]')?.classList.contains("active")
      && panel.hidden === false;
  }

  function refresh() {
    if (!isVisible()) return;
    readout.textContent = report();
  }

  function schedule() {
    performanceRuntime.cancelTimer("diagnostics-ui");
    if (!isVisible()) return;
    refresh();
    performanceRuntime.debounce("diagnostics-ui", 500, schedule, { visual: true });
  }

  const diagnosticsOn = performanceDiagnosticsEnabled();
  toggle.checked = diagnosticsOn;
  panel.hidden = !diagnosticsOn;
  profiler.setEnabled(diagnosticsOn);

  const onToggle = () => {
    const enabled = setPerformanceDiagnosticsEnabled(toggle.checked);
    profiler.setEnabled(enabled);
    profiler.reset();
    panel.hidden = !enabled;
    if (enabled) schedule();
    else performanceRuntime.cancelTimer("diagnostics-ui");
  };
  const onSettingsClick = (event) => {
    if (event.target.closest('[data-settings-tab="power"]')) performanceRuntime.debounce("diagnostics-open", 0, schedule, { visual: true });
  };
  const onOpenSettings = () => performanceRuntime.debounce("diagnostics-open", 0, schedule, { visual: true });
  const onReset = () => { profiler.reset(); refresh(); };
  const onCopy = async () => {
    try {
      await globalThis.navigator?.clipboard?.writeText?.(report());
      notify("success", "Performance report copied", "Local diagnostics copied to the clipboard.");
    } catch {
      notify("error", "Performance report not copied", "Clipboard permission was denied.");
    }
  };

  toggle.addEventListener("change", onToggle);
  settingsPopup.addEventListener("click", onSettingsClick);
  root.querySelector('[data-act="settings"]')?.addEventListener("click", onOpenSettings);
  root.querySelector('[data-act="performanceReset"]')?.addEventListener("click", onReset);
  root.querySelector('[data-act="performanceCopy"]')?.addEventListener("click", onCopy);

  return {
    report,
    refresh,
    schedule,
    cleanup() {
      disposed = true;
      performanceRuntime.cancelTimer("diagnostics-ui");
      performanceRuntime.cancelTimer("diagnostics-open");
      toggle.removeEventListener("change", onToggle);
      settingsPopup.removeEventListener("click", onSettingsClick);
      root.querySelector('[data-act="settings"]')?.removeEventListener("click", onOpenSettings);
      root.querySelector('[data-act="performanceReset"]')?.removeEventListener("click", onReset);
      root.querySelector('[data-act="performanceCopy"]')?.removeEventListener("click", onCopy);
      delete node._ppProfiler;
    },
  };
}
