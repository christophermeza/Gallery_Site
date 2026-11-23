import { getAnalytics, logEvent } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { app, db, auth } from "./firebase-config.js";
import {
  sanitizeCollectionName,
  buildCloudinaryFolder,
  isImageMedia,
  isVideoMedia,
  getVideoPosterUrl,
  uploadFileToCloudinary
} from "./cloudinary.js";

// ==========================================
// 0. SHARED NAVBAR LOADER (nav.html)
// ==========================================
async function loadSharedNavbar() {
  const placeholder = document.getElementById("navbar-placeholder");
  if (!placeholder) return;

  try {
    const response = await fetch("nav.html");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    placeholder.innerHTML = await response.text();

    const navToggle = placeholder.querySelector(".nav-toggle");
    const navLinks = placeholder.querySelector(".nav-links");

    if (navToggle && navLinks) {
      navToggle.addEventListener("click", () => {
        const isOpen = navLinks.classList.toggle("open");
        navToggle.setAttribute("aria-expanded", String(isOpen));
      });
    }

    const currentPage = window.location.pathname.split("/").pop() || "index.html";
    placeholder.querySelectorAll(".nav-links a").forEach((link) => {
      const linkPage = link.getAttribute("href");
      link.classList.toggle("active", linkPage === currentPage);
    });
  } catch (err) {
    console.warn("Navbar fetch skipped/failed:", err.message);
  }
}

loadSharedNavbar();

// ==========================================
// 1. MEDIA & METADATA HELPERS (CLOUDINARY + FIRESTORE)
// ==========================================
let dynamicMediaItems = [];
let liveEntries = [];
let mediaById = new Map();
let mediaBySlot = new Map();
let isAdminSignedIn = false;

let deleteJournalEntryById = async () => {};
let deleteMediaItemById = async () => {};

let trackEvent = () => {};
try {
  const analytics = getAnalytics(app);
  trackEvent = (name, params) => logEvent(analytics, name, params);
} catch (e) {}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getItemUrl(item) {
  if (!item) return "";
  if (typeof item === "string") return item.trim();
  return String(
    item.secureUrl ||
    item.mediaUrl ||
    item.url ||
    item.mediaPath ||
    item.file ||
    item.path ||
    ""
  ).trim();
}

