import { supabaseConfig } from "./supabase-config.js";
import {
  createStorageClient,
  getSupabaseErrorDetails,
  isPlaceholderConfig,
  sanitizeJobId
} from "./shared.js";

const MAX_IMAGE_WIDTH = 1280;
const JPEG_QUALITY = 0.8;

// DOM Elements
const configWarningBanner = document.getElementById("configWarningBanner");
const statusBanner = document.getElementById("statusBanner");
const statusIcon = document.getElementById("statusIcon");
const statusMessage = document.getElementById("statusMessage");
const statusHint = document.getElementById("statusHint");
const closeStatusBtn = document.getElementById("closeStatusBtn");

const headerViewerLink = document.getElementById("headerViewerLink");
const jobIdInput = document.getElementById("jobIdInput");
const jobIdHint = document.getElementById("jobIdHint");
const stepSelect = document.getElementById("stepSelect");
const activeFolderPath = document.getElementById("activeFolderPath");
const openCustomerViewLink = document.getElementById("openCustomerViewLink");
const copyCustomerLinkBtn = document.getElementById("copyCustomerLinkBtn");
const photoInput = document.getElementById("photoInput");
const captureLabel = document.getElementById("captureLabel");
const autoUploadToggle = document.getElementById("autoUploadToggle");

const previewCard = document.getElementById("previewCard");
const previewImage = document.getElementById("previewImage");
const previewFileName = document.getElementById("previewFileName");
const previewMeta = document.getElementById("previewMeta");
const uploadNowBtn = document.getElementById("uploadNowBtn");
const clearPreviewBtn = document.getElementById("clearPreviewBtn");

const progressContainer = document.getElementById("progressContainer");
const progressLabel = document.getElementById("progressLabel");
const progressPercent = document.getElementById("progressPercent");
const progressTrack = document.getElementById("progressTrack");
const progressFill = document.getElementById("progressFill");
const progressBytes = document.getElementById("progressBytes");
const cancelUploadBtn = document.getElementById("cancelUploadBtn");

const refreshGalleryBtn = document.getElementById("refreshGalleryBtn");
const galleryCount = document.getElementById("galleryCount");
const galleryContainer = document.getElementById("galleryContainer");

const deleteDialog = document.getElementById("deleteDialog");
const deletePreviewImg = document.getElementById("deletePreviewImg");
const deleteFileName = document.getElementById("deleteFileName");
const cancelDeleteBtn = document.getElementById("cancelDeleteBtn");
const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");

// Application State
let supabase = null;
let bucketName = "autobody-photos";
let isConfigured = false;
let pendingUpload = null;
let activeUploadController = null;
let activeUploadProgress = null;
let galleryRequestSeq = 0;
let jobIdDebounceTimer = null;
let pendingDeleteItem = null;

function parseXhrHeaders(rawHeaders) {
  const headers = new Headers();
  if (!rawHeaders) {
    return headers;
  }
  for (const line of rawHeaders.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const name = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (name) {
        headers.append(name, val);
      }
    }
  }
  return headers;
}

function isXhrSendableBody(body) {
  return (
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    typeof body === "string"
  );
}

/**
 * Custom fetch สำหรับ @supabase/supabase-js เพื่อรองรับตัววัด % ความคืบหน้าการอัปโหลดผ่าน XMLHttpRequest
 * โดยยังคงใช้ URL และ Header ที่ถูกต้องจาก Supabase SDK (รองรับทั้ง anon JWT และ sb_publishable_...)
 */
function uploadProgressFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input?.url || "";
  const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = init.body;

  const shouldTrackProgress =
    activeUploadProgress &&
    method === "POST" &&
    url.includes("/storage/v1/object/") &&
    isXhrSendableBody(body);

  if (!shouldTrackProgress) {
    return window.fetch(input, init);
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const progressState = activeUploadProgress;
    const signal = init.signal || progressState.signal;

    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const onAbort = () => {
      xhr.abort();
      reject(new DOMException("Aborted", "AbortError"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    xhr.open(method, url, true);
    xhr.responseType = "arraybuffer";

    const mergedHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    if (init.headers) {
      new Headers(init.headers).forEach((value, key) => {
        mergedHeaders.set(key, value);
      });
    }
    if (body instanceof FormData) {
      // ให้เบราว์เซอร์กำหนด multipart boundary เองอัตโนมัติ
      mergedHeaders.delete("content-type");
    }

    mergedHeaders.forEach((value, key) => {
      try {
        xhr.setRequestHeader(key, value);
      } catch {
        // ข้าม forbidden header ที่เบราว์เซอร์จัดการเอง
      }
    });

    xhr.upload.onprogress = (event) => {
      const total =
        event.lengthComputable && event.total > 0
          ? event.total
          : progressState.expectedTotalBytes;
      progressState.onProgress(event.loaded, total);
    };

    xhr.onload = () => {
      cleanup();
      const responseHeaders = parseXhrHeaders(xhr.getAllResponseHeaders());
      const responseBody = xhr.status === 204 || xhr.status === 304 ? null : xhr.response;
      resolve(
        new Response(responseBody, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: responseHeaders
        })
      );
    };

    xhr.onerror = () => {
      cleanup();
      reject(new TypeError("Failed to fetch"));
    };

    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    xhr.send(body);
  });
}

function getSelectedJobId() {
  const { cleaned, hadUnsupportedChars } = sanitizeJobId(jobIdInput.value);
  jobIdHint.hidden = !hadUnsupportedChars;
  return cleaned;
}

function getSelectedStep() {
  return stepSelect.value;
}

function getFolderPath(jobId, stepSlug) {
  if (!jobId) {
    return "";
  }
  return `jobs/${jobId}/${stepSlug}`;
}

function getCustomerViewUrl(jobId) {
  const target = jobId ? `./view.html?job=${encodeURIComponent(jobId)}` : "./view.html";
  return new URL(target, window.location.href).href;
}

function updateActivePathDisplay() {
  const jobId = getSelectedJobId();
  const stepSlug = getSelectedStep();
  const folderPath = getFolderPath(jobId, stepSlug);
  activeFolderPath.textContent = folderPath || "กรุณาระบุ Job ID (A-Z, 0-9, -, _)";

  const viewerHref = jobId ? `./view.html?job=${encodeURIComponent(jobId)}` : "./view.html";
  openCustomerViewLink.href = viewerHref;
  headerViewerLink.href = viewerHref;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(2)} MB`;
}

function formatTimestamp(date = new Date()) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(n).padStart(3, "0");
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  const ms = pad3(date.getMilliseconds());
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}_${ms}`;
}

/**
 * แสดงแถบสถานะ / แจ้งเตือนข้อผิดพลาดภาษาไทย
 */
