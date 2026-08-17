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
  if (file.size > THUMB_MAX_BYTES) return "Image is larger than 8MB — pick a smaller file.";
  return null;
}


export function cleanupThumbnailPicker() {
  thumbFileResolve?.(null);
  thumbFileInput?.remove();
  thumbFileInput = null;
}

export { pickThumbnailFile, thumbnailFileError };