function getItemCollection(item) {
  if (!item) return "general";
  if (item.collection) return sanitizeCollectionName(item.collection);
  if (item.folder) {
    const cleaned = String(item.folder).replace(/^my-site\/?/i, "").trim();
    if (cleaned) return sanitizeCollectionName(cleaned);
  }
  const url = getItemUrl(item);
  const match = url.match(/\/my-site\/([^/]+)\//i);
  if (match && match[1]) return sanitizeCollectionName(match[1]);
  return "general";
}

function getItemResourceType(item) {
  if (!item) return "image";
  if (item.resourceType === "video" || item.resource_type === "video") return "video";
  if (item.resourceType === "image" || item.resource_type === "image") return "image";
  return isVideoMedia(getItemUrl(item)) ? "video" : "image";
}

function getItemTitle(item) {
  if (!item) return "Untitled";
  return String(item.title || item.displayTitle || item.originalName || item.name || "Untitled").trim();
}

function getItemAlt(item) {
  if (!item) return "Gallery media";
  return String(item.altText || item.caption || getItemTitle(item)).trim();
}

function getItemTimestamp(item) {
  if (!item || !item.createdAt) return 0;
  if (typeof item.createdAt === "number") return item.createdAt;
  if (typeof item.createdAt.toMillis === "function") return item.createdAt.toMillis();
  if (item.createdAt.seconds) return item.createdAt.seconds * 1000;
  const parsed = Date.parse(item.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resolveMediaReference(refIdOrSlot, fallbackUrl = "") {
  if (refIdOrSlot) {
    if (mediaById.has(refIdOrSlot)) return mediaById.get(refIdOrSlot);
    if (mediaBySlot.has(refIdOrSlot)) return mediaBySlot.get(refIdOrSlot);
  }
  if (fallbackUrl) {
    const matched = dynamicMediaItems.find((m) => getItemUrl(m) === fallbackUrl);
    if (matched) return matched;
    return {
      secureUrl: fallbackUrl,
      resourceType: isVideoMedia(fallbackUrl) ? "video" : "image",
      posterUrl: isVideoMedia(fallbackUrl) ? getVideoPosterUrl({ secureUrl: fallbackUrl }) : ""
    };
  }
  return null;
}

function getAllValidMediaItems() {
  return dynamicMediaItems.filter((item) => /^https?:\/\//i.test(getItemUrl(item)));
}

function getCollectionsMap() {
  const grouped = {};
  getAllValidMediaItems().forEach((item) => {
    const col = getItemCollection(item);
    if (!grouped[col]) grouped[col] = [];
    grouped[col].push(item);
  });
  return grouped;
}

function formatHashtags(rawTags) {
  const parts = Array.isArray(rawTags)
    ? rawTags.flatMap((t) => String(t || "").split(","))
    : String(rawTags || "").split(",");

  return parts
    .map((item) => item.replace(/\s+/g, "").replace(/^#+/, ""))
    .filter(Boolean)
    .map((tag) => `#${tag}`)
    .join(" ");
}

function formatPeopleList(rawPeople) {
  const parts = Array.isArray(rawPeople)
    ? rawPeople.flatMap((p) => String(p || "").split(","))
    : String(rawPeople || "").split(",");

  return parts
    .map((item) => item.trim())
    .filter(Boolean)
    .join(", ");
}

function detectFileDimensions(file, targetInput) {
  if (!file || !targetInput) return;
  const objectUrl = URL.createObjectURL(file);

  if (file.type.startsWith("video/")) {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      targetInput.value = `${video.videoWidth}x${video.videoHeight}px`;
      URL.revokeObjectURL(objectUrl);
    };
    video.onerror = () => URL.revokeObjectURL(objectUrl);
    video.src = objectUrl;
  } else if (file.type.startsWith("image/")) {
    const img = new Image();
    img.onload = () => {
      targetInput.value = `${img.naturalWidth}x${img.naturalHeight}px`;
      URL.revokeObjectURL(objectUrl);
    };
    img.onerror = () => URL.revokeObjectURL(objectUrl);
    img.src = objectUrl;
  } else {
    URL.revokeObjectURL(objectUrl);
  }
}

function renderMediaFallback(container, fallbackText, defaultLabel = "No media available") {
  if (!container) return;
  const caption = (fallbackText || "").trim() || defaultLabel;
  container.innerHTML = `<span class="journal-media-placeholder">${escapeHtml(caption)}</span>`;
}

function populateExistingMediaSelects() {
  const validItems = getAllValidMediaItems();

  const journalSelect = document.getElementById("journal-existing-media-select");
  if (journalSelect) {
    const prevVal = journalSelect.value;
    journalSelect.innerHTML = '<option value="">-- Select from existing media --</option>';
    validItems.forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item.id || getItemUrl(item);
      opt.dataset.url = getItemUrl(item);
      opt.textContent = `${getItemTitle(item)} (${getItemCollection(item)})`;
      journalSelect.appendChild(opt);
    });
    if (prevVal) journalSelect.value = prevVal;
  }

  const aboutSelect = document.getElementById("about-existing-media-select");
  if (aboutSelect) {
    const prevVal = aboutSelect.value;
    aboutSelect.innerHTML = '<option value="">-- Select from existing media --</option>';
    validItems
      .filter((item) => getItemResourceType(item) === "image")
      .forEach((item) => {
        const opt = document.createElement("option");
        opt.value = getItemUrl(item);
        opt.textContent = `${getItemTitle(item)} (${getItemCollection(item)})`;
        aboutSelect.appendChild(opt);
      });
    if (prevVal) aboutSelect.value = prevVal;
  }
}

// ==========================================
// 2. FULL-SCREEN INTRO TRANSITION
// ==========================================
const titleScreen = document.getElementById("title-screen");
if (titleScreen && !sessionStorage.getItem("introSeen")) {
  const dismissIntro = () => {
    titleScreen.classList.add("fade-out");
    sessionStorage.setItem("introSeen", "true");
    setTimeout(() => {
      titleScreen.style.display = "none";
    }, 850);
  };
  setTimeout(dismissIntro, 1800);
  titleScreen.onclick = dismissIntro;
} else if (titleScreen) {
  titleScreen.style.display = "none";
}

// ==========================================
// 3. LIGHTBOX & ENTRY DETAIL MODAL
// ==========================================
const lightbox = document.getElementById("lightbox");
const lightboxContent = document.getElementById("lightbox-content");
const lightboxCaption = document.getElementById("lightbox-caption");
const lightboxClose = document.getElementById("lightbox-close");
const lightboxPrev = document.getElementById("lightbox-prev");
const lightboxNext = document.getElementById("lightbox-next");

let activeGalleryList = [];
let currentMediaIndex = 0;

function renderLightboxItem(index) {
  if (!lightbox || !lightboxContent || activeGalleryList.length === 0) return;
  currentMediaIndex = (index + activeGalleryList.length) % activeGalleryList.length;
  const item = activeGalleryList[currentMediaIndex];
  const url = getItemUrl(item);
  const titleText = getItemTitle(item);
  const altText = getItemAlt(item);
  const isVideo = getItemResourceType(item) === "video";

  lightboxContent.innerHTML = "";
  if (isVideo) {
    const vid = document.createElement("video");
    vid.src = url;
    vid.controls = true;
    vid.preload = "none";
    vid.playsInline = true;
    const poster = getVideoPosterUrl(item);
    if (poster) vid.poster = poster;
    vid.onerror = () => {
      lightboxContent.innerHTML = `<p class="entry-media-missing" style="color:#fff;">${escapeHtml(altText)}</p>`;
    };
    lightboxContent.appendChild(vid);
  } else {
    const img = document.createElement("img");
    img.src = url;
    img.alt = altText;
    img.onerror = () => {
      lightboxContent.innerHTML = `<p class="entry-media-missing" style="color:#fff;">${escapeHtml(altText)}</p>`;
    };
    lightboxContent.appendChild(img);
  }

  if (lightboxCaption) {
    lightboxCaption.textContent = `${titleText} (${currentMediaIndex + 1} of ${activeGalleryList.length})`;
  }
  lightbox.classList.remove("hidden");
  trackEvent("view_media", { media_name: titleText });
}

if (lightboxClose && lightbox && lightboxContent) {
  lightboxClose.onclick = () => {
    lightbox.classList.add("hidden");
    lightboxContent.innerHTML = "";
  };
  lightbox.onclick = (e) => {
    if (e.target === lightbox) lightboxClose.onclick();
  };
}

if (lightboxPrev && lightboxNext) {
  lightboxPrev.onclick = (e) => {
    e.stopPropagation();
    renderLightboxItem(currentMediaIndex - 1);
  };
  lightboxNext.onclick = (e) => {
    e.stopPropagation();
    renderLightboxItem(currentMediaIndex + 1);
  };
}

const detailModal = document.getElementById("entry-detail-modal");
const detailContent = document.getElementById("entry-detail-content");
let openJournalEditForm = () => {};

function closeEntryDetail() {
  if (!detailModal || !detailContent) return;
  detailModal.classList.add("hidden");
  detailContent.innerHTML = "";
  document.body.classList.remove("detail-modal-open");
}

function appendMetaRow(container, label, value) {
  if (!value) return;
  const row = document.createElement("div");
  row.className = "entry-meta-row";

  const strong = document.createElement("strong");
  strong.textContent = `${label}: `;

  const span = document.createElement("span");
  span.textContent = String(value);

  row.appendChild(strong);
  row.appendChild(span);
  container.appendChild(row);
}

function openEntryDetail(entry) {
  if (!detailModal || !detailContent) return;
  detailContent.innerHTML = "";
  document.body.classList.add("detail-modal-open");

  const linkedMedia = resolveMediaReference(entry.mediaId || entry.slot, getItemUrl(entry));
  const mediaUrl = getItemUrl(linkedMedia) || getItemUrl(entry);
  const titleText = entry.title || entry.displayTitle || (linkedMedia && getItemTitle(linkedMedia)) || "Untitled Memory";
  const fallbackCaption = entry.altText || (linkedMedia && getItemAlt(linkedMedia)) || titleText;
  const formattedPeople = formatPeopleList(entry.people);
  const formattedTags = formatHashtags(entry.tags);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "entry-detail-close";
  closeBtn.textContent = "✕";
  closeBtn.onclick = closeEntryDetail;
  detailContent.appendChild(closeBtn);

  const mediaWrap = document.createElement("div");
  mediaWrap.className = "entry-detail-media";

  if (mediaUrl && isVideoMedia(mediaUrl)) {
    const vid = document.createElement("video");
    vid.src = mediaUrl;
    vid.controls = true;
    vid.preload = "none";
    vid.playsInline = true;
    const poster = getVideoPosterUrl(linkedMedia || { secureUrl: mediaUrl, posterUrl: entry.posterUrl });
    if (poster) vid.poster = poster;
    vid.onerror = () => {
      mediaWrap.innerHTML = `<p class="entry-media-missing">${escapeHtml(fallbackCaption)}</p>`;
    };
    mediaWrap.appendChild(vid);
  } else if (mediaUrl) {
    const img = document.createElement("img");
    img.src = mediaUrl;
    img.alt = fallbackCaption;
    img.onerror = () => {
      mediaWrap.innerHTML = `<p class="entry-media-missing">${escapeHtml(fallbackCaption)}</p>`;
    };
    mediaWrap.appendChild(img);
  } else {
    mediaWrap.innerHTML = `<p class="entry-media-missing">${escapeHtml(fallbackCaption)}</p>`;
  }

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "entry-detail-body";

  const headerStack = document.createElement("div");
  headerStack.className = "entry-detail-header-stack";

  const titleEl = document.createElement("h2");
  titleEl.textContent = titleText;

  const dateEl = document.createElement("span");
  dateEl.className = "journal-date";
  dateEl.textContent = entry.date || "";

  headerStack.appendChild(titleEl);
  if (entry.date) headerStack.appendChild(dateEl);

  const descEl = document.createElement("p");
  descEl.className = "entry-detail-description";
  descEl.textContent = entry.body || entry.description || "";

  const metaBox = document.createElement("div");
  metaBox.className = "entry-meta-grid";
  appendMetaRow(metaBox, "Location", entry.location);
  appendMetaRow(metaBox, "People", formattedPeople);
  appendMetaRow(metaBox, "Tags", formattedTags);
  appendMetaRow(metaBox, "Camera / Device", entry.camera);
  appendMetaRow(metaBox, "Resolution", entry.resolution);
  appendMetaRow(metaBox, "Alt Text", entry.altText);

  bodyWrap.appendChild(headerStack);
  if (entry.body || entry.description) bodyWrap.appendChild(descEl);
  bodyWrap.appendChild(metaBox);

  if (isAdminSignedIn && entry.id) {
    const adminRow = document.createElement("div");
    adminRow.className = "journal-admin-actions";
    adminRow.style.marginTop = "16px";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn";
    editBtn.textContent = "Edit Entry";
    editBtn.onclick = () => {
      closeEntryDetail();
      openJournalEditForm(entry);
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-danger-inline";
    deleteBtn.textContent = "Delete Entry";
    deleteBtn.onclick = async () => {
      await deleteJournalEntryById(entry.id, titleText);
      closeEntryDetail();
    };

    adminRow.appendChild(editBtn);
    adminRow.appendChild(deleteBtn);
    bodyWrap.appendChild(adminRow);
  }

  detailContent.appendChild(mediaWrap);
  detailContent.appendChild(bodyWrap);

  detailModal.classList.remove("hidden");
}

if (detailModal) {
  detailModal.onclick = (e) => {
    if (e.target === detailModal) closeEntryDetail();
  };
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && detailModal && !detailModal.classList.contains("hidden")) {
    closeEntryDetail();
    return;
  }
  if (!lightbox || lightbox.classList.contains("hidden")) return;
  if (e.key === "ArrowLeft") renderLightboxItem(currentMediaIndex - 1);
  if (e.key === "ArrowRight") renderLightboxItem(currentMediaIndex + 1);
  if (e.key === "Escape" && lightboxClose) lightboxClose.onclick();
});

function createMediaCard(itemObj, listRef, indexInList, options = {}) {
  const url = getItemUrl(itemObj);
  const titleText = getItemTitle(itemObj);
  const altText = getItemAlt(itemObj);
  const isVideo = getItemResourceType(itemObj) === "video";
  const hideOnError = Boolean(options.hideOnError);

  const card = document.createElement("div");
  card.className = "media-item";

  const handleBrokenMedia = () => {
    if (hideOnError) {
      card.remove();
      return;
    }
    card.classList.add("media-missing");
    card.innerHTML = `<span class="media-fallback-text">${escapeHtml(altText)}</span>`;
  };

  if (isVideo) {
    const badge = document.createElement("span");
    badge.className = "video-badge";
    badge.textContent = "▶ VIDEO";

    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "none";
    const poster = getVideoPosterUrl(itemObj);
    if (poster) video.poster = poster;
    video.onerror = handleBrokenMedia;

    card.appendChild(badge);
    card.appendChild(video);
  } else {
    const img = document.createElement("img");
    img.src = url;
    img.alt = altText;
    img.loading = "lazy";
    img.onerror = handleBrokenMedia;
    card.appendChild(img);
  }

  if (isAdminSignedIn && itemObj.id) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "card-delete-badge";
    delBtn.textContent = "✕";
    delBtn.title = "Remove media item";
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      await deleteMediaItemById(itemObj.id, titleText);
    };
    card.appendChild(delBtn);
  }

  card.onclick = (e) => {
    if (e.target && e.target.tagName === "VIDEO") return;
    activeGalleryList = listRef;
    renderLightboxItem(indexInList);
  };
  return card;
}

