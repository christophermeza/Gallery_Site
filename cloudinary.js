export const CLOUD_NAME = "dt6bbufe";
export const UPLOAD_PRESET = "gallery_unsigned";
export const ROOT_FOLDER = "my-site";

export function sanitizeCollectionName(rawName) {
  const cleaned = String(rawName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "general";
}

export function buildCloudinaryFolder(collectionName) {
  const slug = sanitizeCollectionName(collectionName);
  if (slug === "general") return ROOT_FOLDER;
  return `${ROOT_FOLDER}/${slug}`;
}

export function isImageMedia(fileOrItem) {
  if (!fileOrItem) return false;
  if (typeof fileOrItem === "string") {
    return /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?.*)?$/i.test(fileOrItem);
  }
  if (fileOrItem.resourceType) return fileOrItem.resourceType === "image";
  if (fileOrItem.type) return fileOrItem.type.startsWith("image/");
  const target = fileOrItem.secureUrl || fileOrItem.mediaPath || fileOrItem.path || fileOrItem.name || "";
  return /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?.*)?$/i.test(target);
}

export function isVideoMedia(fileOrItem) {
  if (!fileOrItem) return false;
  if (typeof fileOrItem === "string") {
    return /\.(mp4|webm|ogg|mov|m4v|avi|mkv)(\?.*)?$/i.test(fileOrItem);
  }
  if (fileOrItem.resourceType) return fileOrItem.resourceType === "video";
  if (fileOrItem.type) return fileOrItem.type.startsWith("video/");
  const target = fileOrItem.secureUrl || fileOrItem.mediaPath || fileOrItem.path || fileOrItem.name || "";
  return /\.(mp4|webm|ogg|mov|m4v|avi|mkv)(\?.*)?$/i.test(target);
}

export function getVideoPosterUrl(item) {
  if (!item) return "";
  if (item.posterUrl) return item.posterUrl;
  const url = item.secureUrl || item.mediaPath || item.path || "";
  if (!url) return "";
  if (/res\.cloudinary\.com/i.test(url) && url.includes("/video/upload/")) {
    return url
      .replace("/video/upload/", "/video/upload/so_1/")
      .replace(/\.(mp4|webm|ogg|mov|m4v|avi|mkv)(\?.*)?$/i, ".jpg$2");
  }
  return "";
}

export function uploadFileToCloudinary(file, collectionName = "general", onProgress = null, onXhrReady = null) {
  return new Promise((resolve, reject) => {
    const endpoint = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`;
    const folder = buildCloudinaryFolder(collectionName);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", UPLOAD_PRESET);
    formData.append("folder", folder);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", endpoint, true);

    if (typeof onXhrReady === "function") {
      onXhrReady(xhr);
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && typeof onProgress === "function") {
        const pct = Math.round((event.loaded / event.total) * 100);
        onProgress(pct);
      }
    };

    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error(`Invalid response from Cloudinary (HTTP ${xhr.status})`));
        return;
      }

      if (xhr.status >= 200 && xhr.status < 300 && data.secure_url) {
        resolve({
          collection: sanitizeCollectionName(collectionName),
          folder,
          resourceType: data.resource_type || (isVideoMedia(file) ? "video" : "image"),
          publicId: data.public_id || "",
          secureUrl: data.secure_url,
          posterUrl: data.resource_type === "video"
            ? getVideoPosterUrl({ secureUrl: data.secure_url })
            : "",
          width: data.width || null,
          height: data.height || null,
          bytes: data.bytes || file.size || 0,
          originalName: file.name
        });
      } else {
        reject(new Error(data?.error?.message || `Cloudinary upload failed (HTTP ${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error while uploading to Cloudinary."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.send(formData);
  });
}