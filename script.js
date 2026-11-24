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
  isVideoMedia,
  getVideoPosterUrl,
  uploadFileToCloudinary
} from "./cloudinary.js";

// ==========================================
// 0. SHARED NAVBAR LOADER (nav.html)
// ==========================================
function syncNavbarAdminVisibility() {
  const navLibItem = document.getElementById("nav-media-library-item");
  if (navLibItem) {
    navLibItem.classList.toggle("hidden", !isAdminSignedIn);
  }
}

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

    syncNavbarAdminVisibility();
  } catch (err) {
    console.warn("Navbar fetch skipped/failed:", err.message);
  }
}

// ==========================================
// 1. MEDIA & METADATA HELPERS (CLOUDINARY + FIRESTORE)
// ==========================================
const VALID_OBJECT_POSITIONS = ["center", "top", "bottom", "left", "right"];

let dynamicMediaItems = [];
let liveEntries = [];
let mediaById = new Map();
let mediaBySlot = new Map();
let isAdminSignedIn = false;

let deleteJournalEntryById = async () => {};
let deleteMediaItemById = async () => {};

let attachedMediaId = null;
let selectedJournalMediaUrl = "";

let trackEvent = () => {};
try {
  const analytics = getAnalytics(app);
  trackEvent = (name, params) => logEvent(analytics, name, params);
} catch (e) {}

loadSharedNavbar();

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeObjectPosition(pos) {
  const clean = String(pos || "center").trim().toLowerCase();
  return VALID_OBJECT_POSITIONS.includes(clean) ? clean : "center";
}