// ==========================================
// 4. HOMEPAGE HIGHLIGHTS (index.html)
// ==========================================
const homeHighlights = document.getElementById("home-highlights");

function renderHomeHighlights() {
  if (!homeHighlights) return;
  homeHighlights.innerHTML = "";

  const sorted = [...getAllValidMediaItems()].sort(
    (a, b) => getItemTimestamp(b) - getItemTimestamp(a)
  );
  const favorites = sorted.filter((item) => item.favorite === true);
  const highlightList = (favorites.length > 0 ? favorites : sorted).slice(0, 8);

  highlightList.forEach((item, idx) => {
    homeHighlights.appendChild(createMediaCard(item, highlightList, idx, { hideOnError: true }));
  });
}

renderHomeHighlights();

// ==========================================
// 5. MEDIA PAGE + FILTERS (media.html)
// ==========================================
const mediaGallery = document.getElementById("media-gallery");
let renderAllMedia = null;
let currentMediaFilter = "all";

if (mediaGallery) {
  renderAllMedia = (filter = currentMediaFilter) => {
    currentMediaFilter = filter;
    mediaGallery.innerHTML = "";

    const filteredList = getAllValidMediaItems().filter((item) => {
      const type = getItemResourceType(item);
      if (filter === "image") return type === "image";
      if (filter === "video") return type === "video";
      return true;
    });

    filteredList.forEach((item, idx) => {
      mediaGallery.appendChild(createMediaCard(item, filteredList, idx));
    });
  };

  const urlFilter = new URLSearchParams(window.location.search).get("filter");
  const initialFilter = ["image", "video"].includes(urlFilter) ? urlFilter : "all";

  document.querySelectorAll(".filter-btn").forEach((btn) => {
    const isMatch = btn.dataset.filter === initialFilter;
    btn.classList.toggle("active-filter", isMatch);
    btn.classList.toggle("btn-secondary", !isMatch);

    btn.onclick = () => {
      document.querySelectorAll(".filter-btn").forEach((b) => {
        b.classList.remove("active-filter");
        b.classList.add("btn-secondary");
      });
      btn.classList.add("active-filter");
      btn.classList.remove("btn-secondary");
      renderAllMedia(btn.dataset.filter);
    };
  });

  renderAllMedia(initialFilter);
}

// ==========================================
// 6. COLLECTIONS PAGE WITH COVER PHOTOS (collections.html)
// ==========================================
const collectionsGrid = document.getElementById("collections-grid");
const collectionTitle = document.getElementById("collection-title");
const backBtn = document.getElementById("back-to-albums");
let activeCollectionFolder = null;
let renderCollectionsView = () => {};