function showStatus(type, message, hint = "") {
  const styles = {
    info: { cls: "banner banner-info", icon: "ℹ️" },
    success: { cls: "banner banner-success", icon: "✅" },
    warning: { cls: "banner banner-warning", icon: "⚠️" },
    error: { cls: "banner banner-error", icon: "❌" }
  };
  const selected = styles[type] || styles.info;

  statusBanner.className = selected.cls;
  statusIcon.textContent = selected.icon;
  statusMessage.textContent = message;

  if (hint) {
    statusHint.textContent = hint;
    statusHint.hidden = false;
  } else {
    statusHint.textContent = "";
    statusHint.hidden = true;
  }

  statusBanner.hidden = false;

  if (type === "error" || type === "warning") {
    statusBanner.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function hideStatus() {
  statusBanner.hidden = true;
}

function setUploadingUi(isUploading) {
  photoInput.disabled = isUploading;
  captureLabel.classList.toggle("is-disabled", isUploading);
  uploadNowBtn.disabled = isUploading;
  clearPreviewBtn.disabled = isUploading;
  jobIdInput.disabled = isUploading;
  stepSelect.disabled = isUploading;
}

function clearPendingUpload() {
  if (pendingUpload?.previewUrl) {
    URL.revokeObjectURL(pendingUpload.previewUrl);
  }
  pendingUpload = null;
  previewImage.removeAttribute("src");
  previewFileName.textContent = "-";
  previewMeta.textContent = "-";
  previewCard.hidden = true;
}

function resetProgressUi() {
  progressContainer.hidden = true;
  progressFill.style.width = "0%";
  progressPercent.textContent = "0%";
  progressTrack.setAttribute("aria-valuenow", "0");
  progressBytes.textContent = "0 KB / 0 KB";
  progressLabel.textContent = "กำลังอัปโหลด...";
}

/**
 * ย่อขนาดและบีบอัดรูปภาพฝั่ง Client ด้วย HTML5 Canvas
 * - ความกว้างสูงสุด 1280px (คงสัดส่วนเดิม และไม่ขยายภาพเล็กให้ใหญ่ขึ้น)
 * - แปลงเป็น JPEG quality 0.8
 */
function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      try {
        const origWidth = img.naturalWidth;
        const origHeight = img.naturalHeight;

        if (!origWidth || !origHeight) {
          URL.revokeObjectURL(objectUrl);
          reject(new Error("ไม่สามารถอ่านขนาดของรูปภาพได้"));
          return;
        }

        let targetWidth = origWidth;
        let targetHeight = origHeight;

        if (targetWidth > MAX_IMAGE_WIDTH) {
          targetHeight = Math.round((origHeight * MAX_IMAGE_WIDTH) / targetWidth);
          targetWidth = MAX_IMAGE_WIDTH;
        }

        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(objectUrl);
          reject(new Error("เบราว์เซอร์ไม่รองรับการประมวลผลภาพ Canvas 2D"));
          return;
        }

        // เติมพื้นหลังสีขาวเผื่อกรณีไฟล์ต้นฉบับเป็น PNG โปร่งใสก่อนแปลงเป็น JPEG
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, targetWidth, targetHeight);
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(objectUrl);
            canvas.width = 0;
            canvas.height = 0;

            if (!blob) {
              reject(new Error("ไม่สามารถบีบอัดรูปภาพเป็นไฟล์ JPEG ได้"));
              return;
            }

            resolve({
              blob,
              width: targetWidth,
              height: targetHeight,
              originalWidth: origWidth,
              originalHeight: origHeight,
              originalSize: file.size,
              compressedSize: blob.size
            });
          },
          "image/jpeg",
          JPEG_QUALITY
        );
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        reject(err);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(
        new Error("ไม่สามารถอ่านไฟล์รูปภาพนี้ได้ กรุณาเลือกไฟล์ภาพที่รองรับ (เช่น JPG, PNG, WebP)")
      );
    };

    img.src = objectUrl;
  });
}

function showCompressedPreview(item, jobId) {
  const previewUrl = URL.createObjectURL(item.blob);
  item.previewUrl = previewUrl;

  const savedPercent =
    item.originalSize > 0
      ? Math.max(
          0,
          Math.round(((item.originalSize - item.compressedSize) / item.originalSize) * 100)
        )
      : 0;

  previewImage.src = previewUrl;
  previewFileName.textContent = `${jobId || "JOB"}_[timestamp].jpg`;
  previewMeta.textContent =
    `ขนาด ${item.width}×${item.height} px • ` +
    `${formatBytes(item.originalSize)} → ${formatBytes(item.compressedSize)} ` +
    `(ลดลง ${savedPercent}%)`;
  previewCard.hidden = false;
}

/**
 * อัปโหลดไฟล์ที่บีบอัดแล้วไปยัง Supabase Storage พร้อมแสดงแถบความคืบหน้า (%)
 */
