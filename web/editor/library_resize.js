// One split-pane divider for both node renderers. Widths are local CSS pixels;
// pointer coordinates are viewport pixels and must be unscaled at canvas zoom.
export function bindLibraryResize({ drawer, handle, load, save, defaultWidth = 360 }) {
  const MIN = 180, MAX = 1440;
  const clamp = value => Math.max(MIN, Math.min(MAX, Math.round(Number(value) || defaultWidth)));
  const saved = load?.();
  let useBalancedDefault = saved == null;
  let preferred = clamp(saved ?? defaultWidth);
  let drag = null;
  let lastGeometry = "";
  const removers = [];
  const listen = (target, type, fn, options) => {
    target?.addEventListener(type, fn, options);
    removers.push(() => target?.removeEventListener(type, fn, options));
  };
  function bounds() {
    const parent = drawer.parentElement;
    const width = parent?.clientWidth || 480;
    // Leave a usable editor beside the rail, even in compact nodes. Never
    // disable the divider merely because a nested Library container is narrow.
    const editorWidth = Math.min(240, Math.max(100, width * .3));
    const max = Math.max(1, Math.min(MAX, Math.floor(width - editorWidth)));
    return { width, max, min: Math.min(MIN, max) };
  }
  function apply(value, { persist = false } = {}) {
    if (value != null) { preferred = clamp(value); useBalancedDefault = false; }
    else if (useBalancedDefault) preferred = clamp(Math.min(defaultWidth, bounds().width * .46));
    const { max, min } = bounds();
    const visible = Math.min(preferred, max);
    drawer.style.setProperty('--wg-library-width', `${visible}px`);
    drawer.dataset.width = String(visible);
    drawer.style.setProperty('--wg-library-max-width', `${max}px`);
    handle?.setAttribute('aria-valuemin', String(min));
    handle?.setAttribute('aria-valuemax', String(max));
    handle?.setAttribute('aria-valuenow', String(visible));
    handle?.setAttribute('aria-valuetext', `${visible} pixels`);
    handle?.setAttribute('aria-disabled', String(max <= min));
    const geometry = `${visible}:${max}:${min}`;
    if (geometry !== lastGeometry && typeof CustomEvent === 'function') {
      lastGeometry = geometry;
      try { drawer.dispatchEvent(new CustomEvent('pp-library-resized', { detail: { width: visible, max, min, preferred } })); } catch {}
    }
    if (persist) save?.(preferred);
  }
  function finish({ persist = true } = {}) {
    if (!drag) return;
    const { pointerId, stopFallback } = drag;
    drag = null;
    stopFallback();
    drawer.classList.remove('resizing');
    try { if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId); } catch {}
    if (persist) save?.(preferred);
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    apply(Math.min(bounds().max, Math.max(bounds().min, drag.width + (event.clientX - drag.x) / drag.scale)));
    event.preventDefault(); event.stopPropagation();
  }
  function up(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    finish(); event.preventDefault(); event.stopPropagation();
  }
  function cancel(event) {
    if (!drag || (event.type !== 'blur' && event.pointerId !== drag.pointerId)) return;
    const previous = drag.previous;
    finish({ persist: false });
    preferred = previous.preferred; useBalancedDefault = previous.balanced; apply();
  }
  listen(handle, 'mousedown', event => event.stopPropagation());
  listen(handle, 'dragstart', event => { event.preventDefault(); event.stopPropagation(); });
  listen(handle, 'pointerdown', event => {
    if (drag || event.button !== 0 || !drawer.classList.contains('open') || bounds().max <= bounds().min) return;
    const parent = drawer.parentElement;
    const rectW = parent?.getBoundingClientRect?.().width || 0;
    const offW = parent?.offsetWidth || parent?.clientWidth || 0;
    const scale = rectW > 0 && offW > 0 ? Math.max(0.1, Math.min(8, rectW / offW)) : 1;
    const owner = drawer.ownerDocument;
    // Transient listeners also cover hosts that do not support pointer capture.
    owner.addEventListener('pointermove', move, true);
    owner.addEventListener('pointerup', up, true);
    owner.addEventListener('pointercancel', cancel, true);
    drag = { pointerId: event.pointerId, x: event.clientX, width: drawer.offsetWidth || Number(drawer.dataset.width) || Math.min(preferred, bounds().max), scale,
      previous: { preferred, balanced: useBalancedDefault },
      stopFallback() {
        owner.removeEventListener('pointermove', move, true);
        owner.removeEventListener('pointerup', up, true);
        owner.removeEventListener('pointercancel', cancel, true);
      } };
    drawer.classList.add('resizing');
    try { handle.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault(); event.stopPropagation();
  });
  listen(handle, 'lostpointercapture', () => finish());
  listen(drawer.ownerDocument?.defaultView, 'blur', cancel);
  listen(handle, 'dblclick', event => {
    useBalancedDefault = true; apply(undefined, { persist: true }); event.preventDefault(); event.stopPropagation();
  });
  listen(handle, 'keydown', event => {
    if (bounds().max <= bounds().min) return;
    const width = Math.min(preferred, bounds().max);
    const step = event.shiftKey ? 40 : 20;
    let next;
    if (event.key === 'ArrowLeft') next = width - step;
    else if (event.key === 'ArrowRight') next = Math.min(bounds().max, width + step);
    else if (event.key === 'Home') { useBalancedDefault = true; next = null; }
    else if (event.key === 'End') next = bounds().max;
    else return;
    apply(next, { persist: true }); event.preventDefault(); event.stopPropagation();
  });
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    if (bounds().max <= bounds().min) finish();
    apply();
  }) : null;
  if (drawer.parentElement) observer?.observe(drawer.parentElement);
  apply();
  return { apply, finish, cleanup() { finish({ persist: false }); observer?.disconnect(); removers.forEach(remove => remove()); } };
}