if (collectionsGrid) {
  function showAlbums() {
    activeCollectionFolder = null;
    collectionsGrid.innerHTML = "";
    if (collectionTitle) collectionTitle.textContent = "Collections";
    if (backBtn) backBtn.classList.add("hidden");

    const grouped = getCollectionsMap();
    Object.entries(grouped).forEach(([folderName, items]) => {
      const coverItem = items.find((i) => getItemResourceType(i) === "image") || items[0];
      if (!coverItem) return;

      const albumCard = document.createElement("div");
      albumCard.className = "album-card";

      const img = document.createElement("img");
      img.className = "album-cover";
      img.src = getItemResourceType(coverItem) === "video"
        ? getVideoPosterUrl(coverItem)
        : getItemUrl(coverItem);
      img.alt = getItemAlt(coverItem) || folderName;
      img.onerror = () => {
        albumCard.style.display = "none";
      };

      const info = document.createElement("div");
      info.className = "album-info";

      const h3 = document.createElement("h3");
      h3.textContent = folderName;

      const p = document.createElement("p");
      p.textContent = items.length + (items.length === 1 ? " item" : " items");

      info.appendChild(h3);
      info.appendChild(p);
      albumCard.appendChild(img);
      albumCard.appendChild(info);

      albumCard.onclick = () => openAlbum(folderName);
      collectionsGrid.appendChild(albumCard);
    });
  }

  function openAlbum(folderName) {
    const slug = sanitizeCollectionName(folderName);
    activeCollectionFolder = slug;
    collectionsGrid.innerHTML = "";
    if (collectionTitle) {
      collectionTitle.textContent = slug.charAt(0).toUpperCase() + slug.slice(1);
    }
    if (backBtn) backBtn.classList.remove("hidden");
    trackEvent("open_album", { album_name: slug });

    const grouped = getCollectionsMap();
    const albumList = grouped[slug] || [];

    albumList.forEach((item, idx) => {
      collectionsGrid.appendChild(createMediaCard(item, albumList, idx));
    });
  }

  renderCollectionsView = () => {
    if (activeCollectionFolder) openAlbum(activeCollectionFolder);
    else showAlbums();
  };

  showAlbums();
  if (backBtn) backBtn.onclick = showAlbums;
}

// ==========================================
// 7. ABOUT PAGE STATS & BANNER (about.html)
// ==========================================
const archiveStats = document.getElementById("archive-stats");

function renderArchiveStats() {
  if (!archiveStats) return;
  const grouped = getCollectionsMap();
  const allItems = getAllValidMediaItems();
  let totalPhotos = 0;
  let totalVideos = 0;
  const totalAlbums = Object.keys(grouped).length;

  allItems.forEach((item) => {
    if (getItemResourceType(item) === "video") totalVideos++;
    else totalPhotos++;
  });

  const stats = [
    { count: totalAlbums, label: "Albums", href: "collections.html" },
    { count: totalPhotos, label: "Photos", href: "media.html?filter=image" },
    { count: totalVideos, label: "Videos", href: "media.html?filter=video" }
  ];

  archiveStats.innerHTML = "";
  stats.forEach((item) => {
    const box = document.createElement("a");
    box.className = "stat-box";
    box.href = item.href;

    const num = document.createElement("strong");
    num.textContent = item.count;

    const text = document.createTextNode(item.label);

    box.appendChild(num);
    box.appendChild(text);
    archiveStats.appendChild(box);
  });
}

renderArchiveStats();

// ==========================================
// 8. FIREBASE FIRESTORE SYNC & INLINE EDITORS
// ==========================================
function rebuildMediaLookups() {
  const byId = new Map();
  const bySlot = new Map();

  dynamicMediaItems.forEach((item) => {
    if (item.id) byId.set(item.id, item);
    if (item.slot) bySlot.set(String(item.slot).trim(), item);
  });

  mediaById = byId;
  mediaBySlot = bySlot;
}

function refreshAllViews() {
  rebuildMediaLookups();
  populateExistingMediaSelects();
  renderHomeHighlights();
  if (typeof renderAllMedia === "function") renderAllMedia(currentMediaFilter);
  renderCollectionsView();
  renderArchiveStats();
  renderJournal();
  if (typeof renderAboutBannerFromState === "function") renderAboutBannerFromState();

  if (lightbox && !lightbox.classList.contains("hidden")) {
    renderLightboxItem(currentMediaIndex);
  }
}

deleteJournalEntryById = async (entryId, entryTitle) => {
  if (!isAdminSignedIn || !entryId) return;
  if (!window.confirm(`Delete "${entryTitle || "this entry"}"?`)) return;
  try {
    await deleteDoc(doc(db, "entries", entryId));
  } catch (err) {
    window.alert(`Could not delete entry: ${err.message}`);
  }
};

deleteMediaItemById = async (mediaId, label) => {
  if (!isAdminSignedIn || !mediaId) return;
  if (!window.confirm(`Remove "${label || "this media item"}"?`)) return;
  try {
    await deleteDoc(doc(db, "mediaItems", mediaId));
  } catch (err) {
    window.alert(`Could not remove media item: ${err.message}`);
  }
};

onAuthStateChanged(auth, (user) => {
  isAdminSignedIn = Boolean(user);

  [
    "toggle-home-edit-btn",
    "toggle-add-collection-btn",
    "add-journal-entry-btn",
    "about-admin-controls",
    "toggle-about-edit-btn"
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", !isAdminSignedIn);
  });

  if (isAdminSignedIn && typeof syncAboutEditorInputs === "function") {
    syncAboutEditorInputs();
  }

  refreshAllViews();
});

// ------------------------------------------
// A. HOME PAGE INLINE EDITOR (index.html)
// ------------------------------------------
const homePageTitle = document.getElementById("home-page-title");
const homeHeroHeading = document.getElementById("home-hero-heading");
const homeHeroSubtext = document.getElementById("home-hero-subtext");
const toggleHomeEditBtn = document.getElementById("toggle-home-edit-btn");
const homeEditorPanel = document.getElementById("home-editor-panel");
const homeSectionInput = document.getElementById("home-section-input");
const homeHeadingInput = document.getElementById("home-heading-input");
const homeSubtextInput = document.getElementById("home-subtext-input");
const cancelHomeEditBtn = document.getElementById("cancel-home-edit-btn");
const homeSaveStatus = document.getElementById("home-save-status");

onSnapshot(doc(db, "settings", "homePage"), (snap) => {
  const data = snap.exists() ? snap.data() : {};
  if (homePageTitle && data.sectionTitle) homePageTitle.textContent = data.sectionTitle;
  if (homeHeroHeading && data.heroHeading) homeHeroHeading.textContent = data.heroHeading;
  if (homeHeroSubtext && data.heroSubtext) homeHeroSubtext.textContent = data.heroSubtext;

  if (homeSectionInput && homePageTitle) homeSectionInput.value = homePageTitle.textContent.trim();
  if (homeHeadingInput && homeHeroHeading) homeHeadingInput.value = homeHeroHeading.textContent.trim();
  if (homeSubtextInput && homeHeroSubtext) homeSubtextInput.value = homeHeroSubtext.textContent.trim();
});

if (toggleHomeEditBtn && homeEditorPanel) {
  toggleHomeEditBtn.onclick = () => homeEditorPanel.classList.toggle("hidden");
}
if (cancelHomeEditBtn && homeEditorPanel) {
  cancelHomeEditBtn.onclick = () => {
    homeEditorPanel.classList.add("hidden");
    if (homeSaveStatus) homeSaveStatus.textContent = "";
  };
}
if (homeEditorPanel) {
  homeEditorPanel.onsubmit = async (e) => {
    e.preventDefault();
    if (!isAdminSignedIn) return;
    if (homeSaveStatus) homeSaveStatus.textContent = "Saving...";
    try {
      await setDoc(doc(db, "settings", "homePage"), {
        sectionTitle: homeSectionInput.value.trim(),
        heroHeading: homeHeadingInput.value.trim(),
        heroSubtext: homeSubtextInput.value.trim(),
        updatedAt: serverTimestamp()
      }, { merge: true });
      if (homeSaveStatus) homeSaveStatus.textContent = "Saved.";
      homeEditorPanel.classList.add("hidden");
    } catch (err) {
      if (homeSaveStatus) homeSaveStatus.textContent = `Save failed: ${err.message}`;
    }
  };
}

