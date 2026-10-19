import { API } from "../prompt_palette_api.js";
import { notify } from "./notifications.js";

let thumbFileInput = null;
let thumbFileResolve = null;
const THUMB_MAX_BYTES = 8 * 1024 * 1024;

function pickThumbnailFile() {
  if (!thumbFileInput) {
    thumbFileInput = document.createElement("input");
    thumbFileInput.type = "file";
    thumbFileInput.accept = "image/png,image/jpeg,.png,.jpg,.jpeg";
    thumbFileInput.style.display = "none";
    thumbFileInput.dataset.promptPaletteGlobal = "true";
    document.body.appendChild(thumbFileInput);
  }
  return new Promise((resolve) => {
    thumbFileResolve?.(null);
    const finish = (file) => {
      if (thumbFileResolve !== finish) return;
      thumbFileResolve = null;
      thumbFileInput.onchange = null;
      thumbFileInput.oncancel = null;
      resolve(file);
    };
    thumbFileResolve = finish;
    thumbFileInput.value = "";
    thumbFileInput.onchange = () => finish(thumbFileInput.files && thumbFileInput.files[0] || null);
    thumbFileInput.oncancel = () => finish(null);
    thumbFileInput.click();
  });
}

function thumbnailFileError(file) {
  const isImageType = /^image\/(png|jpe?g)$/i.test(file.type);
  const isImageExt = /\.(png|jpe?g)$/i.test(file.name || "");
  if (!isImageType && !isImageExt) return "Only PNG or JPEG images are supported.";
  if (!file.size) return "This image is empty. Pick another file.";
  if (file.size > THUMB_MAX_BYTES) return "Image is larger than 8MB — pick a smaller file.";
  return null;
}

// All library surfaces write to the same adjacent PNG/JPEG store. Keep the file
// picker in the original user gesture and recheck ownership when it returns.
export async function changeLibraryThumbnail(path, { file = null, remove = false, isActive = () => true, onChanged } = {}) {
  if (!path || !isActive()) return false;
  const title = remove ? "Thumbnail not removed" : "Thumbnail not set";
  if (!remove) {
    file ||= await pickThumbnailFile();
    if (!file || !isActive()) return false;
    const problem = thumbnailFileError(file);
    if (problem) { notify("error", title, problem); return false; }
  }
  let result;
  try { result = await (remove ? API.removeThumbnail(path) : API.setThumbnail(path, file)); }
  catch { if (isActive()) notify("error", title, "Network error. Please try again."); return false; }
  if (!result?.ok) {
    if (isActive()) notify("error", title, result?.error || "The server rejected the request.");
    return false;
  }
  if (isActive()) {
    // A failed repaint must not misreport a successful disk write as a failed upload.
    try { await onChanged?.(path); }
    catch (error) { console.error("Prompt Palette: thumbnail refresh failed", error); }
    if (isActive()) notify("success", remove ? "Thumbnail removed" : "Thumbnail updated", path.split("/").pop());
  }
  return true;
}

export function libraryThumbnailActions(path, { hasThumbnail = false, editable = true, ...options } = {}) {
  return [
    { label: editable ? hasThumbnail ? "Change Thumbnail…" : "Set Thumbnail…" : "Thumbnails require a TXT entry", icon: "image", group: "thumb", disabled: !editable,
      onSelect: () => editable && changeLibraryThumbnail(path, options) },
    ...(editable && hasThumbnail ? [{ label: "Remove Thumbnail", icon: "trash", group: "thumb", danger: true,
      onSelect: () => changeLibraryThumbnail(path, { ...options, remove: true }) }] : []),
  ];
}


export function cleanupThumbnailPicker() {
  thumbFileResolve?.(null);
  thumbFileInput?.remove();
  thumbFileInput = null;
}

export { pickThumbnailFile, thumbnailFileError };

