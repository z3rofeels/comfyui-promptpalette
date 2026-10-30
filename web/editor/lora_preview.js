// Metadata enriches cards, but must never be a prerequisite for loading artwork.
// Visible media only; local clips stream, custom user images use authenticated fetch.
export function createLoraPreviews(urlFor, { probe, customBlob, onError = () => {} } = {}) {
  const records = new Set(), lookup = new WeakMap();
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = lookup.get(entry.target);
      if (!record || record.closed) continue;
      record.visible = entry.isIntersecting;
      if (record.visible) record.load();
      else record.media?.pause?.();
    }
  }, { rootMargin: '100px' }) : null;
  function release(record) {
    record.closed = true; clearTimeout(record.timer); record.abort.abort();
    observer?.unobserve(record.frame);
    for (const [event, fn] of record.listeners) record.owner.removeEventListener(event, fn);
    record.media?.pause?.(); record.media?.removeAttribute('src'); record.media?.load?.();
    if (record.objectUrl) URL.revokeObjectURL(record.objectUrl);
    records.delete(record);
  }
  function placeholder(frame, text, title = '') {
    const empty = document.createElement('div'); empty.className = 'pp-lora-card-placeholder';
    const mark = document.createElement('i'); mark.textContent = '◆'; mark.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.textContent = text;
    empty.title = title; empty.append(mark, label); frame.replaceChildren(empty);
  }
  const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  return {
    append(parent, name, metadata, { className = '', owner = parent, fallback = 'No local preview' } = {}) {
      const frame = document.createElement('div'); frame.className = className || 'pp-lora-preview-frame';
      parent.append(frame);
      const record = { frame, owner, media: null, objectUrl: null, timer: null, started: false, closed: false, visible: !observer, hovered: false, abort: new AbortController(), listeners: [] };
      records.add(record); lookup.set(frame, record);
      const play = () => { record.hovered = true; if (record.visible && !reduced()) record.media?.play?.()?.catch(() => {}); };
      const pause = () => { record.hovered = false; record.media?.pause?.(); };
      record.listeners = [['pointerenter', play], ['pointerleave', pause], ['focusin', play], ['focusout', pause]];
      for (const [event, fn] of record.listeners) owner.addEventListener(event, fn);
      async function mount(options, at = 0) {
        if (record.closed) return;
        clearTimeout(record.timer);
        record.media?.pause?.(); record.media?.removeAttribute('src'); record.media?.load?.();
        if (record.objectUrl) { URL.revokeObjectURL(record.objectUrl); record.objectUrl = null; }
        const option = options[at];
        if (!option) {
          placeholder(frame, 'Preview unavailable', 'The local preview could not be decoded. Try another local image/video or Set image.');
          onError(name, 'Could not display the local preview'); return;
        }
        const video = option.type === 'video', media = document.createElement(video ? 'video' : 'img');
        record.media = media; frame.dataset.mediaType = video ? 'video' : 'image';
        let failed = false;
        const next = () => {
          if (failed || record.closed) return;
          failed = true; clearTimeout(record.timer); mount(options, at + 1);
        };
        media.addEventListener('error', next, { once: true });
        const ready = () => {
          if (record.closed || failed) return;
          clearTimeout(record.timer); frame.querySelector('.pp-lora-card-placeholder')?.remove();
          media.classList.add('is-ready');
          if (video && record.hovered && record.visible && !reduced()) media.play()?.catch(() => {});
        };
        if (video) {
          media.muted = true; media.defaultMuted = true; media.loop = true; media.playsInline = true; media.preload = 'metadata';
          media.setAttribute('aria-label', 'Local video preview; focus to play'); media.title = `${option.name || name} · hover or focus to play`;
          media.addEventListener('loadedmetadata', () => {
            if (record.closed || failed) return;
            if (Number.isFinite(media.duration) && media.duration > 0) media.currentTime = Math.min(0.1, media.duration / 2);
          }, { once: true });
          media.addEventListener('loadeddata', ready, { once: true });
        } else {
          media.alt = `Preview for ${name}`; media.decoding = 'async';
          media.addEventListener('load', ready, { once: true });
        }
        placeholder(frame, 'Loading preview…'); frame.append(media);
        try {
          if (option.custom && customBlob) {
            const blob = await customBlob(name, { signal: record.abort.signal });
            if (record.closed) return;
            record.objectUrl = URL.createObjectURL(blob); media.src = record.objectUrl;
          } else media.src = urlFor(name, { source: option.custom ? 'custom' : 'folder', index: option.index || 0, poster: option.poster === true });
          if (video) media.load();
          record.timer = setTimeout(next, 15000);
        } catch (error) { if (error.name !== 'AbortError') next(); }
      }
      record.load = async () => {
        if (record.started || record.closed) return;
        record.started = true;
        try {
          let meta = metadata;
          if (meta?.has_preview == null) meta = probe ? await probe(name, { signal: record.abort.signal }) : meta;
          if (record.closed) return;
          if (!meta?.has_preview) { placeholder(frame, fallback || 'No local preview'); return; }
          const options = (meta.preview_options || []).map(p => ({ ...p, custom: false }));
          if (meta.custom_preview) options.unshift({ type: 'image', custom: true });
          if (!options.length) options.push({ type: meta.preview_type || 'image', custom: !!meta.custom_preview });
          const fallbacks = options.flatMap(option => option.type === 'video' ? [option, { ...option, type: 'image', poster: true }] : [option]);
          mount(fallbacks);
        } catch (error) {
          if (record.closed || error.name === 'AbortError') return;
          placeholder(frame, 'Preview request failed', error.message); onError(name, error.message);
        }
      };
      placeholder(frame, metadata?.has_preview === false ? (fallback || 'No local preview') : 'Loading preview…');
      if (observer) observer.observe(frame); else record.load();
    },
    clear(root) { for (const record of records) if (root.contains(record.frame)) release(record); },
    destroy() { observer?.disconnect(); for (const record of records) release(record); },
  };
}
