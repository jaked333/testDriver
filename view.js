import { supabaseConfig } from "./supabase-config.js";
import {
  REPAIR_STEPS,
  createStorageClient,
  getSupabaseErrorDetails,
  isPlaceholderConfig,
  sanitizeJobId
} from "./shared.js";

// DOM Elements
const configWarningBanner = document.getElementById("configWarningBanner");
const statusBanner = document.getElementById("statusBanner");
const statusMessage = document.getElementById("statusMessage");
const statusHint = document.getElementById("statusHint");

const lookupForm = document.getElementById("lookupForm");
const viewJobIdInput = document.getElementById("viewJobIdInput");
const viewJobIdHint = document.getElementById("viewJobIdHint");
const loadJobBtn = document.getElementById("loadJobBtn");
const activeJobBadge = document.getElementById("activeJobBadge");
const totalPhotoCount = document.getElementById("totalPhotoCount");
const stepFilterBar = document.getElementById("stepFilterBar");
const sectionsContainer = document.getElementById("sectionsContainer");

// Lightbox Elements
const lightboxDialog = document.getElementById("lightboxDialog");
const lightboxStage = document.getElementById("lightboxStage");
const lightboxStepBadge = document.getElementById("lightboxStepBadge");
const lightboxCounter = document.getElementById("lightboxCounter");
const lightboxImg = document.getElementById("lightboxImg");
const lightboxCaption = document.getElementById("lightboxCaption");
const lightboxSubmeta = document.getElementById("lightboxSubmeta");
const lightboxOpenRaw = document.getElementById("lightboxOpenRaw");
const lightboxCloseBtn = document.getElementById("lightboxCloseBtn");
const lightboxPrevBtn = document.getElementById("lightboxPrevBtn");
const lightboxNextBtn = document.getElementById("lightboxNextBtn");

// State
let supabase = null;
let bucketName = "autobody-photos";
let isConfigured = false;
let loadSeq = 0;
let activeStepFilter = "all";
let loadedSections = [];
let flatPhotos = [];
let currentLightboxIndex = -1;
let touchStartX = null;

function showError(message, hint = "") {
  statusMessage.textContent = message;
  if (hint) {
    statusHint.textContent = hint;
    statusHint.hidden = false;
  } else {
    statusHint.textContent = "";
    statusHint.hidden = true;
  }
  statusBanner.hidden = false;
}

function hideError() {
  statusBanner.hidden = true;
}

/**
 * แปลงเวลาจากชื่อไฟล์รูปแบบ {jobId}_{YYYYMMDD}_{HHmmss}_{ms}.jpg เป็นข้อความอ่านง่าย
 */
function formatPhotoTimestamp(fileName) {
  const match = fileName.match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_\d+)?\.[^.]+$/);
  if (!match) {
    return "";
  }
  const [, yyyy, mm, dd, hh, min, ss] = match;
  return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
}

function getInitialJobIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("job") || params.get("jobId") || "JOB-2569-001";
  const { cleaned } = sanitizeJobId(raw);
  return cleaned || "JOB-2569-001";
}