// ------------------------------------------
// B. COLLECTIONS CLOUDINARY UPLOAD & FIRESTORE SAVE (collections.html)
// ------------------------------------------
const toggleColBtn = document.getElementById("toggle-add-collection-btn");
const colPanel = document.getElementById("collection-add-panel");
const cancelColBtn = document.getElementById("cancel-add-collection-btn");
const colSubmitBtn = document.getElementById("col-submit-btn");
const colCancelUploadBtn = document.getElementById("col-cancel-upload-btn");
const colFolderInput = document.getElementById("col-folder-input");
const colDropzone = document.getElementById("col-dropzone");
const colRemoteUploadInput = document.getElementById("col-remote-upload");
const colPickFolderModeBtn = document.getElementById("col-pick-folder-mode-btn");
const colFolderUploadInput = document.getElementById("col-folder-upload");
const colTitleInput = document.getElementById("col-title-input");
const colAltInput = document.getElementById("col-alt-input");
const colStatusEl = document.getElementById("col-add-status");
const colTrackerEl = document.getElementById("col-upload-tracker");
const colTrackerSummary = document.getElementById("col-tracker-summary");
const colTrackerPercent = document.getElementById("col-tracker-percent");
const colProgressBar = document.getElementById("col-progress-bar");
const colTrackerCurrent = document.getElementById("col-tracker-current");
const colTrackerList = document.getElementById("col-tracker-list");

let queuedUploadEntries = [];
let activeUploadXhr = null;
let uploadCancelled = false;

function inferCollectionFromFile(file, fallbackFolder) {
  const rel = String(file.webkitRelativePath || "").replace(/\\/g, "/");
  const parts = rel.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const candidate = parts[parts.length - 2].toLowerCase();
    if (candidate && candidate !== "media") {
      return sanitizeCollectionName(candidate);
    }
  }
  return sanitizeCollectionName(fallbackFolder) || "general";
}

function addFilesToQueue(fileList) {
  const baseFolder = (colFolderInput && colFolderInput.value.trim()) || activeCollectionFolder || "general";
  const incoming = Array.from(fileList || []).filter(
    (f) => isImageMedia(f) || isVideoMedia(f)
  );

  incoming.forEach((file) => {
    const colName = inferCollectionFromFile(file, baseFolder);
    const cleanTitle = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Untitled";
    const key = `${file.name}::${file.size}::${colName}`;
    if (!queuedUploadEntries.some((entry) => entry.key === key)) {
      queuedUploadEntries.push({
        key,
        file,
        collection: colName,
        title: cleanTitle
      });
    }
  });

  if (colStatusEl && queuedUploadEntries.length > 0) {
    colStatusEl.textContent = `${queuedUploadEntries.length} media file(s) ready to upload to Cloudinary (${buildCloudinaryFolder(baseFolder)}).`;
  }
}

if (colPanel) {
  if (toggleColBtn) {
    toggleColBtn.onclick = () => {
      if (activeCollectionFolder && colFolderInput) {
        colFolderInput.value = activeCollectionFolder;
      }
      colPanel.classList.toggle("hidden");
    };
  }

  if (cancelColBtn) {
    cancelColBtn.onclick = () => {
      queuedUploadEntries = [];
      colPanel.reset();
      colPanel.classList.add("hidden");
      if (colStatusEl) colStatusEl.textContent = "";
      if (colTrackerEl) colTrackerEl.classList.add("hidden");
    };
  }

  if (colCancelUploadBtn) {
    colCancelUploadBtn.onclick = () => {
      uploadCancelled = true;
      if (activeUploadXhr) activeUploadXhr.abort();
    };
  }

  if (colDropzone && colRemoteUploadInput) {
    colDropzone.onclick = (e) => {
      if (e.target === colRemoteUploadInput) return;
      colRemoteUploadInput.click();
    };
    colDropzone.ondragover = (e) => {
      e.preventDefault();
      colDropzone.classList.add("drag-over");
    };
    colDropzone.ondragleave = () => {
      colDropzone.classList.remove("drag-over");
    };
    colDropzone.ondrop = (e) => {
      e.preventDefault();
      colDropzone.classList.remove("drag-over");
      if (e.dataTransfer && e.dataTransfer.files) {
        addFilesToQueue(e.dataTransfer.files);
      }
    };
  }

  if (colRemoteUploadInput) {
    colRemoteUploadInput.onchange = () => {
      addFilesToQueue(colRemoteUploadInput.files);
      colRemoteUploadInput.value = "";
    };
  }

  if (colPickFolderModeBtn && colFolderUploadInput) {
    colPickFolderModeBtn.onclick = () => colFolderUploadInput.click();
    colFolderUploadInput.onchange = () => {
      addFilesToQueue(colFolderUploadInput.files);
      colFolderUploadInput.value = "";
    };
  }

  colPanel.onsubmit = async (e) => {
    e.preventDefault();
    if (!isAdminSignedIn) return;

    if (queuedUploadEntries.length === 0) {
      if (colStatusEl) {
        colStatusEl.textContent = "Select one or more image/video files first, then click Upload & Save.";
      }
      return;
    }

    const folderOverride = colFolderInput && colFolderInput.value.trim()
      ? sanitizeCollectionName(colFolderInput.value)
      : "";
    const customTitle = (colTitleInput && colTitleInput.value.trim()) || "";
    const customAlt = (colAltInput && colAltInput.value.trim()) || "";

    uploadCancelled = false;
    if (colSubmitBtn) colSubmitBtn.disabled = true;
    if (colCancelUploadBtn) colCancelUploadBtn.classList.remove("hidden");
    if (colTrackerEl) colTrackerEl.classList.remove("hidden");
    if (colTrackerList) colTrackerList.innerHTML = "";
    if (colStatusEl) colStatusEl.textContent = "";

    const total = queuedUploadEntries.length;
    let completed = 0;

    for (let i = 0; i < total; i++) {
      if (uploadCancelled) break;
      const entry = queuedUploadEntries[i];
      const targetCol = folderOverride || entry.collection || "general";
      const finalTitle = (total === 1 && customTitle) || entry.title;
      const finalAlt = customAlt || finalTitle;

      if (colTrackerSummary) colTrackerSummary.textContent = `Uploading ${i + 1} of ${total}`;
      if (colTrackerCurrent) {
        colTrackerCurrent.textContent = `${entry.file.name} -> ${buildCloudinaryFolder(targetCol)}`;
      }

      try {
        const uploaded = await uploadFileToCloudinary(
          entry.file,
          targetCol,
          (pct) => {
            const overallPct = Math.round(((i + pct / 100) / total) * 100);
            if (colTrackerPercent) colTrackerPercent.textContent = `${overallPct}%`;
            if (colProgressBar) colProgressBar.style.width = `${overallPct}%`;
          },
          (xhr) => {
            activeUploadXhr = xhr;
          }
        );
        activeUploadXhr = null;

        await addDoc(collection(db, "mediaItems"), {
          title: finalTitle,
          collection: uploaded.collection,
          folder: uploaded.folder,
          resourceType: uploaded.resourceType,
          secureUrl: uploaded.secureUrl,
          posterUrl: uploaded.posterUrl || "",
          publicId: uploaded.publicId || "",
          altText: finalAlt,
          favorite: false,
          slot: null,
          journalId: null,
          createdAt: Date.now()
        });

        completed++;
        if (colTrackerList) {
          const li = document.createElement("li");
          li.className = "upload-tracker-item";
          li.innerHTML = `<span>${escapeHtml(entry.file.name)}</span><span class="status-done">Saved</span>`;
          colTrackerList.appendChild(li);
        }
      } catch (err) {
        activeUploadXhr = null;
        if (colTrackerList) {
          const li = document.createElement("li");
          li.className = "upload-tracker-item";
          const statusClass = uploadCancelled ? "status-cancelled" : "status-error";
          const statusLabel = uploadCancelled ? "Cancelled" : `Failed: ${err.message}`;
          li.innerHTML = `<span>${escapeHtml(entry.file.name)}</span><span class="${statusClass}">${escapeHtml(statusLabel)}</span>`;
          colTrackerList.appendChild(li);
        }
      }
    }

    if (colSubmitBtn) colSubmitBtn.disabled = false;
    if (colCancelUploadBtn) colCancelUploadBtn.classList.add("hidden");

    const finalPct = Math.round((completed / total) * 100);
    if (colTrackerPercent) colTrackerPercent.textContent = `${finalPct}%`;
    if (colProgressBar) colProgressBar.style.width = `${finalPct}%`;
    if (colTrackerSummary) {
      colTrackerSummary.textContent = uploadCancelled
        ? `Cancelled (${completed}/${total} saved)`
        : `Completed (${completed}/${total} saved)`;
    }
    if (colTrackerCurrent) colTrackerCurrent.textContent = "";

    queuedUploadEntries = [];
    if (completed === total && !uploadCancelled) {
      colPanel.reset();
      colPanel.classList.add("hidden");
      if (colStatusEl) colStatusEl.textContent = `Uploaded ${completed} item(s) to Cloudinary and saved to Firebase.`;
    } else if (colStatusEl) {
      colStatusEl.textContent = `${completed} of ${total} item(s) saved.`;
    }
  };
}