function getItemPosition(item) {
  if (!item) return "center";
  return normalizeObjectPosition(item.objectPosition || item.cardPosition || item.position);
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

function isSamplePlaceholderItem(item) {
  const label = `${getItemTitle(item)} ${getItemAlt(item)}`.toLowerCase();
  return label.includes("sample animal photo");
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

// All valid items (including hidden/seasonal) for Media Library & pickers
function getAllValidMediaItems(includeHidden = false) {
  return dynamicMediaItems.filter((item) => {
    if (!/^https?:\/\//i.test(getItemUrl(item))) return false;
    if (isSamplePlaceholderItem(item)) return false;
    if (!includeHidden && item.hidden === true) return false;
    return true;
  });
}

function getCollectionsMap(includeHidden = false) {
  const grouped = {};
  getAllValidMediaItems(includeHidden).forEach((item) => {
    const col = getItemCollection(item);
    if (!grouped[col]) grouped[col] = [];
    grouped[col].push(item);
  });
  return grouped;
}

function getAvailableCollectionOptions(extraNames = []) {
  const names = new Set(["general"]);
  Object.keys(getCollectionsMap(true)).forEach((name) => {
    const clean = sanitizeCollectionName(name);
    if (clean) names.add(clean);
  });
  extraNames.forEach((name) => {
    const clean = sanitizeCollectionName(name);
    if (clean) names.add(clean);
  });
  return Array.from(names).sort((a, b) => a.localeCompare(b));
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

function renderMediaFallback(container, fallbackText, defaultLabel = "No media available") {
  if (!container) return;
  const caption = (fallbackText || "").trim() || defaultLabel;
  container.innerHTML = `<span class="journal-media-placeholder">${escapeHtml(caption)}</span>`;
}

function updateJournalPickerSelectionUI() {
  const pickerGrid = document.getElementById("journal-media-picker-grid");
  const clearBtn = document.getElementById("clear-journal-media-btn");
  const selectionLabel = document.getElementById("journal-selected-media-label");
  const hasSelection = Boolean(attachedMediaId || selectedJournalMediaUrl);

  if (clearBtn) {
    clearBtn.classList.toggle("hidden", !hasSelection);
  }

  if (selectionLabel) {
    if (hasSelection) {
      const matched = resolveMediaReference(attachedMediaId, selectedJournalMediaUrl);
      const labelText = matched ? `${getItemTitle(matched)} (${getItemCollection(matched)})` : selectedJournalMediaUrl;
      selectionLabel.textContent = `Selected: ${labelText}`;
    } else {
      selectionLabel.textContent = "No media selected.";
    }
  }

  if (!pickerGrid) return;
  pickerGrid.querySelectorAll(".media-picker-thumb").forEach((btn) => {
    const isMatch =
      (attachedMediaId && btn.dataset.mediaId === attachedMediaId) ||
      (selectedJournalMediaUrl && btn.dataset.url === selectedJournalMediaUrl);
    btn.classList.toggle("selected", Boolean(isMatch));
    btn.setAttribute("aria-selected", String(Boolean(isMatch)));

    const checkEl = btn.querySelector(".media-picker-check");
    if (checkEl) checkEl.classList.toggle("hidden", !isMatch);
  });
}

function populateExistingMediaSelects() {
  const validItems = getAllValidMediaItems(true);

  const pickerGrid = document.getElementById("journal-media-picker-grid");
  if (pickerGrid) {
    pickerGrid.innerHTML = "";
    if (validItems.length === 0) {
      const emptyEl = document.createElement("p");
      emptyEl.className = "media-picker-empty";
      emptyEl.textContent = "No Cloudinary media available yet. Upload media in Media Library first.";
      pickerGrid.appendChild(emptyEl);
    } else {
      validItems.forEach((item) => {
        const url = getItemUrl(item);
        const isVideo = getItemResourceType(item) === "video";
        const thumbSrc = isVideo ? getVideoPosterUrl(item) : url;
        const label = `${getItemTitle(item)} (${getItemCollection(item)})`;

        const thumbBtn = document.createElement("button");
        thumbBtn.type = "button";
        thumbBtn.className = "media-picker-thumb";
        thumbBtn.dataset.mediaId = item.id || "";
        thumbBtn.dataset.url = url;
        thumbBtn.title = label;
        thumbBtn.setAttribute("role", "option");

        const img = document.createElement("img");
        img.src = thumbSrc || url;
        img.alt = getItemAlt(item);
        img.loading = "lazy";
        img.style.objectPosition = getItemPosition(item);
        thumbBtn.appendChild(img);

        if (isVideo) {
          const badge = document.createElement("span");
          badge.className = "media-picker-badge";
          badge.textContent = "▶ VIDEO";
          thumbBtn.appendChild(badge);
        }

        const check = document.createElement("span");
        check.className = "media-picker-check hidden";
        check.textContent = "✓";
        thumbBtn.appendChild(check);

        thumbBtn.onclick = () => {
          attachedMediaId = item.id || null;
          selectedJournalMediaUrl = url;
          updateJournalPickerSelectionUI();
          const statusEl = document.getElementById("journal-save-status");
          if (statusEl) {
            statusEl.textContent = `Selected "${getItemTitle(item)}". Click Save Entry to apply.`;
          }
        };

        pickerGrid.appendChild(thumbBtn);
      });
      updateJournalPickerSelectionUI();
    }
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
  const altText = getItemAlt(itemObj);
  const isVideo = getItemResourceType(itemObj) === "video";
  const pos = getItemPosition(itemObj);
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
    video.style.objectPosition = pos;
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
    img.style.objectPosition = pos;
    img.onerror = handleBrokenMedia;
    card.appendChild(img);
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

  const allValid = getAllValidMediaItems(false);
  const sorted = [...allValid].sort((a, b) => getItemTimestamp(b) - getItemTimestamp(a));
  const favorites = sorted.filter((item) => item.favorite === true);
  const highlightList = (favorites.length > 0 ? favorites : sorted).slice(0, 8);

  highlightList.forEach((item, idx) => {
    homeHighlights.appendChild(createMediaCard(item, highlightList, idx, { hideOnError: false }));
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

    const filteredList = getAllValidMediaItems(false).filter((item) => {
      const type = getItemResourceType(item);
      if (filter === "image") return type === "image";
      if (filter === "video") return type === "video";
      return true;
    });

    filteredList.forEach((item, idx) => {
      mediaGallery.appendChild(createMediaCard(item, filteredList, idx, { hideOnError: true }));
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

    const grouped = getCollectionsMap(false);
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
      img.style.objectPosition = getItemPosition(coverItem);
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

    const grouped = getCollectionsMap(false);
    const albumList = grouped[slug] || [];

    albumList.forEach((item, idx) => {
      collectionsGrid.appendChild(createMediaCard(item, albumList, idx));
    });
  }

  renderCollectionsView = () => {
    if (activeCollectionFolder) {
      const grouped = getCollectionsMap(false);
      if (!grouped[activeCollectionFolder]) {
        showAlbums();
      } else {
        openAlbum(activeCollectionFolder);
      }
    } else {
      showAlbums();
    }
  };

  showAlbums();
  if (backBtn) backBtn.onclick = showAlbums;
}

// ==========================================
// 7. ABOUT PAGE STATS (about.html)
// ==========================================
const archiveStats = document.getElementById("archive-stats");

function renderArchiveStats() {
  if (!archiveStats) return;
  const grouped = getCollectionsMap(false);
  const allItems = getAllValidMediaItems(false);
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
let renderMediaLibrary = () => {};

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
  renderMediaLibrary();
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
  syncNavbarAdminVisibility();

  [
    "home-admin-actions",
    "add-journal-entry-btn",
    "about-admin-controls"
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", !isAdminSignedIn);
  });

  const libraryWorkspace = document.getElementById("media-library-workspace");
  const libraryAuthNotice = document.getElementById("library-auth-notice");
  if (libraryWorkspace) libraryWorkspace.classList.toggle("hidden", !isAdminSignedIn);
  if (libraryAuthNotice) libraryAuthNotice.classList.toggle("hidden", isAdminSignedIn);

  if (!isAdminSignedIn && typeof setHomeInlineEditing === "function") {
    setHomeInlineEditing(false);
  }

  if (!isAdminSignedIn && typeof setAboutInlineEditing === "function") {
    setAboutInlineEditing(false);
  }

  refreshAllViews();
});

// ------------------------------------------
// A. HOME PAGE DIRECT ON-PAGE EDITOR + PREVIEW (index.html)
// ------------------------------------------
const homePageTitle = document.getElementById("home-page-title");
const homeHeroHeading = document.getElementById("home-hero-heading");
const homeHeroSubtext = document.getElementById("home-hero-subtext");
const toggleHomeEditBtn = document.getElementById("toggle-home-edit-btn");
const previewHomeInlineBtn = document.getElementById("preview-home-inline-btn");
const saveHomeInlineBtn = document.getElementById("save-home-inline-btn");
const cancelHomeInlineBtn = document.getElementById("cancel-home-inline-btn");
const homeSaveStatus = document.getElementById("home-save-status");

let homeSnapshotValues = {
  sectionTitle: "",
  heroHeading: "",
  heroSubtext: ""
};
let isHomeInlineEditing = false;
let isHomePreviewing = false;

function captureHomeSnapshot() {
  homeSnapshotValues = {
    sectionTitle: homePageTitle ? homePageTitle.textContent.trim() : "",
    heroHeading: homeHeroHeading ? homeHeroHeading.textContent.trim() : "",
    heroSubtext: homeHeroSubtext ? homeHeroSubtext.textContent.trim() : ""
  };
}

function setHomeInlineEditing(editing) {
  isHomeInlineEditing = Boolean(editing && isAdminSignedIn);
  isHomePreviewing = false;
  const editableEls = [homePageTitle, homeHeroHeading, homeHeroSubtext].filter(Boolean);

  editableEls.forEach((el) => {
    el.contentEditable = isHomeInlineEditing ? "true" : "false";
    el.classList.toggle("inline-editable-active", isHomeInlineEditing);
  });

  if (toggleHomeEditBtn) toggleHomeEditBtn.classList.toggle("hidden", isHomeInlineEditing);
  if (previewHomeInlineBtn) {
    previewHomeInlineBtn.classList.toggle("hidden", !isHomeInlineEditing);
    previewHomeInlineBtn.textContent = "Preview";
  }
  if (saveHomeInlineBtn) saveHomeInlineBtn.classList.toggle("hidden", !isHomeInlineEditing);
  if (cancelHomeInlineBtn) cancelHomeInlineBtn.classList.toggle("hidden", !isHomeInlineEditing);

  if (isHomeInlineEditing) {
    captureHomeSnapshot();
    if (homeSaveStatus) {
      homeSaveStatus.textContent = "Editing enabled. Click any text to edit, Preview to check layout, or Save Changes.";
    }
    if (homeHeroHeading) homeHeroHeading.focus();
  } else if (homeSaveStatus && homeSaveStatus.textContent.startsWith("Editing")) {
    homeSaveStatus.textContent = "";
  }
}

onSnapshot(doc(db, "settings", "homePage"), (snap) => {
  const data = snap.exists() ? snap.data() : {};
  if (homePageTitle && data.sectionTitle) homePageTitle.textContent = data.sectionTitle;
  if (homeHeroHeading && data.heroHeading) homeHeroHeading.textContent = data.heroHeading;
  if (homeHeroSubtext && data.heroSubtext) homeHeroSubtext.textContent = data.heroSubtext;
  captureHomeSnapshot();
});

if (toggleHomeEditBtn) {
  toggleHomeEditBtn.onclick = () => {
    if (!isAdminSignedIn) return;
    setHomeInlineEditing(true);
  };
}

if (previewHomeInlineBtn) {
  previewHomeInlineBtn.onclick = () => {
    if (!isHomeInlineEditing) return;
    isHomePreviewing = !isHomePreviewing;
    const editableEls = [homePageTitle, homeHeroHeading, homeHeroSubtext].filter(Boolean);
    editableEls.forEach((el) => {
      el.contentEditable = isHomePreviewing ? "false" : "true";
      el.classList.toggle("inline-editable-active", !isHomePreviewing);
    });
    previewHomeInlineBtn.textContent = isHomePreviewing ? "Resume Editing" : "Preview";
    if (homeSaveStatus) {
      homeSaveStatus.textContent = isHomePreviewing
        ? "Previewing visitor view (unsaved). Click Save Changes to publish or Resume Editing."
        : "Editing enabled. Click any text to edit, then click Save Changes.";
    }
  };
}

if (cancelHomeInlineBtn) {
  cancelHomeInlineBtn.onclick = () => {
    if (homePageTitle) homePageTitle.textContent = homeSnapshotValues.sectionTitle;
    if (homeHeroHeading) homeHeroHeading.textContent = homeSnapshotValues.heroHeading;
    if (homeHeroSubtext) homeHeroSubtext.textContent = homeSnapshotValues.heroSubtext;
    setHomeInlineEditing(false);
    if (homeSaveStatus) homeSaveStatus.textContent = "";
  };
}

if (saveHomeInlineBtn) {
  saveHomeInlineBtn.onclick = async () => {
    if (!isAdminSignedIn) return;
    if (homeSaveStatus) homeSaveStatus.textContent = "Saving...";

    const sectionTitle = homePageTitle ? homePageTitle.textContent.trim() : "";
    const heroHeading = homeHeroHeading ? homeHeroHeading.textContent.trim() : "";
    const heroSubtext = homeHeroSubtext ? homeHeroSubtext.textContent.trim() : "";

    try {
      await setDoc(doc(db, "settings", "homePage"), {
        sectionTitle,
        heroHeading,
        heroSubtext,
        updatedAt: serverTimestamp()
      }, { merge: true });
      captureHomeSnapshot();
      setHomeInlineEditing(false);
      if (homeSaveStatus) homeSaveStatus.textContent = "Saved.";
    } catch (err) {
      if (homeSaveStatus) homeSaveStatus.textContent = `Save failed: ${err.message}`;
    }
  };
}

// ------------------------------------------
// B. MEDIA LIBRARY WORKSPACE (media-library.html)
// ------------------------------------------
const toggleLibUploadBtn = document.getElementById("toggle-library-upload-btn");
const libUploadPanel = document.getElementById("library-upload-panel");
const cancelLibUploadPanelBtn = document.getElementById("cancel-library-upload-btn");
const libSubmitBtn = document.getElementById("lib-submit-btn");
const libCancelUploadBtn = document.getElementById("lib-cancel-upload-btn");
const libDropzone = document.getElementById("lib-dropzone");
const libFileUploadInput = document.getElementById("lib-file-upload");
const libStagingList = document.getElementById("lib-staging-list");
const libUploadStatus = document.getElementById("lib-upload-status");
const libTrackerEl = document.getElementById("lib-upload-tracker");
const libTrackerSummary = document.getElementById("lib-tracker-summary");
const libTrackerPercent = document.getElementById("lib-tracker-percent");
const libProgressBar = document.getElementById("lib-progress-bar");
const libTrackerCurrent = document.getElementById("lib-tracker-current");
const libTrackerList = document.getElementById("lib-tracker-list");

const toggleFolderManagerBtn = document.getElementById("toggle-folder-manager-btn");
const libFolderPanel = document.getElementById("library-folder-panel");
const closeFolderManagerBtn = document.getElementById("close-folder-manager-btn");
const libFoldersList = document.getElementById("library-folders-list");
const libFolderStatus = document.getElementById("library-folder-status");

const libItemEditor = document.getElementById("library-item-editor");
const libEditHeading = document.getElementById("lib-edit-heading");
const libEditId = document.getElementById("lib-edit-id");
const libEditPreviewBox = document.getElementById("lib-edit-preview-box");
const libEditTitle = document.getElementById("lib-edit-title");
const libEditAlt = document.getElementById("lib-edit-alt");
const libEditColSelect = document.getElementById("lib-edit-collection-select");
const libEditColNew = document.getElementById("lib-edit-collection-new");
const libEditPosition = document.getElementById("lib-edit-position");
const libEditFavorite = document.getElementById("lib-edit-favorite");
const libEditHidden = document.getElementById("lib-edit-hidden");
const libEditStatus = document.getElementById("lib-edit-status");
const libEditCancelBtn = document.getElementById("lib-edit-cancel-btn");

const libFilterCol = document.getElementById("lib-filter-collection");
const libFilterType = document.getElementById("lib-filter-type");
const libSearchInput = document.getElementById("lib-search-input");
const libCountSummary = document.getElementById("lib-count-summary");
const mediaLibraryGrid = document.getElementById("media-library-grid");

let stagedUploads = [];
let activeUploadXhr = null;
let uploadCancelled = false;
let editingLibraryItem = null;

function clearStagedUploads() {
  stagedUploads.forEach((entry) => {
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  });
  stagedUploads = [];
  if (libStagingList) {
    libStagingList.innerHTML = "";
    libStagingList.classList.add("hidden");
  }
}

function renderStagedUploads() {
  if (!libStagingList) return;
  libStagingList.innerHTML = "";

  if (stagedUploads.length === 0) {
    libStagingList.classList.add("hidden");
    return;
  }

  libStagingList.classList.remove("hidden");
  const stagedNames = stagedUploads.map((e) => e.collection).filter(Boolean);
  const availableCols = getAvailableCollectionOptions(stagedNames);

  stagedUploads.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "staging-card";

    const topRow = document.createElement("div");
    topRow.className = "staging-card-top";

    const nameSpan = document.createElement("span");
    nameSpan.className = "staging-filename";
    nameSpan.textContent = entry.file.name;
    nameSpan.title = entry.file.name;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "staging-remove-btn";
    removeBtn.textContent = "Remove";
    removeBtn.onclick = () => {
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      stagedUploads = stagedUploads.filter((item) => item.id !== entry.id);
      renderStagedUploads();
      if (libUploadStatus) {
        libUploadStatus.textContent = stagedUploads.length
          ? `${stagedUploads.length} file(s) staged.`
          : "";
      }
    };

    topRow.appendChild(nameSpan);
    topRow.appendChild(removeBtn);
    card.appendChild(topRow);

    if (entry.isVideo) {
      const vid = document.createElement("video");
      vid.className = "staging-preview";
      vid.src = entry.previewUrl;
      vid.muted = true;
      vid.playsInline = true;
      vid.controls = true;
      vid.style.objectPosition = entry.objectPosition;
      card.appendChild(vid);
    } else {
      const img = document.createElement("img");
      img.className = "staging-preview";
      img.src = entry.previewUrl;
      img.alt = entry.altText || entry.title;
      img.style.objectPosition = entry.objectPosition;
      card.appendChild(img);
    }

    const titleLbl = document.createElement("label");
    titleLbl.className = "staging-field-label";
    titleLbl.textContent = "Creative Display Title";
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "editor-input";
    titleInput.value = entry.title;
    titleInput.oninput = (e) => {
      entry.title = e.target.value;
    };

    const altLbl = document.createElement("label");
    altLbl.className = "staging-field-label";
    altLbl.textContent = "Alt Text / Fallback Caption";
    const altInput = document.createElement("input");
    altInput.type = "text";
    altInput.className = "editor-input";
    altInput.value = entry.altText;
    altInput.placeholder = "Describe the image or video";
    altInput.oninput = (e) => {
      entry.altText = e.target.value;
    };

    const colLbl = document.createElement("label");
    colLbl.className = "staging-field-label";
    colLbl.textContent = "Collection";

    const colSelect = document.createElement("select");
    colSelect.className = "editor-input";

    const addNewOpt = document.createElement("option");
    addNewOpt.value = "__new__";
    addNewOpt.textContent = "+ Add New Collection...";
    colSelect.appendChild(addNewOpt);

    availableCols.forEach((colName) => {
      const opt = document.createElement("option");
      opt.value = colName;
      opt.textContent = colName;
      colSelect.appendChild(opt);
    });

    const newColInput = document.createElement("input");
    newColInput.type = "text";
    newColInput.className = "editor-input staging-new-col-input";
    newColInput.placeholder = "Enter new collection name (e.g., trips, family)";

    const isCustomNew = entry.isNewCollection || !availableCols.includes(entry.collection);
    if (isCustomNew) {
      colSelect.value = "__new__";
      newColInput.classList.remove("hidden");
      newColInput.value = entry.collection || "";
    } else {
      colSelect.value = entry.collection;
      newColInput.classList.add("hidden");
      newColInput.value = "";
    }

    colSelect.onchange = (e) => {
      if (e.target.value === "__new__") {
        entry.isNewCollection = true;
        newColInput.classList.remove("hidden");
        newColInput.focus();
      } else {
        entry.isNewCollection = false;
        entry.collection = e.target.value;
        newColInput.classList.add("hidden");
        newColInput.value = "";
      }
    };

    newColInput.oninput = (e) => {
      entry.isNewCollection = true;
      entry.collection = e.target.value;
    };

    const posLbl = document.createElement("label");
    posLbl.className = "staging-field-label";
    posLbl.textContent = "Card Position";
    const posSelect = document.createElement("select");
    posSelect.className = "editor-input";
    [
      ["center", "Center (Default)"],
      ["top", "Top"],
      ["bottom", "Bottom"],
      ["left", "Left"],
      ["right", "Right"]
    ].forEach(([val, label]) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      if (entry.objectPosition === val) opt.selected = true;
      posSelect.appendChild(opt);
    });
    posSelect.onchange = (e) => {
      entry.objectPosition = normalizeObjectPosition(e.target.value);
      const previewEl = card.querySelector("img.staging-preview, video.staging-preview");
      if (previewEl) previewEl.style.objectPosition = entry.objectPosition;
    };

    card.appendChild(titleLbl);
    card.appendChild(titleInput);
    card.appendChild(altLbl);
    card.appendChild(altInput);
    card.appendChild(colLbl);
    card.appendChild(colSelect);
    card.appendChild(newColInput);
    card.appendChild(posLbl);
    card.appendChild(posSelect);

    libStagingList.appendChild(card);
  });
}

function stageFiles(fileList) {
  const hasExistingCols = Object.keys(getCollectionsMap(true)).length > 0;
  const selectedFilterCol = libFilterCol && libFilterCol.value !== "__all__" ? libFilterCol.value : "";
  const defaultCol = selectedFilterCol || (hasExistingCols ? "general" : "");

  const files = Array.from(fileList || []).filter(
    (f) => f.type.startsWith("image/") || f.type.startsWith("video/")
  );

  files.forEach((file) => {
    const cleanTitle = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Untitled";
    const isVideo = file.type.startsWith("video/");
    stagedUploads.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      isVideo,
      previewUrl: URL.createObjectURL(file),
      title: cleanTitle,
      altText: "",
      collection: defaultCol,
      isNewCollection: !defaultCol,
      objectPosition: "center"
    });
  });

  renderStagedUploads();
  if (libUploadStatus && stagedUploads.length > 0) {
    libUploadStatus.textContent = `${stagedUploads.length} file(s) staged. Review details below, then click Upload & Save.`;
  }
}

function updateLibraryPreviewCard() {
  if (!libEditPreviewBox || !editingLibraryItem) return;
  libEditPreviewBox.innerHTML = "";
  const url = getItemUrl(editingLibraryItem);
  const pos = libEditPosition ? normalizeObjectPosition(libEditPosition.value) : getItemPosition(editingLibraryItem);
  const isVideo = getItemResourceType(editingLibraryItem) === "video";

  if (isVideo) {
    const vid = document.createElement("video");
    vid.src = url;
    vid.muted = true;
    vid.playsInline = true;
    vid.controls = true;
    vid.style.objectPosition = pos;
    const poster = getVideoPosterUrl(editingLibraryItem);
    if (poster) vid.poster = poster;
    libEditPreviewBox.appendChild(vid);
  } else {
    const img = document.createElement("img");
    img.src = url;
    img.alt = (libEditAlt && libEditAlt.value.trim()) || getItemTitle(editingLibraryItem);
    img.style.objectPosition = pos;
    libEditPreviewBox.appendChild(img);
  }
}

function openLibraryItemEditor(item) {
  if (!libItemEditor || !item) return;
  editingLibraryItem = item;
  const currentCol = getItemCollection(item);
  const cols = getAvailableCollectionOptions([currentCol]);

  if (libEditId) libEditId.value = item.id || "";
  if (libEditHeading) libEditHeading.textContent = `Edit Media: ${getItemTitle(item)}`;
  if (libEditTitle) libEditTitle.value = getItemTitle(item);
  if (libEditAlt) libEditAlt.value = item.altText || "";
  if (libEditPosition) libEditPosition.value = getItemPosition(item);
  if (libEditFavorite) libEditFavorite.checked = item.favorite === true;
  if (libEditHidden) libEditHidden.checked = item.hidden === true;
  if (libEditStatus) libEditStatus.textContent = "";

  if (libEditColSelect) {
    libEditColSelect.innerHTML = "";
    const addNewOpt = document.createElement("option");
    addNewOpt.value = "__new__";
    addNewOpt.textContent = "+ Add New Collection...";
    libEditColSelect.appendChild(addNewOpt);

    cols.forEach((colName) => {
      const opt = document.createElement("option");
      opt.value = colName;
      opt.textContent = colName;
      libEditColSelect.appendChild(opt);
    });

    libEditColSelect.value = currentCol;
  }

  if (libEditColNew) {
    libEditColNew.value = "";
    libEditColNew.classList.add("hidden");
  }

  updateLibraryPreviewCard();
  libItemEditor.classList.remove("hidden");
  libItemEditor.scrollIntoView({ behavior: "smooth" });
}

function renderFolderManager() {
  if (!libFoldersList) return;
  libFoldersList.innerHTML = "";
  const grouped = getCollectionsMap(true);
  const folderNames = Object.keys(grouped).sort((a, b) => a.localeCompare(b));

  if (folderNames.length === 0) {
    libFoldersList.innerHTML = '<p class="media-picker-empty">No folders yet. Upload media to create collections.</p>';
    return;
  }

  folderNames.forEach((folderName) => {
    const items = grouped[folderName];
    const hiddenCount = items.filter((i) => i.hidden === true).length;
    const allHidden = hiddenCount === items.length;

    const row = document.createElement("div");
    row.className = "folder-manager-row";

    const info = document.createElement("div");
    info.className = "folder-manager-info";

    const title = document.createElement("strong");
    title.textContent = folderName;

    const countSpan = document.createElement("span");
    countSpan.className = "library-card-meta";
    countSpan.textContent = `${items.length} item(s)${hiddenCount > 0 ? ` • ${hiddenCount} hidden` : ""}`;

    info.appendChild(title);
    info.appendChild(countSpan);

    const actions = document.createElement("div");
    actions.className = "folder-manager-actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "btn btn-secondary";
    renameBtn.textContent = "Rename";
    renameBtn.onclick = async () => {
      if (!isAdminSignedIn) return;
      const entered = window.prompt(`Rename collection "${folderName}" to:`, folderName);
      if (!entered) return;
      const nextSlug = sanitizeCollectionName(entered);
      if (!nextSlug || nextSlug === folderName) return;

      if (libFolderStatus) libFolderStatus.textContent = `Moving ${items.length} item(s) to "${nextSlug}"...`;
      try {
        await Promise.all(
          items.map((item) =>
            updateDoc(doc(db, "mediaItems", item.id), {
              collection: nextSlug,
              updatedAt: serverTimestamp()
            })
          )
        );
        if (libFolderStatus) libFolderStatus.textContent = `Renamed "${folderName}" to "${nextSlug}".`;
      } catch (err) {
        if (libFolderStatus) libFolderStatus.textContent = `Rename failed: ${err.message}`;
      }
    };

    const toggleVisibilityBtn = document.createElement("button");
    toggleVisibilityBtn.type = "button";
    toggleVisibilityBtn.className = "btn";
    toggleVisibilityBtn.textContent = allHidden ? "Show in Public" : "Hide Seasonal";
    toggleVisibilityBtn.onclick = async () => {
      if (!isAdminSignedIn) return;
      const targetHidden = !allHidden;
      if (libFolderStatus) {
        libFolderStatus.textContent = `${targetHidden ? "Hiding" : "Showing"} "${folderName}"...`;
      }
      try {
        await Promise.all(
          items.map((item) =>
            updateDoc(doc(db, "mediaItems", item.id), {
              hidden: targetHidden,
              updatedAt: serverTimestamp()
            })
          )
        );
        if (libFolderStatus) {
          libFolderStatus.textContent = targetHidden
            ? `"${folderName}" is now hidden from public pages.`
            : `"${folderName}" is now visible on public pages.`;
        }
      } catch (err) {
        if (libFolderStatus) libFolderStatus.textContent = `Update failed: ${err.message}`;
      }
    };

    actions.appendChild(renameBtn);
    actions.appendChild(toggleVisibilityBtn);

    row.appendChild(info);
    row.appendChild(actions);
    libFoldersList.appendChild(row);
  });
}

renderMediaLibrary = () => {
  if (!mediaLibraryGrid) return;

  const allItems = getAllValidMediaItems(true);
  const cols = getAvailableCollectionOptions([]);

  if (libFilterCol) {
    const prevCol = libFilterCol.value || "__all__";
    libFilterCol.innerHTML = '<option value="__all__">All Collections</option>';
    cols.forEach((colName) => {
      const opt = document.createElement("option");
      opt.value = colName;
      opt.textContent = colName;
      libFilterCol.appendChild(opt);
    });
    libFilterCol.value = Array.from(libFilterCol.options).some((o) => o.value === prevCol) ? prevCol : "__all__";
  }

  renderFolderManager();

  const selectedCol = libFilterCol ? libFilterCol.value : "__all__";
  const selectedType = libFilterType ? libFilterType.value : "all";
  const searchTerm = libSearchInput ? libSearchInput.value.trim().toLowerCase() : "";

  const filtered = allItems.filter((item) => {
    if (selectedCol !== "__all__" && getItemCollection(item) !== selectedCol) return false;
    if (selectedType === "image" && getItemResourceType(item) !== "image") return false;
    if (selectedType === "video" && getItemResourceType(item) !== "video") return false;
    if (selectedType === "hidden" && item.hidden !== true) return false;
    if (selectedType === "favorite" && item.favorite !== true) return false;
    if (searchTerm) {
      const haystack = `${getItemTitle(item)} ${getItemAlt(item)} ${getItemCollection(item)}`.toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }
    return true;
  });

  if (libCountSummary) {
    libCountSummary.textContent = `Showing ${filtered.length} of ${allItems.length} item(s)`;
  }

  mediaLibraryGrid.innerHTML = "";
  if (filtered.length === 0) {
    mediaLibraryGrid.innerHTML = '<p class="journal-status">No media items match the current filter.</p>';
    return;
  }

  filtered.forEach((item, idx) => {
    const url = getItemUrl(item);
    const titleText = getItemTitle(item);
    const altText = getItemAlt(item);
    const isVideo = getItemResourceType(item) === "video";
    const pos = getItemPosition(item);

    const card = document.createElement("article");
    card.className = "library-card";
    if (item.hidden === true) card.classList.add("is-hidden-item");

    const mediaBox = document.createElement("div");
    mediaBox.className = "library-card-media";
    mediaBox.onclick = () => {
      activeGalleryList = filtered;
      renderLightboxItem(idx);
    };

    const flags = document.createElement("div");
    flags.className = "library-card-flags";
    if (item.favorite === true) {
      const favPill = document.createElement("span");
      favPill.className = "library-flag-pill flag-fav";
      favPill.textContent = "★ Highlight";
      flags.appendChild(favPill);
    }
    if (item.hidden === true) {
      const hidPill = document.createElement("span");
      hidPill.className = "library-flag-pill flag-hidden";
      hidPill.textContent = "Hidden";
      flags.appendChild(hidPill);
    }
    mediaBox.appendChild(flags);

    if (isVideo) {
      const vBadge = document.createElement("span");
      vBadge.className = "video-badge";
      vBadge.textContent = "▶ VIDEO";
      mediaBox.appendChild(vBadge);

      const img = document.createElement("img");
      img.src = getVideoPosterUrl(item) || url;
      img.alt = altText;
      img.loading = "lazy";
      img.style.objectPosition = pos;
      mediaBox.appendChild(img);
    } else {
      const img = document.createElement("img");
      img.src = url;
      img.alt = altText;
      img.loading = "lazy";
      img.style.objectPosition = pos;
      mediaBox.appendChild(img);
    }

    const body = document.createElement("div");
    body.className = "library-card-body";

    const h3 = document.createElement("h3");
    h3.className = "library-card-title";
    h3.textContent = titleText;
    h3.title = titleText;

    const meta = document.createElement("p");
    meta.className = "library-card-meta";
    meta.textContent = `Folder: ${getItemCollection(item)} • Crop: ${pos}`;

    const actions = document.createElement("div");
    actions.className = "library-card-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn";
    editBtn.textContent = "Edit";
    editBtn.onclick = () => openLibraryItemEditor(item);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-danger-inline";
    delBtn.textContent = "Delete";
    delBtn.onclick = () => deleteMediaItemById(item.id, titleText);

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    body.appendChild(h3);
    body.appendChild(meta);
    body.appendChild(actions);

    card.appendChild(mediaBox);
    card.appendChild(body);
    mediaLibraryGrid.appendChild(card);
  });
};

if (libUploadPanel) {
  if (toggleLibUploadBtn) {
    toggleLibUploadBtn.onclick = () => {
      libUploadPanel.classList.toggle("hidden");
    };
  }

  if (cancelLibUploadPanelBtn) {
    cancelLibUploadPanelBtn.onclick = () => {
      clearStagedUploads();
      libUploadPanel.reset();
      libUploadPanel.classList.add("hidden");
      if (libUploadStatus) libUploadStatus.textContent = "";
      if (libTrackerEl) libTrackerEl.classList.add("hidden");
    };
  }

  if (libCancelUploadBtn) {
    libCancelUploadBtn.onclick = () => {
      uploadCancelled = true;
      if (activeUploadXhr) activeUploadXhr.abort();
    };
  }

  if (libDropzone && libFileUploadInput) {
    libDropzone.onclick = (e) => {
      if (e.target === libFileUploadInput) return;
      libFileUploadInput.click();
    };
    libDropzone.ondragover = (e) => {
      e.preventDefault();
      libDropzone.classList.add("drag-over");
    };
    libDropzone.ondragleave = () => {
      libDropzone.classList.remove("drag-over");
    };
    libDropzone.ondrop = (e) => {
      e.preventDefault();
      libDropzone.classList.remove("drag-over");
      if (e.dataTransfer && e.dataTransfer.files) {
        stageFiles(e.dataTransfer.files);
      }
    };
    libFileUploadInput.onchange = () => {
      stageFiles(libFileUploadInput.files);
      libFileUploadInput.value = "";
    };
  }

  libUploadPanel.onsubmit = async (e) => {
    e.preventDefault();
    if (!isAdminSignedIn) return;

    if (stagedUploads.length === 0) {
      if (libUploadStatus) {
        libUploadStatus.textContent = "Select one or more media files first, then click Upload & Save.";
      }
      return;
    }

    uploadCancelled = false;
    if (libSubmitBtn) libSubmitBtn.disabled = true;
    if (libCancelUploadBtn) libCancelUploadBtn.classList.remove("hidden");
    if (libTrackerEl) libTrackerEl.classList.remove("hidden");
    if (libTrackerList) libTrackerList.innerHTML = "";
    if (libUploadStatus) libUploadStatus.textContent = "";

    const total = stagedUploads.length;
    let completed = 0;
    const remaining = [...stagedUploads];

    for (let i = 0; i < total; i++) {
      if (uploadCancelled) break;
      const entry = stagedUploads[i];
      const targetCol = sanitizeCollectionName(entry.collection) || "general";
      const finalTitle = (entry.title || "").trim() || "Untitled";
      const finalAlt = (entry.altText || "").trim() || finalTitle;
      const finalPos = normalizeObjectPosition(entry.objectPosition);

      if (libTrackerSummary) libTrackerSummary.textContent = `Uploading ${i + 1} of ${total}`;
      if (libTrackerCurrent) {
        libTrackerCurrent.textContent = `${entry.file.name} -> ${buildCloudinaryFolder(targetCol)}`;
      }

      try {
        const uploaded = await uploadFileToCloudinary(
          entry.file,
          targetCol,
          (pct) => {
            const overallPct = Math.round(((i + pct / 100) / total) * 100);
            if (libTrackerPercent) libTrackerPercent.textContent = `${overallPct}%`;
            if (libProgressBar) libProgressBar.style.width = `${overallPct}%`;
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
          objectPosition: finalPos,
          favorite: false,
          hidden: false,
          slot: null,
          journalId: null,
          createdAt: Date.now()
        });

        completed++;
        const idxInRemaining = remaining.findIndex((item) => item.id === entry.id);
        if (idxInRemaining !== -1) {
          const [doneEntry] = remaining.splice(idxInRemaining, 1);
          if (doneEntry && doneEntry.previewUrl) URL.revokeObjectURL(doneEntry.previewUrl);
        }

        if (libTrackerList) {
          const li = document.createElement("li");
          li.className = "upload-tracker-item";
          li.innerHTML = `<span>${escapeHtml(finalTitle)}</span><span class="status-done">Saved</span>`;
          libTrackerList.appendChild(li);
        }
      } catch (err) {
        activeUploadXhr = null;
        if (libTrackerList) {
          const li = document.createElement("li");
          li.className = "upload-tracker-item";
          const statusClass = uploadCancelled ? "status-cancelled" : "status-error";
          const statusLabel = uploadCancelled ? "Cancelled" : `Failed: ${err.message}`;
          li.innerHTML = `<span>${escapeHtml(entry.file.name)}</span><span class="${statusClass}">${escapeHtml(statusLabel)}</span>`;
          libTrackerList.appendChild(li);
        }
      }
    }

    stagedUploads = remaining;
    renderStagedUploads();

    if (libSubmitBtn) libSubmitBtn.disabled = false;
    if (libCancelUploadBtn) libCancelUploadBtn.classList.add("hidden");

    const finalPct = Math.round((completed / total) * 100);
    if (libTrackerPercent) libTrackerPercent.textContent = `${finalPct}%`;
    if (libProgressBar) libProgressBar.style.width = `${finalPct}%`;
    if (libTrackerSummary) {
      libTrackerSummary.textContent = uploadCancelled
        ? `Cancelled (${completed}/${total} saved)`
        : `Completed (${completed}/${total} saved)`;
    }
    if (libTrackerCurrent) libTrackerCurrent.textContent = "";

    if (completed === total && !uploadCancelled) {
      libUploadPanel.reset();
      libUploadPanel.classList.add("hidden");
      if (libUploadStatus) libUploadStatus.textContent = `Uploaded ${completed} file(s) to Cloudinary and saved to Firebase.`;
    } else if (libUploadStatus) {
      libUploadStatus.textContent = `${completed} of ${total} file(s) saved.`;
    }
  };
}

if (toggleFolderManagerBtn && libFolderPanel) {
  toggleFolderManagerBtn.onclick = () => {
    libFolderPanel.classList.toggle("hidden");
  };
}
if (closeFolderManagerBtn && libFolderPanel) {
  closeFolderManagerBtn.onclick = () => {
    libFolderPanel.classList.add("hidden");
  };
}

if (libEditColSelect && libEditColNew) {
  libEditColSelect.onchange = () => {
    const isNew = libEditColSelect.value === "__new__";
    libEditColNew.classList.toggle("hidden", !isNew);
    if (isNew) libEditColNew.focus();
  };
}
if (libEditPosition) {
  libEditPosition.onchange = updateLibraryPreviewCard;
}
if (libEditCancelBtn && libItemEditor) {
  libEditCancelBtn.onclick = () => {
    editingLibraryItem = null;
    libItemEditor.classList.add("hidden");
    if (libEditStatus) libEditStatus.textContent = "";
  };
}

if (libItemEditor) {
  libItemEditor.onsubmit = async (e) => {
    e.preventDefault();
    if (!isAdminSignedIn || !editingLibraryItem || !editingLibraryItem.id) return;
    if (libEditStatus) libEditStatus.textContent = "Saving...";

    const chosenCol = libEditColSelect && libEditColSelect.value === "__new__"
      ? sanitizeCollectionName(libEditColNew ? libEditColNew.value : "")
      : sanitizeCollectionName(libEditColSelect ? libEditColSelect.value : "");

    const finalCol = chosenCol || "general";
    const finalTitle = (libEditTitle ? libEditTitle.value.trim() : "") || "Untitled";
    const finalAlt = (libEditAlt ? libEditAlt.value.trim() : "") || finalTitle;
    const finalPos = normalizeObjectPosition(libEditPosition ? libEditPosition.value : "center");

    try {
      await updateDoc(doc(db, "mediaItems", editingLibraryItem.id), {
        title: finalTitle,
        altText: finalAlt,
        collection: finalCol,
        objectPosition: finalPos,
        favorite: Boolean(libEditFavorite && libEditFavorite.checked),
        hidden: Boolean(libEditHidden && libEditHidden.checked),
        updatedAt: serverTimestamp()
      });
      editingLibraryItem = null;
      libItemEditor.classList.add("hidden");
      if (libEditStatus) libEditStatus.textContent = "";
    } catch (err) {
      if (libEditStatus) libEditStatus.textContent = `Save failed: ${err.message}`;
    }
  };
}

[libFilterCol, libFilterType].forEach((el) => {
  if (el) el.onchange = () => renderMediaLibrary();
});
if (libSearchInput) {
  libSearchInput.oninput = () => renderMediaLibrary();
}

onSnapshot(query(collection(db, "mediaItems"), orderBy("createdAt", "desc")), (snap) => {
  dynamicMediaItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  refreshAllViews();
});

// ------------------------------------------
// C. ABOUT PAGE DIRECT ON-PAGE EDITOR + PREVIEW (about.html)
// ------------------------------------------
const aboutPageTitle = document.getElementById("about-page-title");
const aboutBannerImg = document.getElementById("about-banner-img");
const aboutMediaToolbar = document.getElementById("about-media-toolbar");
const aboutP1El = document.getElementById("about-paragraph-1");
const aboutP2El = document.getElementById("about-paragraph-2");
const aboutExistingSelect = document.getElementById("about-existing-media-select");
const aboutUploadRemoteBtn = document.getElementById("about-upload-remote-btn");
const aboutClearPhotoBtn = document.getElementById("about-clear-photo-btn");
const aboutRemotePicker = document.getElementById("about-remote-picker");
const toggleAboutEditBtn = document.getElementById("toggle-about-edit-btn");
const previewAboutInlineBtn = document.getElementById("preview-about-inline-btn");
const cancelAboutInlineBtn = document.getElementById("cancel-about-inline-btn");
const aboutSaveBtn = document.getElementById("about-save-btn");
const aboutSaveStatus = document.getElementById("about-save-status");

let latestAboutDoc = {};
let aboutSnapshotValues = {
  sectionTitle: "",
  bannerUrl: "",
  paragraph1: "",
  paragraph2: ""
};
let isAboutInlineEditing = false;
let isAboutPreviewing = false;

function getCurrentAboutBannerUrl() {
  const slotMedia = mediaBySlot.get("about-banner");
  return (
    (slotMedia && getItemUrl(slotMedia)) ||
    String(latestAboutDoc.bannerUrl || latestAboutDoc.mediaPath || "").trim()
  );
}

function renderAboutBannerFromState() {
  if (!aboutBannerImg) return;
  const bannerUrl = getCurrentAboutBannerUrl();

  if (!bannerUrl) {
    aboutBannerImg.classList.add("hidden");
    aboutBannerImg.removeAttribute("src");
  } else {
    aboutBannerImg.src = bannerUrl;
    aboutBannerImg.classList.remove("hidden");
  }
}

function captureAboutSnapshot() {
  aboutSnapshotValues = {
    sectionTitle: aboutPageTitle ? aboutPageTitle.textContent.trim() : "",
    bannerUrl: getCurrentAboutBannerUrl(),
    paragraph1: aboutP1El ? aboutP1El.textContent.trim() : "",
    paragraph2: aboutP2El ? aboutP2El.textContent.trim() : ""
  };
}

function setAboutInlineEditing(editing) {
  isAboutInlineEditing = Boolean(editing && isAdminSignedIn);
  isAboutPreviewing = false;
  const editableEls = [aboutPageTitle, aboutP1El, aboutP2El].filter(Boolean);

  editableEls.forEach((el) => {
    el.contentEditable = isAboutInlineEditing ? "true" : "false";
    el.classList.toggle("inline-editable-active", isAboutInlineEditing);
  });

  if (aboutMediaToolbar) aboutMediaToolbar.classList.toggle("hidden", !isAboutInlineEditing);
  if (toggleAboutEditBtn) toggleAboutEditBtn.classList.toggle("hidden", isAboutInlineEditing);
  if (previewAboutInlineBtn) {
    previewAboutInlineBtn.classList.toggle("hidden", !isAboutInlineEditing);
    previewAboutInlineBtn.textContent = "Preview";
  }
  if (aboutSaveBtn) aboutSaveBtn.classList.toggle("hidden", !isAboutInlineEditing);
  if (cancelAboutInlineBtn) cancelAboutInlineBtn.classList.toggle("hidden", !isAboutInlineEditing);

  if (isAboutInlineEditing) {
    captureAboutSnapshot();
    if (aboutExistingSelect) {
      const currentUrl = aboutBannerImg ? aboutBannerImg.getAttribute("src") || "" : "";
      const matchingOpt = Array.from(aboutExistingSelect.options).find((o) => o.value === currentUrl);
      aboutExistingSelect.value = matchingOpt ? matchingOpt.value : "";
    }
    if (aboutSaveStatus) {
      aboutSaveStatus.textContent = "Editing enabled. Edit text or banner controls, Preview layout, or Save Changes.";
    }
    if (aboutP1El) aboutP1El.focus();
  } else if (aboutSaveStatus && aboutSaveStatus.textContent.startsWith("Editing")) {
    aboutSaveStatus.textContent = "";
  }
}

onSnapshot(doc(db, "settings", "aboutBanner"), (snap) => {
  latestAboutDoc = snap.exists() ? snap.data() : {};
  if (aboutPageTitle && latestAboutDoc.sectionTitle) aboutPageTitle.textContent = latestAboutDoc.sectionTitle;
  if (aboutP1El && latestAboutDoc.paragraph1) aboutP1El.textContent = latestAboutDoc.paragraph1;
  if (aboutP2El && latestAboutDoc.paragraph2) aboutP2El.textContent = latestAboutDoc.paragraph2;

  renderAboutBannerFromState();
  captureAboutSnapshot();
});

if (toggleAboutEditBtn) {
  toggleAboutEditBtn.onclick = () => {
    if (!isAdminSignedIn) return;
    setAboutInlineEditing(true);
  };
}

if (previewAboutInlineBtn) {
  previewAboutInlineBtn.onclick = () => {
    if (!isAboutInlineEditing) return;
    isAboutPreviewing = !isAboutPreviewing;
    const editableEls = [aboutPageTitle, aboutP1El, aboutP2El].filter(Boolean);
    editableEls.forEach((el) => {
      el.contentEditable = isAboutPreviewing ? "false" : "true";
      el.classList.toggle("inline-editable-active", !isAboutPreviewing);
    });
    if (aboutMediaToolbar) aboutMediaToolbar.classList.toggle("hidden", isAboutPreviewing);
    previewAboutInlineBtn.textContent = isAboutPreviewing ? "Resume Editing" : "Preview";
    if (aboutSaveStatus) {
      aboutSaveStatus.textContent = isAboutPreviewing
        ? "Previewing visitor view (unsaved). Click Save Changes to publish or Resume Editing."
        : "Editing enabled. Edit text or banner controls directly, then click Save Changes.";
    }
  };
}

if (cancelAboutInlineBtn) {
  cancelAboutInlineBtn.onclick = () => {
    if (aboutPageTitle) aboutPageTitle.textContent = aboutSnapshotValues.sectionTitle;
    if (aboutP1El) aboutP1El.textContent = aboutSnapshotValues.paragraph1;
    if (aboutP2El) aboutP2El.textContent = aboutSnapshotValues.paragraph2;
    if (aboutBannerImg) {
      if (aboutSnapshotValues.bannerUrl) {
        aboutBannerImg.src = aboutSnapshotValues.bannerUrl;
        aboutBannerImg.classList.remove("hidden");
      } else {
        aboutBannerImg.classList.add("hidden");
        aboutBannerImg.removeAttribute("src");
      }
    }
    setAboutInlineEditing(false);
    if (aboutSaveStatus) aboutSaveStatus.textContent = "";
  };
}

if (aboutExistingSelect) {
  aboutExistingSelect.onchange = () => {
    const url = aboutExistingSelect.value.trim();
    if (!url || !aboutBannerImg) return;
    aboutBannerImg.src = url;
    aboutBannerImg.classList.remove("hidden");
    if (aboutSaveStatus) {
      aboutSaveStatus.textContent = "Banner preview updated. Click Save Changes to apply.";
    }
  };
}

if (aboutClearPhotoBtn && aboutBannerImg) {
  aboutClearPhotoBtn.onclick = () => {
    if (aboutExistingSelect) aboutExistingSelect.value = "";
    aboutBannerImg.classList.add("hidden");
    aboutBannerImg.removeAttribute("src");
    if (aboutSaveStatus) aboutSaveStatus.textContent = "Banner removed in preview. Click Save Changes to apply.";
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

  const finalTitle = aboutPageTitle ? aboutPageTitle.textContent.trim() : "";
  const finalBannerUrl = aboutBannerImg && !aboutBannerImg.classList.contains("hidden")
    ? (aboutBannerImg.getAttribute("src") || "").trim()
    : "";
  const finalP1 = aboutP1El ? aboutP1El.textContent.trim() : "";
  const finalP2 = aboutP2El ? aboutP2El.textContent.trim() : "";

  try {
    await setDoc(doc(db, "settings", "aboutBanner"), {
      sectionTitle: finalTitle,
      bannerUrl: finalBannerUrl,
      mediaPath: finalBannerUrl,
      paragraph1: finalP1,
      paragraph2: finalP2,
      updatedAt: serverTimestamp()
    }, { merge: true });

    latestAboutDoc = {
      ...latestAboutDoc,
      sectionTitle: finalTitle,
      bannerUrl: finalBannerUrl,
      mediaPath: finalBannerUrl,
      paragraph1: finalP1,
      paragraph2: finalP2
    };
    captureAboutSnapshot();
    setAboutInlineEditing(false);
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
const toggleJournalMediaPickerBtn = document.getElementById("toggle-journal-media-picker-btn");
const journalMediaPickerGrid = document.getElementById("journal-media-picker-grid");
const clearJournalMediaBtn = document.getElementById("clear-journal-media-btn");
const journalAltInput = document.getElementById("journal-alt-input");
const journalLocationInput = document.getElementById("journal-location-input");
const journalPeopleInput = document.getElementById("journal-people-input");
const journalTagsInput = document.getElementById("journal-tags-input");
const journalCameraInput = document.getElementById("journal-camera-input");
const journalResolutionInput = document.getElementById("journal-resolution-input");
const journalDescInput = document.getElementById("journal-desc-input");
const cancelJournalEditBtn = document.getElementById("cancel-journal-edit-btn");
const journalSaveStatus = document.getElementById("journal-save-status");

function setJournalMediaPickerOpen(open) {
  if (!journalMediaPickerGrid) return;
  journalMediaPickerGrid.classList.toggle("hidden", !open);
  if (toggleJournalMediaPickerBtn) {
    toggleJournalMediaPickerBtn.textContent = open ? "Hide Media" : "Select Media";
  }
}

function resetJournalEditor() {
  if (!journalEditorPanel) return;
  journalEditorPanel.reset();
  attachedMediaId = null;
  selectedJournalMediaUrl = "";
  setJournalMediaPickerOpen(false);
  updateJournalPickerSelectionUI();
  if (journalDocIdInput) journalDocIdInput.value = "";
  if (journalDateInput) journalDateInput.valueAsDate = new Date();
  if (journalEditorHeading) journalEditorHeading.textContent = "New Diary Entry";
  if (journalSaveStatus) journalSaveStatus.textContent = "";
}

openJournalEditForm = (entry) => {
  if (!journalEditorPanel) return;
  const entryUrl = getItemUrl(entry);
  const matchedMedia = resolveMediaReference(entry.mediaId || entry.slot, entryUrl);
  attachedMediaId = (matchedMedia && matchedMedia.id) || entry.mediaId || null;
  selectedJournalMediaUrl = (matchedMedia && getItemUrl(matchedMedia)) || entryUrl;
  setJournalMediaPickerOpen(false);
  updateJournalPickerSelectionUI();

  if (journalDocIdInput) journalDocIdInput.value = entry.id || "";
  if (journalTitleInput) journalTitleInput.value = entry.title || entry.displayTitle || "";
  if (journalDateInput) journalDateInput.value = entry.date || "";
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
  if (journalSaveStatus) journalSaveStatus.textContent = "";

  journalEditorPanel.classList.remove("hidden");
  journalEditorPanel.scrollIntoView({ behavior: "smooth" });
};

if (toggleJournalMediaPickerBtn && journalMediaPickerGrid) {
  toggleJournalMediaPickerBtn.onclick = () => {
    const willOpen = journalMediaPickerGrid.classList.contains("hidden");
    setJournalMediaPickerOpen(willOpen);
  };
}

if (clearJournalMediaBtn) {
  clearJournalMediaBtn.onclick = () => {
    attachedMediaId = null;
    selectedJournalMediaUrl = "";
    updateJournalPickerSelectionUI();
    if (journalSaveStatus) {
      journalSaveStatus.textContent = "Media selection cleared. Click Save Entry to apply.";
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

if (journalEditorPanel) {
  journalEditorPanel.onsubmit = async (e) => {
    e.preventDefault();
    if (!isAdminSignedIn) return;
    if (journalSaveStatus) journalSaveStatus.textContent = "Saving...";

    const selectedItem = attachedMediaId ? mediaById.get(attachedMediaId) : null;
    const cleanUrl = (selectedItem && getItemUrl(selectedItem)) || selectedJournalMediaUrl || "";
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
      vid.style.objectPosition = getItemPosition(linkedMedia || entry);
      const poster = getVideoPosterUrl(linkedMedia || { secureUrl: mediaUrl, posterUrl: entry.posterUrl });
      if (poster) vid.poster = poster;
      vid.onerror = () => renderMediaFallback(mediaBox, fallbackCaption);
      mediaBox.appendChild(vid);
    } else if (mediaUrl) {
      const img = document.createElement("img");
      img.src = mediaUrl;
      img.alt = fallbackCaption;
      img.loading = "lazy";
      img.style.objectPosition = getItemPosition(linkedMedia || entry);
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