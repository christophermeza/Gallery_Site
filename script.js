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
// 1. MEDIA LIBRARY & PATH HELPERS (FIRESTORE + REPO PATHS)
// ==========================================
let dynamicMediaItems = [];
let customTitleByPath = {};
let customAltByPath = {};
let isAdminSignedIn = false;

let deleteJournalEntryById = async () => {};
let deleteMediaItemById = async () => {};

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isRemoteUrl(path) {
  return /^(https?:\/\/|data:|blob:)/i.test(String(path || "").trim());
}

function normalizeMediaPath(rawPath) {
  if (!rawPath) return "";
  const trimmed = String(rawPath).trim();
  if (!trimmed) return "";
  if (isRemoteUrl(trimmed)) return trimmed;

  const cleaned = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
  if (/^media\//i.test(cleaned)) {
    return cleaned;
  }
  return `media/${cleaned}`;
}

function getEntryMediaPath(entry) {
  if (!entry) return "";
  const raw =
    entry.mediaPath ||
    entry.file ||
    entry.imageUrl ||
    entry.image ||
    entry.url ||
    entry.path ||
    "";
  return normalizeMediaPath(raw);
}

function getCombinedLibrary() {
  const combined = {};

  dynamicMediaItems.forEach((item) => {
    const folder = (item.folder || "general").toLowerCase().trim();
    if (!combined[folder]) combined[folder] = [];
    const resolved = normalizeMediaPath(item.mediaPath || item.file || "");
    if (!resolved) return;

    const existingIdx = combined[folder].findIndex(
      (existing) => normalizeMediaPath(existing.path).toLowerCase() === resolved.toLowerCase()
    );

    const record = {
      id: item.id,
      folder,
      path: resolved,
      name: resolved.split("/").pop() || "media",
      displayTitle: item.displayTitle || item.title || "",
      altText: item.altText || ""
    };

    if (existingIdx >= 0) {
      combined[folder][existingIdx] = record;
    } else {
      combined[folder].push(record);
    }
  });

  return combined;
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

function getDisplayNameForMedia(filePath, explicitTitle = "") {
  if (explicitTitle && !explicitTitle.includes(".")) return explicitTitle;
  const norm = normalizeMediaPath(filePath).toLowerCase();
  const base = norm.split("/").pop().toLowerCase();
  return customTitleByPath[norm] || customTitleByPath[base] || "Untitled";
}

function getAltTextForMedia(filePath, explicitAlt = "") {
  if (explicitAlt) return explicitAlt;
  const norm = normalizeMediaPath(filePath).toLowerCase();
  const base = norm.split("/").pop().toLowerCase();
  return customAltByPath[norm] || customAltByPath[base] || getDisplayNameForMedia(filePath);
}

function isVideoFile(filename) {
  if (!filename) return false;
  const cleanUrl = filename.split("?")[0].toLowerCase();
  return (
    cleanUrl.endsWith(".mp4") ||
    cleanUrl.endsWith(".webm") ||
    cleanUrl.endsWith(".ogg") ||
    cleanUrl.endsWith(".mov")
  );
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

function renderMediaFallback(container, fallbackText, defaultLabel = "No caption available") {
  if (!container) return;
  const caption = (fallbackText || "").trim() || defaultLabel;
  container.innerHTML = `<span class="journal-media-placeholder">${escapeHtml(caption)}</span>`;
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
let trackEvent = () => {};

function renderLightboxItem(index) {
  if (!lightbox || !lightboxContent || activeGalleryList.length === 0) return;
  currentMediaIndex = (index + activeGalleryList.length) % activeGalleryList.length;
  const item = activeGalleryList[currentMediaIndex];
  const resolvedPath = normalizeMediaPath(item.path);
  const displayLabel = getDisplayNameForMedia(resolvedPath, item.displayTitle || "");
  const fallbackAlt = getAltTextForMedia(resolvedPath, item.altText || "");

  lightboxContent.innerHTML = "";
  if (isVideoFile(resolvedPath)) {
    const vid = document.createElement("video");
    vid.src = resolvedPath;
    vid.controls = true;
    vid.autoplay = true;
    vid.onerror = () => {
      lightboxContent.innerHTML = `<p class="entry-media-missing" style="color:#fff;">${escapeHtml(fallbackAlt)}</p>`;
    };
    lightboxContent.appendChild(vid);
  } else {
    const img = document.createElement("img");
    img.src = resolvedPath;
    img.alt = fallbackAlt;
    img.onerror = () => {
      lightboxContent.innerHTML = `<p class="entry-media-missing" style="color:#fff;">${escapeHtml(fallbackAlt)}</p>`;
    };
    lightboxContent.appendChild(img);
  }

  if (lightboxCaption) {
    lightboxCaption.textContent = `${displayLabel} (${currentMediaIndex + 1} of ${activeGalleryList.length})`;
  }
  lightbox.classList.remove("hidden");
  trackEvent("view_media", { media_name: displayLabel });
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

  const mediaPath = getEntryMediaPath(entry);
  const titleText = entry.displayTitle || entry.title || "Untitled Memory";
  const fallbackCaption = entry.altText || titleText;
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

  if (mediaPath && isVideoFile(mediaPath)) {
    const vid = document.createElement("video");
    vid.src = mediaPath;
    vid.controls = true;
    vid.autoplay = true;
    vid.onerror = () => {
      mediaWrap.innerHTML = `<p class="entry-media-missing">${escapeHtml(fallbackCaption)}</p>`;
    };
    mediaWrap.appendChild(vid);
  } else if (mediaPath) {
    const img = document.createElement("img");
    img.src = mediaPath;
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
  descEl.textContent = entry.description || "";

  const metaBox = document.createElement("div");
  metaBox.className = "entry-meta-grid";
  appendMetaRow(metaBox, "Location", entry.location);
  appendMetaRow(metaBox, "People", formattedPeople);
  appendMetaRow(metaBox, "Tags", formattedTags);
  appendMetaRow(metaBox, "Camera / Device", entry.camera);
  appendMetaRow(metaBox, "Resolution", entry.resolution);
  appendMetaRow(metaBox, "Alt Text", entry.altText);

  bodyWrap.appendChild(headerStack);
  if (entry.description) bodyWrap.appendChild(descEl);
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

function createMediaCard(itemObj, listRef, indexInList) {
  const resolvedPath = normalizeMediaPath(itemObj.path);
  const displayLabel = getDisplayNameForMedia(resolvedPath, itemObj.displayTitle || "");
  const fallbackAlt = getAltTextForMedia(resolvedPath, itemObj.altText || "");

  const card = document.createElement("div");
  card.className = "media-item";

  const showFallbackCard = () => {
    card.classList.add("media-missing");
    card.innerHTML = `<span class="media-fallback-text">${escapeHtml(fallbackAlt)}</span>`;
  };

  if (isVideoFile(resolvedPath)) {
    const badge = document.createElement("span");
    badge.className = "video-badge";
    badge.textContent = "▶ VIDEO";

    const video = document.createElement("video");
    video.src = resolvedPath;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.onerror = showFallbackCard;

    card.appendChild(badge);
    card.appendChild(video);
  } else {
    const img = document.createElement("img");
    img.src = resolvedPath;
    img.alt = fallbackAlt;
    img.loading = "lazy";
    img.onerror = showFallbackCard;
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
      await deleteMediaItemById(itemObj.id, displayLabel);
    };
    card.appendChild(delBtn);
  }

  card.onclick = () => {
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
  const library = getCombinedLibrary();
  const highlightList = [];

  Object.values(library).forEach((items) => {
    const previewItem = items.find((i) => !isVideoFile(i.path)) || items[0];
    if (previewItem) highlightList.push(previewItem);
  });

  highlightList.forEach((item, idx) => {
    homeHighlights.appendChild(createMediaCard(item, highlightList, idx));
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
    const library = getCombinedLibrary();
    const filteredList = [];

    Object.values(library).forEach((items) => {
      items.forEach((item) => {
        const video = isVideoFile(item.path);
        if (filter === "image" && video) return;
        if (filter === "video" && !video) return;
        filteredList.push(item);
      });
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

    const library = getCombinedLibrary();
    Object.entries(library).forEach(([folder, items]) => {
      const coverItem = items.find((i) => !isVideoFile(i.path)) || items[0];
      if (!coverItem) return;

      const albumCard = document.createElement("div");
      albumCard.className = "album-card";

      const img = document.createElement("img");
      img.className = "album-cover";
      img.src = normalizeMediaPath(coverItem.path);
      img.alt = getAltTextForMedia(coverItem.path, folder);
      img.onerror = () => {
        albumCard.style.display = "none";
      };

      const info = document.createElement("div");
      info.className = "album-info";

      const h3 = document.createElement("h3");
      h3.textContent = folder;

      const p = document.createElement("p");
      p.textContent = items.length + (items.length === 1 ? " item" : " items");

      info.appendChild(h3);
      info.appendChild(p);
      albumCard.appendChild(img);
      albumCard.appendChild(info);

      albumCard.onclick = () => openAlbum(folder);
      collectionsGrid.appendChild(albumCard);
    });
  }

  function openAlbum(folder) {
    activeCollectionFolder = folder;
    collectionsGrid.innerHTML = "";
    if (collectionTitle) {
      collectionTitle.textContent = folder.charAt(0).toUpperCase() + folder.slice(1);
    }
    if (backBtn) backBtn.classList.remove("hidden");
    trackEvent("open_album", { album_name: folder });

    const library = getCombinedLibrary();
    const albumList = library[folder] || [];

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
// 7. ABOUT PAGE STATS (about.html)
// ==========================================
const archiveStats = document.getElementById("archive-stats");

function renderArchiveStats() {
  if (!archiveStats) return;
  const library = getCombinedLibrary();
  let totalPhotos = 0;
  let totalVideos = 0;
  const totalAlbums = Object.keys(library).length;

  Object.values(library).flat().forEach((item) => {
    if (isVideoFile(item.path)) totalVideos++;
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
// 8. FIREBASE AUTH & FIRESTORE INLINE EDITING (SPARK FREE PLAN)
// ==========================================
(async () => {
  try {
    const host = "www." + "gstatic" + ".com";
    const ver = "10.14.1";
    const base = "https://" + host + "/firebasejs/" + ver + "/";

    const { initializeApp } = await import(base + "firebase-app.js");
    const { getAnalytics, logEvent } = await import(base + "firebase-analytics.js");
    const {
      getAuth,
      setPersistence,
      browserSessionPersistence,
      onAuthStateChanged
    } = await import(base + "firebase-auth.js");
    const {
      getFirestore,
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
    } = await import(base + "firebase-firestore.js");

    const firebaseConfig = {
      apiKey: "AIzaSyAdJOUeCtXQC5k5qabCQZoQ8hoXvLNWJq0",
      authDomain: "gallery-site-d188d.firebaseapp.com",
      projectId: "gallery-site-d188d",
      storageBucket: "gallery-site-d188d.firebasestorage.app",
      messagingSenderId: "154184726328",
      appId: "1:154184726328:web:97d7062afb03ef792eb3cd",
      measurementId: "G-4EXWDTN96L"
    };

    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);
    const auth = getAuth(app);

    setPersistence(auth, browserSessionPersistence).catch(() => {});

    try {
      const analytics = getAnalytics(app);
      trackEvent = (name, params) => logEvent(analytics, name, params);
    } catch (e) {}

    let liveEntries = [];

    function refreshAllViews() {
      const titleMap = {};
      const altMap = {};

      [...dynamicMediaItems, ...liveEntries].forEach((item) => {
        const rawPath = getEntryMediaPath(item);
        if (!rawPath) return;
        const norm = rawPath.toLowerCase();
        const fileOnly = norm.split("/").pop();

        const title = (item.displayTitle || item.title || "").trim();
        const alt = (item.altText || "").trim();

        if (title) {
          titleMap[norm] = title;
          if (fileOnly) titleMap[fileOnly] = title;
        }
        if (alt) {
          altMap[norm] = alt;
          if (fileOnly) altMap[fileOnly] = alt;
        }
      });

      customTitleByPath = titleMap;
      customAltByPath = altMap;

      renderHomeHighlights();
      if (typeof renderAllMedia === "function") renderAllMedia(currentMediaFilter);
      renderCollectionsView();
      renderArchiveStats();
      renderJournal();

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
    // B. COLLECTIONS INLINE ADD BY REPO PATH (collections.html)
    // ------------------------------------------
    const toggleColBtn = document.getElementById("toggle-add-collection-btn");
    const colPanel = document.getElementById("collection-add-panel");
    const cancelColBtn = document.getElementById("cancel-add-collection-btn");
    const colSubmitBtn = document.getElementById("col-submit-btn");
    const colFolderInput = document.getElementById("col-folder-input");
    const colDropzone = document.getElementById("col-dropzone");
    const colRemoteUploadInput = document.getElementById("col-remote-upload");
    const colPickFolderModeBtn = document.getElementById("col-pick-folder-mode-btn");
    const colFolderUploadInput = document.getElementById("col-folder-upload");
    const colTitleInput = document.getElementById("col-title-input");
    const colAltInput = document.getElementById("col-alt-input");
    const colStatusEl = document.getElementById("col-add-status");

    let stagedPaths = [];

    function sanitizeCollectionSlug(raw) {
      return String(raw || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }

    function deriveFolderFromPath(rawPath, fallbackFolder) {
      const cleaned = String(rawPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
      const parts = cleaned.split("/").filter(Boolean);
      if (parts.length >= 3 && parts[0].toLowerCase() === "media") {
        return sanitizeCollectionSlug(parts[1]) || "general";
      }
      if (parts.length >= 2 && !isRemoteUrl(cleaned)) {
        return sanitizeCollectionSlug(parts[0]) || "general";
      }
      return sanitizeCollectionSlug(fallbackFolder) || "general";
    }

    function stagePickedFiles(files) {
      const baseFolder = sanitizeCollectionSlug(colFolderInput && colFolderInput.value) || "general";
      files.forEach((file) => {
        const rel = String(file.webkitRelativePath || file.name || "").replace(/\\/g, "/");
        const folder = deriveFolderFromPath(rel, baseFolder);
        const normalized = normalizeMediaPath(rel.startsWith("media/") ? rel : `${folder}/${file.name}`);
        const cleanTitle = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Untitled";
        if (!stagedPaths.some((p) => p.mediaPath.toLowerCase() === normalized.toLowerCase())) {
          stagedPaths.push({
            mediaPath: normalized,
            folder,
            displayTitle: cleanTitle
          });
        }
      });

      if (colStatusEl && stagedPaths.length > 0) {
        colStatusEl.textContent = `${stagedPaths.length} file path(s) ready from local selection. Click "Upload & Save" to save to Firestore.`;
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
          stagedPaths = [];
          colPanel.reset();
          colPanel.classList.add("hidden");
          if (colStatusEl) colStatusEl.textContent = "";
        };
      }

      if (colDropzone && colRemoteUploadInput) {
        colDropzone.onclick = (e) => {
          if (e.target === colRemoteUploadInput) return;
          colRemoteUploadInput.click();
        };
      }

      if (colRemoteUploadInput) {
        colRemoteUploadInput.onchange = () => {
          stagePickedFiles(Array.from(colRemoteUploadInput.files || []));
          colRemoteUploadInput.value = "";
        };
      }

      if (colPickFolderModeBtn && colFolderUploadInput) {
        colPickFolderModeBtn.onclick = () => colFolderUploadInput.click();
        colFolderUploadInput.onchange = () => {
          stagePickedFiles(Array.from(colFolderUploadInput.files || []));
          colFolderUploadInput.value = "";
        };
      }

      colPanel.onsubmit = async (e) => {
        e.preventDefault();
        if (!isAdminSignedIn) return;

        const folderOverride = sanitizeCollectionSlug(colFolderInput && colFolderInput.value);
        const customTitle = (colTitleInput && colTitleInput.value.trim()) || "";
        const customAlt = (colAltInput && colAltInput.value.trim()) || "";

        if (stagedPaths.length === 0) {
          if (colStatusEl) {
            colStatusEl.textContent = "Choose a file/folder or enter a Creative Display Title with a folder name, then click Save.";
          }
          return;
        }

        if (colSubmitBtn) colSubmitBtn.disabled = true;
        if (colStatusEl) colStatusEl.textContent = "Saving media items to Firestore...";

        try {
          for (let i = 0; i < stagedPaths.length; i++) {
            const item = stagedPaths[i];
            const targetFolder = folderOverride || item.folder || "general";
            const finalTitle = (stagedPaths.length === 1 && customTitle) || item.displayTitle;
            const finalAlt = customAlt || finalTitle;

            await addDoc(collection(db, "mediaItems"), {
              folder: targetFolder,
              mediaPath: item.mediaPath,
              displayTitle: finalTitle,
              altText: finalAlt,
              createdAt: serverTimestamp()
            });
          }

          stagedPaths = [];
          colPanel.reset();
          colPanel.classList.add("hidden");
          if (colStatusEl) colStatusEl.textContent = "Saved to Firestore.";
        } catch (err) {
          if (colStatusEl) colStatusEl.textContent = `Save failed: ${err.message}`;
        } finally {
          if (colSubmitBtn) colSubmitBtn.disabled = false;
        }
      };
    }

    onSnapshot(query(collection(db, "mediaItems"), orderBy("createdAt", "desc")), (snap) => {
      dynamicMediaItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      refreshAllViews();
    });

    // ------------------------------------------
    // C. ABOUT PAGE IN-PLACE INLINE EDITOR (about.html)
    // ------------------------------------------
    const aboutBannerImg = document.getElementById("about-banner-img");
    const aboutP1El = document.getElementById("about-paragraph-1");
    const aboutP2El = document.getElementById("about-paragraph-2");
    const toggleAboutEditBtn = document.getElementById("toggle-about-edit-btn");
    const aboutEditorPanel = document.getElementById("about-editor-panel");
    const aboutPhotoInput = document.getElementById("about-photo-input");
    const aboutUploadRemoteBtn = document.getElementById("about-upload-remote-btn");
    const aboutClearPhotoBtn = document.getElementById("about-clear-photo-btn");
    const aboutRemotePicker = document.getElementById("about-remote-picker");
    const aboutP1Input = document.getElementById("about-p1-input");
    const aboutP2Input = document.getElementById("about-p2-input");
    const cancelAboutEditBtn = document.getElementById("cancel-about-edit-btn");
    const aboutSaveStatus = document.getElementById("about-save-status");

    function syncAboutEditorInputs() {
      if (aboutPhotoInput && aboutBannerImg) {
        aboutPhotoInput.value = aboutBannerImg.getAttribute("src") || "";
      }
      if (aboutP1Input && aboutP1El) aboutP1Input.value = aboutP1El.textContent.trim();
      if (aboutP2Input && aboutP2El) aboutP2Input.value = aboutP2El.textContent.trim();
    }

    onSnapshot(doc(db, "settings", "aboutBanner"), (snap) => {
      const data = snap.exists() ? snap.data() : {};
      const rawPath = (data.mediaPath || "").trim();
      const resolvedBanner = rawPath ? normalizeMediaPath(rawPath) : "";

      if (aboutBannerImg) {
        if (!resolvedBanner) {
          aboutBannerImg.classList.add("hidden");
          aboutBannerImg.removeAttribute("src");
        } else {
          aboutBannerImg.src = resolvedBanner;
          aboutBannerImg.classList.remove("hidden");
        }
      }

      if (aboutP1El && data.paragraph1) aboutP1El.textContent = data.paragraph1;
      if (aboutP2El && data.paragraph2) aboutP2El.textContent = data.paragraph2;

      if (!aboutEditorPanel || aboutEditorPanel.classList.contains("hidden")) {
        if (aboutPhotoInput) aboutPhotoInput.value = resolvedBanner;
        if (aboutP1Input && aboutP1El) aboutP1Input.value = aboutP1El.textContent.trim();
        if (aboutP2Input && aboutP2El) aboutP2Input.value = aboutP2El.textContent.trim();
      }
    });

    if (toggleAboutEditBtn && aboutEditorPanel) {
      toggleAboutEditBtn.onclick = () => {
        syncAboutEditorInputs();
        if (aboutSaveStatus) aboutSaveStatus.textContent = "";
        aboutEditorPanel.classList.toggle("hidden");
      };
    }
    if (cancelAboutEditBtn && aboutEditorPanel) {
      cancelAboutEditBtn.onclick = () => {
        syncAboutEditorInputs();
        aboutEditorPanel.classList.add("hidden");
        if (aboutSaveStatus) aboutSaveStatus.textContent = "";
      };
    }
    if (aboutClearPhotoBtn && aboutPhotoInput && aboutBannerImg) {
      aboutClearPhotoBtn.onclick = () => {
        aboutPhotoInput.value = "";
        aboutBannerImg.classList.add("hidden");
        aboutBannerImg.removeAttribute("src");
        if (aboutSaveStatus) aboutSaveStatus.textContent = "Banner photo cleared. Click Save Changes to apply.";
      };
    }
    if (aboutUploadRemoteBtn && aboutRemotePicker) {
      aboutUploadRemoteBtn.onclick = () => aboutRemotePicker.click();
      aboutRemotePicker.onchange = () => {
        const file = aboutRemotePicker.files && aboutRemotePicker.files[0];
        if (!file) return;
        const chosenPath = normalizeMediaPath(`about/${file.name}`);
        if (aboutPhotoInput) aboutPhotoInput.value = chosenPath;
        if (aboutSaveStatus) {
          aboutSaveStatus.textContent = `Set path to "${chosenPath}". Push the file to your repo's media/about/ folder and click Save Changes.`;
        }
        aboutRemotePicker.value = "";
      };
    }
    if (aboutEditorPanel) {
      aboutEditorPanel.onsubmit = async (e) => {
        e.preventDefault();
        if (!isAdminSignedIn) return;
        if (aboutSaveStatus) aboutSaveStatus.textContent = "Saving...";
        const finalBannerPath = normalizeMediaPath(aboutPhotoInput ? aboutPhotoInput.value : "");
        const finalP1 = aboutP1Input ? aboutP1Input.value.trim() : "";
        const finalP2 = aboutP2Input ? aboutP2Input.value.trim() : "";

        try {
          await setDoc(doc(db, "settings", "aboutBanner"), {
            mediaPath: finalBannerPath,
            paragraph1: finalP1,
            paragraph2: finalP2,
            updatedAt: serverTimestamp()
          }, { merge: true });

          if (aboutP1El && finalP1) aboutP1El.textContent = finalP1;
          if (aboutP2El && finalP2) aboutP2El.textContent = finalP2;
          if (aboutBannerImg) {
            if (finalBannerPath) {
              aboutBannerImg.src = finalBannerPath;
              aboutBannerImg.classList.remove("hidden");
            } else {
              aboutBannerImg.classList.add("hidden");
              aboutBannerImg.removeAttribute("src");
            }
          }

          if (aboutSaveStatus) aboutSaveStatus.textContent = "Saved.";
          aboutEditorPanel.classList.add("hidden");
        } catch (err) {
          if (aboutSaveStatus) aboutSaveStatus.textContent = `Save failed: ${err.message}`;
        }
      };
    }

    // ------------------------------------------
    // D. DIARY / JOURNAL INLINE CRUD (journal.html)
    // ------------------------------------------
    const journalFeed = document.getElementById("journal-feed");
    const addJournalEntryBtn = document.getElementById("add-journal-entry-btn");
    const journalEditorPanel = document.getElementById("journal-editor-panel");
    const journalEditorHeading = document.getElementById("journal-editor-heading");
    const journalDocIdInput = document.getElementById("journal-doc-id");
    const journalTitleInput = document.getElementById("journal-title-input");
    const journalDateInput = document.getElementById("journal-date-input");
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

    function resetJournalEditor() {
      if (!journalEditorPanel) return;
      journalEditorPanel.reset();
      if (journalDocIdInput) journalDocIdInput.value = "";
      if (journalDateInput) journalDateInput.valueAsDate = new Date();
      if (journalEditorHeading) journalEditorHeading.textContent = "New Diary Entry";
      if (journalSaveStatus) journalSaveStatus.textContent = "";
    }

    openJournalEditForm = (entry) => {
      if (!journalEditorPanel) return;
      if (journalDocIdInput) journalDocIdInput.value = entry.id || "";
      if (journalTitleInput) journalTitleInput.value = entry.displayTitle || entry.title || "";
      if (journalDateInput) journalDateInput.value = entry.date || "";
      if (journalPathInput) journalPathInput.value = getEntryMediaPath(entry);
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
      if (journalDescInput) journalDescInput.value = entry.description || "";
      if (journalEditorHeading) journalEditorHeading.textContent = "Edit Diary Entry";

      journalEditorPanel.classList.remove("hidden");
      journalEditorPanel.scrollIntoView({ behavior: "smooth" });
    };

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
      journalRemotePicker.onchange = () => {
        const file = journalRemotePicker.files && journalRemotePicker.files[0];
        if (!file) return;
        detectFileDimensions(file, journalResolutionInput);
        const chosenPath = normalizeMediaPath(`diary/${file.name}`);
        if (journalPathInput) journalPathInput.value = chosenPath;
        if (journalSaveStatus) {
          journalSaveStatus.textContent = `Set media path to "${chosenPath}". Push the file to media/diary/ on GitHub and click Save Entry.`;
        }
        journalRemotePicker.value = "";
      };
    }

    if (journalEditorPanel) {
      journalEditorPanel.onsubmit = async (e) => {
        e.preventDefault();
        if (!isAdminSignedIn) return;
        if (journalSaveStatus) journalSaveStatus.textContent = "Saving...";

        const cleanPath = normalizeMediaPath(journalPathInput.value);
        const cleanTitle = journalTitleInput.value.trim();
        const peopleList = journalPeopleInput.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const tagList = journalTagsInput.value
          .split(",")
          .map((s) => s.replace(/\s+/g, "").replace(/^#+/, ""))
          .filter(Boolean);

        const payload = {
          date: journalDateInput.value,
          mediaPath: cleanPath,
          file: cleanPath,
          displayTitle: cleanTitle,
          title: cleanTitle,
          altText: journalAltInput.value.trim(),
          location: journalLocationInput.value.trim(),
          people: peopleList,
          tags: tagList,
          camera: journalCameraInput.value.trim(),
          resolution: journalResolutionInput.value.trim(),
          description: journalDescInput.value.trim(),
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
        const mediaPath = getEntryMediaPath(entry);
        const titleText = entry.displayTitle || entry.title || "Untitled Memory";
        const fallbackCaption = entry.altText || titleText;
        const formattedPeople = formatPeopleList(entry.people);
        const formattedTags = formatHashtags(entry.tags);

        const article = document.createElement("article");
        article.className = "journal-entry";
        article.onclick = () => openEntryDetail(entry);

        const mediaBox = document.createElement("div");
        mediaBox.className = "journal-media";

        if (mediaPath && isVideoFile(mediaPath)) {
          const vid = document.createElement("video");
          vid.src = mediaPath;
          vid.muted = true;
          vid.playsInline = true;
          vid.preload = "metadata";
          vid.onerror = () => renderMediaFallback(mediaBox, fallbackCaption);
          mediaBox.appendChild(vid);
        } else if (mediaPath) {
          const img = document.createElement("img");
          img.src = mediaPath;
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
        descP.textContent = entry.description || entry.altText || "";

        const metaBox = document.createElement("div");
        metaBox.className = "journal-meta-list";
        appendCardMeta(metaBox, "Location", entry.location);
        appendCardMeta(metaBox, "People", formattedPeople);
        appendCardMeta(metaBox, "Tags", formattedTags);
        appendCardMeta(metaBox, "Camera / Device", entry.camera);
        appendCardMeta(metaBox, "Resolution", entry.resolution);

        textBox.appendChild(titleH3);
        if (entry.date) textBox.appendChild(dateSpan);
        if (entry.description || entry.altText) textBox.appendChild(descP);
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

    const q = query(collection(db, "entries"), orderBy("date", "desc"));
    onSnapshot(q, (snapshot) => {
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
  } catch (err) {
    console.error("Firebase initialization error:", err);
  }
})();