onSnapshot(query(collection(db, "mediaItems"), orderBy("createdAt", "desc")), (snap) => {
  dynamicMediaItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  refreshAllViews();
});

// ------------------------------------------
// C. ABOUT PAGE IN-PLACE EDITOR & BANNER (about.html)
// ------------------------------------------
const aboutBannerImg = document.getElementById("about-banner-img");
const aboutP1El = document.getElementById("about-paragraph-1");
const aboutP2El = document.getElementById("about-paragraph-2");
const aboutExistingSelect = document.getElementById("about-existing-media-select");
const aboutPhotoInput = document.getElementById("about-photo-input");
const aboutUploadRemoteBtn = document.getElementById("about-upload-remote-btn");
const aboutClearPhotoBtn = document.getElementById("about-clear-photo-btn");
const aboutRemotePicker = document.getElementById("about-remote-picker");
const aboutP1Input = document.getElementById("about-p1-input");
const aboutP2Input = document.getElementById("about-p2-input");
const aboutSaveBtn = document.getElementById("about-save-btn");
const aboutSaveStatus = document.getElementById("about-save-status");

let latestAboutDoc = {};

function renderAboutBannerFromState() {
  if (!aboutBannerImg) return;
  const slotMedia = mediaBySlot.get("about-banner");
  const bannerUrl =
    (slotMedia && getItemUrl(slotMedia)) ||
    String(latestAboutDoc.bannerUrl || latestAboutDoc.mediaPath || "").trim();

  if (!bannerUrl) {
    aboutBannerImg.classList.add("hidden");
    aboutBannerImg.removeAttribute("src");
  } else {
    aboutBannerImg.src = bannerUrl;
    aboutBannerImg.classList.remove("hidden");
  }
}

function syncAboutEditorInputs() {
  const currentBanner =
    (aboutBannerImg && aboutBannerImg.getAttribute("src")) ||
    String(latestAboutDoc.bannerUrl || latestAboutDoc.mediaPath || "").trim();

  if (aboutPhotoInput) aboutPhotoInput.value = currentBanner;
  if (aboutExistingSelect) {
    const matchedOpt = Array.from(aboutExistingSelect.options).find((o) => o.value === currentBanner);
    aboutExistingSelect.value = matchedOpt ? matchedOpt.value : "";
  }
  if (aboutP1Input && aboutP1El) aboutP1Input.value = aboutP1El.textContent.trim();
  if (aboutP2Input && aboutP2El) aboutP2Input.value = aboutP2El.textContent.trim();
}

onSnapshot(doc(db, "settings", "aboutBanner"), (snap) => {
  latestAboutDoc = snap.exists() ? snap.data() : {};
  if (aboutP1El && latestAboutDoc.paragraph1) aboutP1El.textContent = latestAboutDoc.paragraph1;
  if (aboutP2El && latestAboutDoc.paragraph2) aboutP2El.textContent = latestAboutDoc.paragraph2;

  renderAboutBannerFromState();
  syncAboutEditorInputs();
});

if (aboutExistingSelect) {
  aboutExistingSelect.onchange = () => {
    const url = aboutExistingSelect.value.trim();
    if (!url) return;
    if (aboutPhotoInput) aboutPhotoInput.value = url;
    if (aboutBannerImg) {
      aboutBannerImg.src = url;
      aboutBannerImg.classList.remove("hidden");
    }
    if (aboutSaveStatus) {
      aboutSaveStatus.textContent = "Selected existing banner image. Click Save Changes to apply.";
    }
  };
}

if (aboutClearPhotoBtn && aboutPhotoInput && aboutBannerImg) {
  aboutClearPhotoBtn.onclick = () => {
    aboutPhotoInput.value = "";
    if (aboutExistingSelect) aboutExistingSelect.value = "";
    aboutBannerImg.classList.add("hidden");
    aboutBannerImg.removeAttribute("src");
    if (aboutSaveStatus) aboutSaveStatus.textContent = "Banner photo cleared. Click Save Changes to apply.";
  };
}

if (aboutUploadRemoteBtn && aboutRemotePicker) {
  aboutUploadRemoteBtn.onclick = () => aboutRemotePicker.click();
  aboutRemotePicker.onchange = async () => {
    const file = aboutRemotePicker.files && aboutRemotePicker.files[0];
    if (!file || !isAdminSignedIn) return;
    if (aboutSaveStatus) aboutSaveStatus.textContent = "Uploading banner to Cloudinary...";
    try {
      const uploaded = await uploadFileToCloudinary(file, "about", (pct) => {
        if (aboutSaveStatus) aboutSaveStatus.textContent = `Uploading banner to Cloudinary (${pct}%)...`;
      });
      if (aboutPhotoInput) aboutPhotoInput.value = uploaded.secureUrl;
      if (aboutBannerImg) {
        aboutBannerImg.src = uploaded.secureUrl;
        aboutBannerImg.classList.remove("hidden");
      }
      if (aboutSaveStatus) aboutSaveStatus.textContent = "Uploaded to Cloudinary. Click Save Changes to apply.";
    } catch (err) {
      if (aboutSaveStatus) aboutSaveStatus.textContent = `Upload failed: ${err.message}`;
    } finally {
      aboutRemotePicker.value = "";
    }
  };
}

