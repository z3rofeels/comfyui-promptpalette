// Metadata enriches cards, but must never be a prerequisite for loading artwork.
// Visible media only; local clips stream, custom user images use authenticated fetch.
export function loraPreviewOptions(metadata) {
  const options = (metadata.preview_options || []).map(option => ({ ...option, custom: false }));
  // A companion still must not hide a playable clip. Keep saved custom artwork first.
  options.sort((a, b) => Number(b.type === 'video') - Number(a.type === 'video'));
  if (metadata.custom_preview) options.unshift({ type: 'image', custom: true });
  return options;
}

export function createLoraPreviews(urlFor, { probe, customBlob, canPlay = () => true, onError = () => {}, onReady = () => {} } = {}) {
  const records = new Set(), lookup = new WeakMap();
  let reportedPlayError = false;
  // A card rebuilt under a resting pointer is created detached, so :hover could not be known then.
  const refreshHover = record => { try { record.hovered = record.owner.matches(':hover'); } catch { /* Keep prior state. */ } };
  function reportPlayError(record, error) {
    if (!error || error.name === 'AbortError' || record.closed) return;
    console.warn('[Prompt Palette] LoRA video preview could not play:', error.name, error.message);
    if (reportedPlayError) return;
    reportedPlayError = true;
    const hint = error.name === 'NotAllowedError' ? ' The browser blocked autoplay for this site; allow autoplay in the site permissions.'
      : error.name === 'NotSupportedError' ? ' The browser cannot decode this video codec.' : '';
    onError(record.name, `Video preview could not play (${error.name}).${hint}`);
  }
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = lookup.get(entry.target);
      if (!record || record.closed) continue;
      record.visible = entry.isIntersecting;
      if (record.visible) { refreshHover(record); record.load(); }
      syncPlayback(record);
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
  // Mouse clicks focus tabindex cards and their buttons; only keyboard focus should keep a clip running.
  const keyboardFocus = el => { try { return !!el?.matches?.(':focus-visible'); } catch { return true; } };
  function syncPlayback(record) {
    const media = record.media;
    if (record.closed || !media?.play) return;
    const shouldPlay = record.visible && (record.hovered || record.focused) && !reduced() && canPlay();
    if (shouldPlay) {
      record.playing = true;
      media.play()?.catch(error => {
        if (record.media === media && record.playing) reportPlayError(record, error);
      });
    } else {
      media.pause();
      // Return to the poster frame so the card rests cleanly instead of freezing mid-clip.
      if (record.playing) {
        record.playing = false;
        try { media.currentTime = record.rest || 0; } catch { /* Not seekable yet. */ }
      }
    }
  }
  return {
    append(parent, name, metadata, { className = '', owner = parent, fallback = 'No local preview', preferredIndex = null } = {}) {
      const frame = document.createElement('div'); frame.className = className || 'pp-lora-preview-frame';
      parent.append(frame);
      const record = { frame, owner, name, media: null, objectUrl: null, timer: null, started: false, closed: false, visible: !observer, hovered: owner.matches(':hover'), focused: owner.contains(document.activeElement) && keyboardFocus(document.activeElement), playing: false, rest: 0, abort: new AbortController(), listeners: [] };
      records.add(record); lookup.set(frame, record);
      // Pointer and keyboard focus are independent reasons to keep a clip playing.
      const enter = () => { record.hovered = true; syncPlayback(record); };
      const leave = () => { record.hovered = false; syncPlayback(record); };
      const focus = event => { record.focused = keyboardFocus(event.target); syncPlayback(record); };
      const blur = event => { record.focused = owner.contains(event.relatedTarget) && keyboardFocus(event.relatedTarget); syncPlayback(record); };
      record.listeners = [['pointerenter', enter], ['pointerleave', leave], ['focusin', focus], ['focusout', blur]];
      for (const [event, fn] of record.listeners) owner.addEventListener(event, fn);
      async function mount(options, at = 0) {
        if (record.closed) return;
        clearTimeout(record.timer);
        record.media?.pause?.(); record.media?.removeAttribute('src'); record.media?.load?.();
        record.media = null; record.playing = false; record.rest = 0;
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
          if (failed || record.closed || record.media !== media) return;
          failed = true; clearTimeout(record.timer); mount(options, at + 1);
        };
        media.addEventListener('error', next, { once: true });
        let done = false;
        const ready = (force = false) => {
          if (record.closed || record.media !== media || failed || done) return;
          // preload=metadata does not reliably fire loadeddata (Firefox), so several events can finish the load.
          if (video && !force && media.readyState < 2) return;
          done = true;
          clearTimeout(record.timer); frame.querySelector('.pp-lora-card-placeholder')?.remove();
          media.classList.add('is-ready');
          refreshHover(record);
          const width = video ? media.videoWidth : media.naturalWidth;
          const height = video ? media.videoHeight : media.naturalHeight;
          if (width && height) owner.style.setProperty('--pp-natural-ratio', String(width / height));
          onReady();
          if (video) syncPlayback(record);
        };
        if (video) {
          media.muted = true; media.defaultMuted = true; media.loop = true; media.playsInline = true; media.preload = 'metadata';
          media.setAttribute('aria-label', 'Local video preview; focus to play'); media.title = `${option.name || name} · hover or focus to play`;
          media.addEventListener('loadedmetadata', () => {
            if (record.closed || record.media !== media || failed) return;
            if (Number.isFinite(media.duration) && media.duration > 0) {
              record.rest = Math.min(0.1, media.duration / 2);
              media.currentTime = record.rest;
            } else ready(true);
          }, { once: true });
          for (const event of ['loadeddata', 'seeked', 'canplay']) media.addEventListener(event, () => ready());
        } else {
          media.alt = `Preview for ${name}`; media.decoding = 'async';
          media.addEventListener('load', () => ready(), { once: true });
        }
        placeholder(frame, 'Loading preview…'); frame.append(media);
        try {
          if (option.custom && customBlob) {
            const blob = await customBlob(name, { signal: record.abort.signal });
            if (record.closed || record.media !== media) return;
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
          const options = loraPreviewOptions(meta);
          if (!options.length) options.push({ type: meta.preview_type || 'image', custom: !!meta.custom_preview });
          if (preferredIndex != null) {
            const chosen = options.findIndex(option => !option.custom && option.index === preferredIndex);
            if (chosen >= 0) options.unshift(...options.splice(chosen, 1));
          }
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
    pruneDetached() { for (const record of records) if (!record.frame.isConnected) release(record); },
    refreshPlayback() { for (const record of records) syncPlayback(record); },
    clear(root) { for (const record of records) if (root.contains(record.frame)) release(record); },
    destroy() { observer?.disconnect(); for (const record of records) release(record); },
  };
}