async function startUpload(uploadItem) {
  if (!isConfigured || !supabase) {
    showStatus(
      "warning",
      "ยังไม่สามารถอัปโหลดได้ เนื่องจากยังไม่ได้ตั้งค่า Supabase Config",
      "กรุณาใส่ค่า Config ในไฟล์ supabase-config.js แล้วรีเฟรชหน้าเว็บ"
    );
    return;
  }

  const jobId = getSelectedJobId();
  const stepSlug = getSelectedStep();

  if (!jobId) {
    showStatus(
      "error",
      "กรุณากรอกรหัสงานซ่อม (Job ID) เป็นภาษาอังกฤษหรือตัวเลขก่อนอัปโหลดรูปภาพ"
    );
    jobIdInput.focus();
    return;
  }

  if (activeUploadController) {
    showStatus("warning", "กำลังอัปโหลดไฟล์อื่นอยู่ กรุณารอสักครู่");
    return;
  }

  const timestamp = formatTimestamp();
  const fileName = `${jobId}_${timestamp}.jpg`;
  const storagePath = `jobs/${jobId}/${stepSlug}/${fileName}`;

  previewFileName.textContent = fileName;
  progressContainer.hidden = false;
  progressLabel.textContent = `กำลังอัปโหลด ${fileName}...`;
  progressPercent.textContent = "0%";
  progressTrack.setAttribute("aria-valuenow", "0");
  progressFill.style.width = "0%";
  progressBytes.textContent = `0 KB / ${formatBytes(uploadItem.blob.size)}`;

  const controller = new AbortController();
  activeUploadController = controller;
  activeUploadProgress = {
    expectedTotalBytes: uploadItem.blob.size || 1,
    signal: controller.signal,
    onProgress: (loaded, total) => {
      const safeTotal = total || uploadItem.blob.size || 1;
      const pct = Math.min(100, Math.round((loaded / safeTotal) * 100));
      progressFill.style.width = `${pct}%`;
      progressPercent.textContent = `${pct}%`;
      progressTrack.setAttribute("aria-valuenow", String(pct));
      progressBytes.textContent = `${formatBytes(Math.min(loaded, safeTotal))} / ${formatBytes(safeTotal)}`;
    }
  };

  setUploadingUi(true);

  try {
    const { error } = await supabase.storage
      .from(bucketName)
      .upload(storagePath, uploadItem.blob, {
        contentType: "image/jpeg",
        cacheControl: "3600",
        upsert: false,
        signal: controller.signal
      });

    if (error) {
      throw error;
    }

    activeUploadController = null;
    activeUploadProgress = null;
    setUploadingUi(false);
    resetProgressUi();
    clearPendingUpload();

    showStatus("success", `อัปโหลดรูปภาพสำเร็จ: ${fileName}`);
    await loadGallery();
  } catch (error) {
    activeUploadController = null;
    activeUploadProgress = null;
    setUploadingUi(false);
    resetProgressUi();

    if (error?.name === "AbortError" || error?.message?.toLowerCase().includes("aborted")) {
      showStatus("info", "ยกเลิกการอัปโหลดเรียบร้อยแล้ว สามารถกดอัปโหลดใหม่ได้");
      return;
    }

    const { message, hint } = getSupabaseErrorDetails(error, "อัปโหลดรูปภาพ", bucketName);
    showStatus("error", message, hint);
  }
}

/**
 * จัดการเมื่อผู้ใช้ถ่ายรูปหรือเลือกรูปภาพจากอุปกรณ์
 */
async function handlePhotoSelected(event) {
  const file = event.target.files?.[0];
  photoInput.value = "";

  if (!file) {
    return;
  }

  if (activeUploadController) {
    showStatus("warning", "กำลังอัปโหลดรูปภาพก่อนหน้าอยู่ กรุณารอให้เสร็จก่อนถ่ายรูปถัดไป");
    return;
  }

  clearPendingUpload();
  showStatus("info", "กำลังย่อขนาดและบีบอัดรูปภาพ (สูงสุด 1280px)...");

  try {
    const compressed = await compressImageFile(file);
    pendingUpload = compressed;
    const jobId = getSelectedJobId();
    showCompressedPreview(compressed, jobId);

    if (!isConfigured) {
      showStatus(
        "warning",
        "บีบอัดรูปภาพสำเร็จ แต่ยังไม่ได้ตั้งค่า Supabase Config",
        "กรุณาวางค่า Config ในไฟล์ supabase-config.js ก่อน จึงจะสามารถอัปโหลดขึ้น Supabase Storage ได้"
      );
      return;
    }

    if (!jobId) {
      showStatus(
        "error",
        "บีบอัดรูปภาพสำเร็จแล้ว กรุณากรอกรหัสงานซ่อม (Job ID) เป็นภาษาอังกฤษหรือตัวเลขก่อนกดอัปโหลด"
      );
      jobIdInput.focus();
      return;
    }

    if (autoUploadToggle.checked) {
      await startUpload(pendingUpload);
    } else {
      showStatus("info", "บีบอัดรูปภาพพร้อมแล้ว กดปุ่ม \"อัปโหลดรูปภาพ\" เพื่อส่งขึ้น Supabase");
    }
  } catch (err) {
    clearPendingUpload();
    showStatus("error", err?.message || "เกิดข้อผิดพลาดระหว่างประมวลผลรูปภาพ");
  }
}