async function saveAboutChanges() {
  if (!isAdminSignedIn) return;
  if (aboutSaveStatus) aboutSaveStatus.textContent = "Saving...";
  const finalBannerUrl = aboutPhotoInput ? aboutPhotoInput.value.trim() : "";
  const finalP1 = aboutP1Input ? aboutP1Input.value.trim() : "";
  const finalP2 = aboutP2Input ? aboutP2Input.value.trim() : "";

  try {
    await setDoc(doc(db, "settings", "aboutBanner"), {
      bannerUrl: finalBannerUrl,
      mediaPath: finalBannerUrl,
      paragraph1: finalP1,
      paragraph2: finalP2,
      updatedAt: serverTimestamp()
    }, { merge: true });

    if (aboutP1El && finalP1) aboutP1El.textContent = finalP1;
    if (aboutP2El && finalP2) aboutP2El.textContent = finalP2;
    renderAboutBannerFromState();

    if (aboutSaveStatus) aboutSaveStatus.textContent = "Saved.";
  } catch (err) {
    if (aboutSaveStatus) aboutSaveStatus.textContent = `Save failed: ${err.message}`;
  }
}

if (aboutSaveBtn) {
  aboutSaveBtn.onclick = saveAboutChanges;
}

// ------------------------------------------
// D. JOURNAL / DIARY INLINE CRUD (journal.html)
// ------------------------------------------
const journalFeed = document.getElementById("journal-feed");
const addJournalEntryBtn = document.getElementById("add-journal-entry-btn");
const journalEditorPanel = document.getElementById("journal-editor-panel");
const journalEditorHeading = document.getElementById("journal-editor-heading");
const journalDocIdInput = document.getElementById("journal-doc-id");
const journalTitleInput = document.getElementById("journal-title-input");
const journalDateInput = document.getElementById("journal-date-input");
const journalExistingSelect = document.getElementById("journal-existing-media-select");
const journalPathInput = document.getElementById("journal-path-input");
const journalUploadRemoteBtn = document.getElementById("journal-upload-remote-btn");
const journalRemotePicker = document.getElementById("journal-remote-picker");
const journalAltInput = document.getElementById("journal-alt-input");
const journalLocationInput = document.getElementById("journal-location-input");
const journalPeopleInput = document.getElementById("journal-people-input");
const journalTagsInput = document.getElementById("journal-tags-input");
const journalCameraInput = document.getElementById("journal-camera-input");
const journalResolutionInput = document.getElementById("journal-resolution-input");
const journalDescInput = document.getElementById("journal-desc-input");
const cancelJournalEditBtn = document.getElementById("cancel-journal-edit-btn");
const journalSaveStatus = document.getElementById("journal-save-status");

let attachedMediaId = null;

function resetJournalEditor() {
  if (!journalEditorPanel) return;
  journalEditorPanel.reset();
  attachedMediaId = null;
  if (journalExistingSelect) journalExistingSelect.value = "";
  if (journalDocIdInput) journalDocIdInput.value = "";
  if (journalDateInput) journalDateInput.valueAsDate = new Date();
  if (journalEditorHeading) journalEditorHeading.textContent = "New Diary Entry";
  if (journalSaveStatus) journalSaveStatus.textContent = "";
}

openJournalEditForm = (entry) => {
  if (!journalEditorPanel) return;
  attachedMediaId = entry.mediaId || null;
  const entryUrl = getItemUrl(entry);
  if (journalDocIdInput) journalDocIdInput.value = entry.id || "";
  if (journalTitleInput) journalTitleInput.value = entry.title || entry.displayTitle || "";
  if (journalDateInput) journalDateInput.value = entry.date || "";
  if (journalPathInput) journalPathInput.value = entryUrl;
  if (journalExistingSelect) {
    const matchedOpt = Array.from(journalExistingSelect.options).find(
      (o) => (o.dataset && o.dataset.url) === entryUrl
    );
    journalExistingSelect.value = matchedOpt ? matchedOpt.value : "";
  }
  if (journalAltInput) journalAltInput.value = entry.altText || "";
  if (journalLocationInput) journalLocationInput.value = entry.location || "";
  if (journalPeopleInput) {
    journalPeopleInput.value = Array.isArray(entry.people) ? entry.people.join(", ") : (entry.people || "");
  }
  if (journalTagsInput) {
    journalTagsInput.value = Array.isArray(entry.tags) ? entry.tags.join(", ") : (entry.tags || "");
  }
  if (journalCameraInput) journalCameraInput.value = entry.camera || "";
  if (journalResolutionInput) journalResolutionInput.value = entry.resolution || "";
  if (journalDescInput) journalDescInput.value = entry.body || entry.description || "";
  if (journalEditorHeading) journalEditorHeading.textContent = "Edit Diary Entry";

  journalEditorPanel.classList.remove("hidden");
  journalEditorPanel.scrollIntoView({ behavior: "smooth" });
};

if (journalExistingSelect) {
  journalExistingSelect.onchange = () => {
    const selectedOpt = journalExistingSelect.options[journalExistingSelect.selectedIndex];
    const url = (selectedOpt && selectedOpt.dataset.url) || "";
    if (!url) return;
    if (journalPathInput) journalPathInput.value = url;
    const matched = dynamicMediaItems.find((m) => getItemUrl(m) === url);
    attachedMediaId = matched ? matched.id : null;
    if (journalSaveStatus) {
      journalSaveStatus.textContent = "Selected existing Cloudinary media. Click Save Entry to apply.";
    }
  };
}

if (addJournalEntryBtn && journalEditorPanel) {
  addJournalEntryBtn.onclick = () => {
    resetJournalEditor();
    journalEditorPanel.classList.toggle("hidden");
  };
}
if (cancelJournalEditBtn && journalEditorPanel) {
  cancelJournalEditBtn.onclick = () => {
    resetJournalEditor();
    journalEditorPanel.classList.add("hidden");
  };
}
if (journalUploadRemoteBtn && journalRemotePicker) {
  journalUploadRemoteBtn.onclick = () => journalRemotePicker.click();
  journalRemotePicker.onchange = async () => {
    const file = journalRemotePicker.files && journalRemotePicker.files[0];
    if (!file || !isAdminSignedIn) return;
    detectFileDimensions(file, journalResolutionInput);
    if (journalSaveStatus) journalSaveStatus.textContent = "Uploading media to Cloudinary...";

    try {
      const uploaded = await uploadFileToCloudinary(file, "journal", (pct) => {
        if (journalSaveStatus) journalSaveStatus.textContent = `Uploading to Cloudinary (${pct}%)...`;
      });
      if (journalPathInput) journalPathInput.value = uploaded.secureUrl;

      const mediaDoc = await addDoc(collection(db, "mediaItems"), {
        title: (journalTitleInput && journalTitleInput.value.trim()) || uploaded.originalName,
        collection: uploaded.collection,
        folder: uploaded.folder,
        resourceType: uploaded.resourceType,
        secureUrl: uploaded.secureUrl,
        posterUrl: uploaded.posterUrl || "",
        publicId: uploaded.publicId || "",
        altText: (journalAltInput && journalAltInput.value.trim()) || uploaded.originalName,
        favorite: false,
        slot: null,
        journalId: journalDocIdInput ? journalDocIdInput.value || null : null,
        createdAt: Date.now()
      });
      attachedMediaId = mediaDoc.id;

      if (journalSaveStatus) {
        journalSaveStatus.textContent = "Uploaded to Cloudinary. Click Save Entry to publish.";
      }
    } catch (err) {
      if (journalSaveStatus) journalSaveStatus.textContent = `Upload failed: ${err.message}`;
    } finally {
      journalRemotePicker.value = "";
    }
  };
}