function syncUrlQuery(jobId) {
  if (!jobId) {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("job", jobId);
  url.searchParams.delete("jobId");
  window.history.replaceState(null, "", url.toString());
}

function renderFilterPills() {
  stepFilterBar.textContent = "";

  const totalCount = loadedSections.reduce((sum, sec) => sum + sec.photos.length, 0);

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `step-pill${activeStepFilter === "all" ? " is-active" : ""}`;
  allBtn.textContent = `ทั้งหมด (${totalCount})`;
  allBtn.addEventListener("click", () => {
    activeStepFilter = "all";
    renderFilterPills();
    renderSections();
  });
  stepFilterBar.appendChild(allBtn);

  for (const sec of loadedSections) {
    const count = sec.photos.length;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      `step-pill${activeStepFilter === sec.slug ? " is-active" : ""}` +
      `${count === 0 ? " is-empty" : ""}`;
    btn.textContent = `${sec.label} (${count})`;
    btn.addEventListener("click", () => {
      activeStepFilter = sec.slug;
      renderFilterPills();
      renderSections();
    });
    stepFilterBar.appendChild(btn);
  }
}

function renderEmptyCard(title, subtitle = "", showSpinner = false) {
  sectionsContainer.textContent = "";
  const card = document.createElement("section");
  card.className = "card";

  const box = document.createElement("div");
  box.className = "gallery-empty";

  if (showSpinner) {
    const spinner = document.createElement("div");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    box.appendChild(spinner);
  }

  const p1 = document.createElement("p");
  p1.textContent = title;
  box.appendChild(p1);

  if (subtitle) {
    const p2 = document.createElement("p");
    p2.className = "gallery-empty-sub";
    p2.textContent = subtitle;
    box.appendChild(p2);
  }

  card.appendChild(box);
  sectionsContainer.appendChild(card);
}

function updateLightboxView() {
  if (currentLightboxIndex < 0 || currentLightboxIndex >= flatPhotos.length) {
    return;
  }
  const item = flatPhotos[currentLightboxIndex];
  lightboxStepBadge.textContent = item.stepLabel;
  lightboxCounter.textContent = `${currentLightboxIndex + 1} / ${flatPhotos.length}`;
  lightboxImg.src = item.url;
  lightboxImg.alt = `${item.stepLabel} - ${item.name}`;
  lightboxCaption.textContent = item.timeText ? `ถ่ายเมื่อ ${item.timeText}` : item.name;
  lightboxSubmeta.textContent = item.name;
  lightboxOpenRaw.href = item.url;

  const hasMultiple = flatPhotos.length > 1;
  lightboxPrevBtn.hidden = !hasMultiple;
  lightboxNextBtn.hidden = !hasMultiple;
}

function openLightbox(photoIndex) {
  if (photoIndex < 0 || photoIndex >= flatPhotos.length) {
    return;
  }
  currentLightboxIndex = photoIndex;
  updateLightboxView();

  if (typeof lightboxDialog.showModal === "function") {
    if (!lightboxDialog.open) {
      lightboxDialog.showModal();
    }
  } else {
    window.open(flatPhotos[photoIndex].url, "_blank", "noopener,noreferrer");
  }
}

function closeLightbox() {
  currentLightboxIndex = -1;
  lightboxImg.removeAttribute("src");
  if (lightboxDialog.open) {
    lightboxDialog.close();
  }
}

function stepLightbox(delta) {
  if (flatPhotos.length <= 1 || currentLightboxIndex < 0) {
    return;
  }
  currentLightboxIndex = (currentLightboxIndex + delta + flatPhotos.length) % flatPhotos.length;
  updateLightboxView();
}

function renderSections() {
  sectionsContainer.textContent = "";

  const visibleSections =
    activeStepFilter === "all"
      ? loadedSections.filter((sec) => sec.photos.length > 0)
      : loadedSections.filter((sec) => sec.slug === activeStepFilter);

  // สร้างลิสต์รูปเรียงตามลำดับที่แสดง เพื่อให้กดเลื่อนซ้าย/ขวาใน Lightbox ต่อเนื่องกันได้
  flatPhotos = [];
  for (const sec of visibleSections) {
    for (const p of sec.photos) {
      flatPhotos.push(p);
    }
  }

  if (visibleSections.length === 0) {
    renderEmptyCard(
      "ยังไม่มีรูปภาพสำหรับรหัสงานนี้",
      "ลองตรวจสอบรหัสงานซ่อม (Job ID) หรือรอทางอู่อัปโหลดภาพความคืบหน้า"
    );
    return;
  }

  let globalIndex = 0;
  const fragment = document.createDocumentFragment();

  for (const sec of visibleSections) {
    const card = document.createElement("section");
    card.className = "card";

    const header = document.createElement("div");
    header.className = "card-header card-header-split";

    const title = document.createElement("h2");
    title.textContent = sec.label;

    const badge = document.createElement("span");
    badge.className = "step-count-badge";
    badge.textContent = `${sec.photos.length} รูป`;

    header.appendChild(title);
    header.appendChild(badge);
    card.appendChild(header);

    if (sec.photos.length === 0) {
      const empty = document.createElement("div");
      empty.className = "gallery-empty";
      const p = document.createElement("p");
      p.textContent = "ยังไม่มีรูปภาพในขั้นตอนนี้";
      empty.appendChild(p);
      card.appendChild(empty);
      fragment.appendChild(card);
      continue;
    }

    const grid = document.createElement("div");
    grid.className = "viewer-grid";

    for (const photo of sec.photos) {
      const idx = globalIndex++;
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "viewer-tile";
      tile.addEventListener("click", () => openLightbox(idx));

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "viewer-thumb-wrap";

      const img = document.createElement("img");
      img.className = "viewer-thumb";
      img.src = photo.url;
      img.alt = `${sec.label} - ${photo.name}`;
      img.loading = "lazy";
      img.addEventListener("error", () => {
        thumbWrap.textContent = "";
        const fallback = document.createElement("div");
        fallback.className = "photo-thumb-fallback";
        fallback.textContent = "โหลดรูปไม่สำเร็จ";
        thumbWrap.appendChild(fallback);
      });

      thumbWrap.appendChild(img);
      tile.appendChild(thumbWrap);

      const meta = document.createElement("div");
      meta.className = "viewer-tile-meta";

      const label = document.createElement("span");
      label.className = "viewer-tile-time";
      label.textContent = photo.timeText || photo.name;

      meta.appendChild(label);
      tile.appendChild(meta);
      grid.appendChild(tile);
    }

    card.appendChild(grid);
    fragment.appendChild(card);
  }

  sectionsContainer.appendChild(fragment);
}

async function loadJobPhotos() {
  hideError();

  const { cleaned: jobId, hadUnsupportedChars } = sanitizeJobId(viewJobIdInput.value);
  viewJobIdHint.hidden = !hadUnsupportedChars;

  if (!isConfigured || !supabase) {
    activeJobBadge.textContent = jobId || "-";
    totalPhotoCount.textContent = "รอการตั้งค่า";
    renderEmptyCard(
      "ยังไม่ได้เชื่อมต่อ Supabase Storage",
      "กรุณาวางค่า Config ในไฟล์ supabase-config.js"
    );
    return;
  }

  if (!jobId) {
    activeJobBadge.textContent = "-";
    totalPhotoCount.textContent = "0 รูป";
    stepFilterBar.textContent = "";
    renderEmptyCard("กรุณากรอกรหัสงานซ่อม (Job ID)", "เช่น JOB-2569-001");
    return;
  }

  syncUrlQuery(jobId);
  activeJobBadge.textContent = jobId;
  totalPhotoCount.textContent = "กำลังโหลด...";
  loadJobBtn.disabled = true;

  const requestId = ++loadSeq;
  renderEmptyCard(`กำลังโหลดรูปภาพของงาน ${jobId}...`, "", true);

  try {
    const results = await Promise.all(
      REPAIR_STEPS.map(async (step) => {
        const folderPath = `jobs/${jobId}/${step.slug}`;
        const { data: items, error } = await supabase.storage.from(bucketName).list(folderPath, {
          limit: 100,
          offset: 0,
          sortBy: { column: "name", order: "desc" }
        });

        if (error) {
          throw error;
        }

        const files = (items || [])
          .filter((item) => item.id !== null && item.name !== ".emptyFolderPlaceholder")
          .sort((a, b) => b.name.localeCompare(a.name));

        const photos = files.map((fileItem) => {
          const fullPath = `${folderPath}/${fileItem.name}`;
          const { data: urlData } = supabase.storage.from(bucketName).getPublicUrl(fullPath);
          return {
            name: fileItem.name,
            fullPath,
            url: urlData.publicUrl,
            stepSlug: step.slug,
            stepLabel: step.label,
            timeText: formatPhotoTimestamp(fileItem.name)
          };
        });

        return {
          slug: step.slug,
          label: step.label,
          photos
        };
      })
    );

    if (requestId !== loadSeq) {
      return;
    }

    loadedSections = results;
    const total = results.reduce((sum, sec) => sum + sec.photos.length, 0);
    totalPhotoCount.textContent = `ทั้งหมด ${total} รูป`;

    if (activeStepFilter !== "all" && !results.some((s) => s.slug === activeStepFilter)) {
      activeStepFilter = "all";
    }

    renderFilterPills();
    renderSections();
  } catch (error) {
    if (requestId !== loadSeq) {
      return;
    }
    totalPhotoCount.textContent = "โหลดไม่สำเร็จ";
    renderEmptyCard("ไม่สามารถโหลดรูปภาพได้", "กรุณาตรวจสอบการแจ้งเตือนด้านบน");
    const { message, hint } = getSupabaseErrorDetails(error, "โหลดรูปภาพงานซ่อม", bucketName);
    showError(message, hint);
  } finally {
    if (requestId === loadSeq) {
      loadJobBtn.disabled = false;
    }
  }
}

function initViewer() {
  const initialJobId = getInitialJobIdFromUrl();
  viewJobIdInput.value = initialJobId;
  activeJobBadge.textContent = initialJobId;

  if (isPlaceholderConfig(supabaseConfig)) {
    isConfigured = false;
    configWarningBanner.hidden = false;
  } else {
    try {
      bucketName = supabaseConfig.bucketName.trim();
      supabase = createStorageClient(supabaseConfig);
      isConfigured = true;
      configWarningBanner.hidden = true;
    } catch (error) {
      isConfigured = false;
      configWarningBanner.hidden = false;
      showError(
        `ไม่สามารถเริ่มต้นการเชื่อมต่อ Supabase ได้: ${error?.message || "Config ไม่ถูกต้อง"}`,
        "กรุณาตรวจสอบค่าในไฟล์ supabase-config.js"
      );
    }
  }

  lookupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    activeStepFilter = "all";
    loadJobPhotos();
  });

  // Lightbox Events
  lightboxCloseBtn.addEventListener("click", closeLightbox);
  lightboxPrevBtn.addEventListener("click", () => stepLightbox(-1));
  lightboxNextBtn.addEventListener("click", () => stepLightbox(1));

  lightboxDialog.addEventListener("cancel", () => {
    currentLightboxIndex = -1;
  });

  lightboxDialog.addEventListener("click", (event) => {
    if (event.target === lightboxDialog || event.target === lightboxStage) {
      closeLightbox();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!lightboxDialog.open) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepLightbox(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      stepLightbox(1);
    }
  });

  // รองรับปัดซ้าย-ขวาบนมือถือใน Lightbox
  lightboxStage.addEventListener(
    "touchstart",
    (event) => {
      touchStartX = event.touches?.[0]?.clientX ?? null;
    },
    { passive: true }
  );

  lightboxStage.addEventListener(
    "touchend",
    (event) => {
      if (touchStartX === null) {
        return;
      }
      const endX = event.changedTouches?.[0]?.clientX ?? touchStartX;
      const diff = endX - touchStartX;
      touchStartX = null;

      if (Math.abs(diff) > 45) {
        stepLightbox(diff > 0 ? -1 : 1);
      }
    },
    { passive: true }
  );

  loadJobPhotos();
}

initViewer();