function renderGalleryMessage(title, subtitle = "", showSpinner = false) {
  galleryContainer.textContent = "";
  const box = document.createElement("div");
  box.className = "gallery-empty";

  if (showSpinner) {
    const spinner = document.createElement("div");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    box.appendChild(spinner);
  }

  const titleEl = document.createElement("p");
  titleEl.textContent = title;
  box.appendChild(titleEl);

  if (subtitle) {
    const subEl = document.createElement("p");
    subEl.className = "gallery-empty-sub";
    subEl.textContent = subtitle;
    box.appendChild(subEl);
  }

  galleryContainer.appendChild(box);
}

function createPhotoCard(item) {
  const card = document.createElement("article");
  card.className = "photo-card";

  const thumbLink = document.createElement("a");
  thumbLink.className = "photo-thumb-link";
  thumbLink.href = item.url;
  thumbLink.target = "_blank";
  thumbLink.rel = "noopener noreferrer";
  thumbLink.title = `เปิดดู ${item.name}`;

  const img = document.createElement("img");
  img.className = "photo-thumb";
  img.src = item.url;
  img.alt = item.name;
  img.loading = "lazy";
  img.addEventListener("error", () => {
    thumbLink.textContent = "";
    const fallback = document.createElement("div");
    fallback.className = "photo-thumb-fallback";
    fallback.textContent = "ไม่สามารถแสดงภาพได้ (ตรวจสอบว่าตั้งค่า Public bucket แล้ว)";
    thumbLink.appendChild(fallback);
  });

  thumbLink.appendChild(img);
  card.appendChild(thumbLink);

  const body = document.createElement("div");
  body.className = "photo-body";

  const nameEl = document.createElement("p");
  nameEl.className = "photo-name";
  nameEl.textContent = item.name;
  body.appendChild(nameEl);

  const actions = document.createElement("div");
  actions.className = "photo-actions";

  const openLink = document.createElement("a");
  openLink.className = "btn btn-secondary";
  openLink.href = item.url;
  openLink.target = "_blank";
  openLink.rel = "noopener noreferrer";
  openLink.textContent = "เปิดดู / ดาวน์โหลด";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn btn-danger-outline";
  deleteBtn.textContent = "ลบรูป";
  deleteBtn.addEventListener("click", () => {
    openDeleteDialog(item);
  });

  actions.appendChild(openLink);
  actions.appendChild(deleteBtn);
  body.appendChild(actions);
  card.appendChild(body);

  return card;
}

/**
 * โหลดรายการรูปภาพทั้งหมดในโฟลเดอร์ jobs/{jobId}/{stepSlug}
 */