if (journalEditorPanel) {
  journalEditorPanel.onsubmit = async (e) => {
    e.preventDefault();
    if (!isAdminSignedIn) return;
    if (journalSaveStatus) journalSaveStatus.textContent = "Saving...";

    const cleanUrl = journalPathInput ? journalPathInput.value.trim() : "";
    const cleanTitle = journalTitleInput ? journalTitleInput.value.trim() : "";
    const peopleList = journalPeopleInput
      ? journalPeopleInput.value.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const tagList = journalTagsInput
      ? journalTagsInput.value.split(",").map((s) => s.replace(/\s+/g, "").replace(/^#+/, "")).filter(Boolean)
      : [];

    const payload = {
      date: journalDateInput ? journalDateInput.value : "",
      mediaUrl: cleanUrl,
      secureUrl: cleanUrl,
      mediaId: attachedMediaId || null,
      title: cleanTitle,
      displayTitle: cleanTitle,
      altText: journalAltInput ? journalAltInput.value.trim() : "",
      location: journalLocationInput ? journalLocationInput.value.trim() : "",
      people: peopleList,
      tags: tagList,
      camera: journalCameraInput ? journalCameraInput.value.trim() : "",
      resolution: journalResolutionInput ? journalResolutionInput.value.trim() : "",
      body: journalDescInput ? journalDescInput.value.trim() : "",
      description: journalDescInput ? journalDescInput.value.trim() : "",
      updatedAt: serverTimestamp()
    };

    try {
      const existingId = journalDocIdInput ? journalDocIdInput.value : "";
      if (existingId) {
        await updateDoc(doc(db, "entries", existingId), payload);
      } else {
        payload.createdAt = serverTimestamp();
        await addDoc(collection(db, "entries"), payload);
      }
      resetJournalEditor();
      journalEditorPanel.classList.add("hidden");
    } catch (err) {
      if (journalSaveStatus) journalSaveStatus.textContent = `Save failed: ${err.message}`;
    }
  };
}

function appendCardMeta(container, label, value) {
  if (!value) return;
  const line = document.createElement("div");
  line.className = "journal-meta-item";

  const strong = document.createElement("strong");
  strong.textContent = `${label}: `;

  const span = document.createElement("span");
  span.textContent = String(value);

  line.appendChild(strong);
  line.appendChild(span);
  container.appendChild(line);
}

function renderJournal() {
  if (!journalFeed) return;
  journalFeed.innerHTML = "";
  if (liveEntries.length === 0) {
    const emptyMsg = document.createElement("p");
    emptyMsg.className = "journal-status";
    emptyMsg.textContent = "Once posted, journal entries will populate this page.";
    journalFeed.appendChild(emptyMsg);
    return;
  }

  liveEntries.forEach((entry) => {
    const linkedMedia = resolveMediaReference(entry.mediaId || entry.slot, getItemUrl(entry));
    const mediaUrl = getItemUrl(linkedMedia) || getItemUrl(entry);
    const titleText = entry.title || entry.displayTitle || (linkedMedia && getItemTitle(linkedMedia)) || "Untitled Memory";
    const fallbackCaption = entry.altText || (linkedMedia && getItemAlt(linkedMedia)) || titleText;
    const formattedPeople = formatPeopleList(entry.people);
    const formattedTags = formatHashtags(entry.tags);

    const article = document.createElement("article");
    article.className = "journal-entry";
    article.onclick = () => openEntryDetail(entry);

    const mediaBox = document.createElement("div");
    mediaBox.className = "journal-media";

    if (mediaUrl && isVideoMedia(mediaUrl)) {
      const vid = document.createElement("video");
      vid.src = mediaUrl;
      vid.controls = true;
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = "none";
      const poster = getVideoPosterUrl(linkedMedia || { secureUrl: mediaUrl, posterUrl: entry.posterUrl });
      if (poster) vid.poster = poster;
      vid.onerror = () => renderMediaFallback(mediaBox, fallbackCaption);
      mediaBox.appendChild(vid);
    } else if (mediaUrl) {
      const img = document.createElement("img");
      img.src = mediaUrl;
      img.alt = fallbackCaption;
      img.loading = "lazy";
      img.onerror = () => renderMediaFallback(mediaBox, fallbackCaption);
      mediaBox.appendChild(img);
    } else {
      renderMediaFallback(mediaBox, fallbackCaption);
    }

    article.appendChild(mediaBox);

    const textBox = document.createElement("div");
    textBox.className = "journal-text";

    const titleH3 = document.createElement("h3");
    titleH3.textContent = titleText;

    const dateSpan = document.createElement("span");
    dateSpan.className = "journal-date";
    dateSpan.textContent = entry.date || "";

    const descP = document.createElement("p");
    descP.textContent = entry.body || entry.description || entry.altText || "";

    const metaBox = document.createElement("div");
    metaBox.className = "journal-meta-list";
    appendCardMeta(metaBox, "Location", entry.location);
    appendCardMeta(metaBox, "People", formattedPeople);
    appendCardMeta(metaBox, "Tags", formattedTags);
    appendCardMeta(metaBox, "Camera / Device", entry.camera);
    appendCardMeta(metaBox, "Resolution", entry.resolution);

    textBox.appendChild(titleH3);
    if (entry.date) textBox.appendChild(dateSpan);
    if (entry.body || entry.description || entry.altText) textBox.appendChild(descP);
    if (metaBox.childNodes.length) textBox.appendChild(metaBox);

    if (isAdminSignedIn && entry.id) {
      const adminActions = document.createElement("div");
      adminActions.className = "journal-admin-actions";

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn";
      editBtn.textContent = "Edit";
      editBtn.onclick = (e) => {
        e.stopPropagation();
        openJournalEditForm(entry);
      };

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-danger-inline";
      deleteBtn.textContent = "Delete";
      deleteBtn.onclick = async (e) => {
        e.stopPropagation();
        await deleteJournalEntryById(entry.id, titleText);
      };

      adminActions.appendChild(editBtn);
      adminActions.appendChild(deleteBtn);
      textBox.appendChild(adminActions);
    }

    article.appendChild(textBox);
    journalFeed.appendChild(article);
  });
}

const entriesQuery = query(collection(db, "entries"), orderBy("date", "desc"));
onSnapshot(entriesQuery, (snapshot) => {
  liveEntries = snapshot.docs.map((d) => ({
    id: d.id,
    ...d.data()
  }));
  refreshAllViews();
}, (err) => {
  console.error("Firestore read error:", err);
  if (journalFeed) {
    journalFeed.innerHTML =
      '<p class="journal-status">Could not load entries (' + err.code + '). Check Firestore Rules.</p>';
  }
});