async function loadGallery() {
  updateActivePathDisplay();

  if (!isConfigured || !supabase) {
    galleryCount.textContent = "รอการตั้งค่า Supabase";
    renderGalleryMessage(
      "ยังไม่ได้เชื่อมต่อ Supabase Storage",
      "กรุณาวางค่า Config ในไฟล์ supabase-config.js แล้วรีเฟรชหน้าเว็บ"
    );
    return;
  }

  const jobId = getSelectedJobId();
  const stepSlug = getSelectedStep();
  const folderPath = getFolderPath(jobId, stepSlug);

  if (!jobId) {
    galleryCount.textContent = "กรุณาระบุ Job ID";
    renderGalleryMessage(
      "กรุณากรอกรหัสงานซ่อม (Job ID)",
      "รองรับตัวอักษรภาษาอังกฤษ ตัวเลข และเครื่องหมาย - _ (เช่น JOB-2569-001)"
    );
    return;
  }

  const requestId = ++galleryRequestSeq;
  refreshGalleryBtn.disabled = true;
  galleryCount.textContent = "กำลังโหลด...";
  renderGalleryMessage(`กำลังโหลดรูปภาพใน ${folderPath}...`, "", true);

  try {
    const { data: items, error } = await supabase.storage.from(bucketName).list(folderPath, {
      limit: 100,
      offset: 0,
      sortBy: { column: "name", order: "desc" }
    });

    if (requestId !== galleryRequestSeq) {
      return;
    }

    if (error) {
      throw error;
    }

    // กรองโฟลเดอร์ย่อย (id === null) และไฟล์ placeholder ของ Supabase ออก
    const files = (items || [])
      .filter((item) => item.id !== null && item.name !== ".emptyFolderPlaceholder")
      .sort((a, b) => b.name.localeCompare(a.name));

    if (files.length === 0) {
      galleryCount.textContent = "พบทั้งหมด 0 รูป";
      renderGalleryMessage(
        "ยังไม่มีรูปภาพในโฟลเดอร์นี้",
        `ถ่ายรูปหรือเลือกรูปเพื่ออัปโหลดเข้าโฟลเดอร์ ${folderPath}`
      );
      return;
    }

    galleryContainer.textContent = "";
    galleryCount.textContent = `พบทั้งหมด ${files.length} รูป`;

    const fragment = document.createDocumentFragment();
    for (const fileItem of files) {
      const fullPath = `${folderPath}/${fileItem.name}`;
      const { data: urlData } = supabase.storage.from(bucketName).getPublicUrl(fullPath);

      fragment.appendChild(
        createPhotoCard({
          name: fileItem.name,
          fullPath,
          url: urlData.publicUrl
        })
      );
    }
    galleryContainer.appendChild(fragment);
  } catch (error) {
    if (requestId !== galleryRequestSeq) {
      return;
    }
    galleryCount.textContent = "โหลดข้อมูลไม่สำเร็จ";
    renderGalleryMessage("ไม่สามารถโหลดรูปภาพในโฟลเดอร์นี้ได้", "ตรวจสอบการแจ้งเตือนด้านบน");
    const { message, hint } = getSupabaseErrorDetails(error, "โหลดรายการรูปภาพ", bucketName);
    showStatus("error", message, hint);
  } finally {
    if (requestId === galleryRequestSeq) {
      refreshGalleryBtn.disabled = false;
    }
  }
}

function openDeleteDialog(item) {
  pendingDeleteItem = item;
  deleteFileName.textContent = item.name;
  deletePreviewImg.src = item.url;
  deletePreviewImg.alt = item.name;

  if (typeof deleteDialog.showModal === "function") {
    deleteDialog.showModal();
  } else if (window.confirm(`ยืนยันการลบรูปภาพ "${item.name}" ออกจาก Supabase Storage หรือไม่?`)) {
    executeDelete();
  }
}

function closeDeleteDialog() {
  pendingDeleteItem = null;
  deletePreviewImg.removeAttribute("src");
  if (deleteDialog.open) {
    deleteDialog.close();
  }
}

async function executeDelete() {
  if (!pendingDeleteItem || !supabase) {
    return;
  }

  const target = pendingDeleteItem;
  confirmDeleteBtn.disabled = true;
  cancelDeleteBtn.disabled = true;
  confirmDeleteBtn.textContent = "กำลังลบ...";

  try {
    const { data, error } = await supabase.storage.from(bucketName).remove([target.fullPath]);

    if (error) {
      throw error;
    }

    // ถ้าไม่มีสิทธิ์ DELETE ใน RLS Policy, Supabase อาจคืนค่า data เป็น [] โดยไม่ throw error
    if (!data || data.length === 0) {
      throw new Error("RLS_DELETE_DENIED");
    }

    closeDeleteDialog();
    showStatus("success", `ลบรูปภาพ "${target.name}" เรียบร้อยแล้ว`);
    await loadGallery();
  } catch (error) {
    closeDeleteDialog();
    const { message, hint } = getSupabaseErrorDetails(error, "ลบรูปภาพ", bucketName);
    showStatus("error", message, hint);
  } finally {
    confirmDeleteBtn.disabled = false;
    cancelDeleteBtn.disabled = false;
    confirmDeleteBtn.textContent = "ยืนยันลบรูป";
  }
}

function scheduleGalleryReload() {
  updateActivePathDisplay();
  if (jobIdDebounceTimer) {
    clearTimeout(jobIdDebounceTimer);
  }
  jobIdDebounceTimer = setTimeout(() => {
    jobIdDebounceTimer = null;
    loadGallery();
  }, 450);
}

function initApp() {
  updateActivePathDisplay();

  if (isPlaceholderConfig(supabaseConfig)) {
    isConfigured = false;
    configWarningBanner.hidden = false;
  } else {
    try {
      bucketName = supabaseConfig.bucketName.trim();
      supabase = createStorageClient(supabaseConfig, uploadProgressFetch);
      isConfigured = true;
      configWarningBanner.hidden = true;
    } catch (error) {
      isConfigured = false;
      configWarningBanner.hidden = false;
      showStatus(
        "error",
        `ไม่สามารถเริ่มต้นการเชื่อมต่อ Supabase ได้: ${error?.message || "Config ไม่ถูกต้อง"}`,
        "กรุณาตรวจสอบค่าในไฟล์ supabase-config.js ให้ครบถ้วนและถูกต้อง"
      );
    }
  }

  // Event Listeners
  jobIdInput.addEventListener("input", scheduleGalleryReload);
  jobIdInput.addEventListener("change", () => {
    if (jobIdDebounceTimer) {
      clearTimeout(jobIdDebounceTimer);
      jobIdDebounceTimer = null;
    }
    loadGallery();
  });
  jobIdInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (jobIdDebounceTimer) {
        clearTimeout(jobIdDebounceTimer);
        jobIdDebounceTimer = null;
      }
      loadGallery();
    }
  });

  stepSelect.addEventListener("change", () => {
    updateActivePathDisplay();
    loadGallery();
  });

  refreshGalleryBtn.addEventListener("click", () => {
    loadGallery();
  });

  photoInput.addEventListener("change", handlePhotoSelected);

  uploadNowBtn.addEventListener("click", () => {
    if (pendingUpload) {
      startUpload(pendingUpload);
    }
  });

  clearPreviewBtn.addEventListener("click", () => {
    clearPendingUpload();
    hideStatus();
  });

  cancelUploadBtn.addEventListener("click", () => {
    if (activeUploadController) {
      activeUploadController.abort();
    }
  });

  closeStatusBtn.addEventListener("click", hideStatus);

  copyCustomerLinkBtn.addEventListener("click", async () => {
    const jobId = getSelectedJobId();
    if (!jobId) {
      showStatus("error", "กรุณากรอกรหัสงานซ่อม (Job ID) ก่อนคัดลอกลิงก์");
      jobIdInput.focus();
      return;
    }
    const shareUrl = getCustomerViewUrl(jobId);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        showStatus("success", `คัดลอกลิงก์หน้าแสดงรูปสำหรับงาน ${jobId} แล้ว`, shareUrl);
      } else {
        window.prompt("คัดลอกลิงก์นี้ส่งให้ลูกค้า:", shareUrl);
      }
    } catch {
      window.prompt("คัดลอกลิงก์นี้ส่งให้ลูกค้า:", shareUrl);
    }
  });

  cancelDeleteBtn.addEventListener("click", closeDeleteDialog);
  confirmDeleteBtn.addEventListener("click", executeDelete);
  deleteDialog.addEventListener("cancel", () => {
    pendingDeleteItem = null;
  });
  deleteDialog.addEventListener("click", (event) => {
    if (event.target === deleteDialog && !confirmDeleteBtn.disabled) {
      closeDeleteDialog();
    }
  });

  loadGallery();
}

initApp();
