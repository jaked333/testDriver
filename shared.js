import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

export const REPAIR_STEPS = [
  { slug: "00_claim", label: "00_เอกสารเคลม" },
  { slug: "01_before", label: "01_ก่อนซ่อม" },
  { slug: "02_bodywork", label: "02_รื้อและเคาะ" },
  { slug: "03_paint", label: "03_พ่นสี" },
  { slug: "04_qc", label: "04_ตรวจQC" }
];

const REQUIRED_CONFIG_KEYS = ["supabaseUrl", "supabaseAnonKey", "bucketName"];

/**
 * ตรวจสอบว่า supabaseConfig ยังเป็นค่าตัวอย่าง (placeholder) อยู่หรือไม่
 */
export function isPlaceholderConfig(config) {
  if (!config || typeof config !== "object") {
    return true;
  }
  const hasInvalidField = REQUIRED_CONFIG_KEYS.some((key) => {
    const value = config[key];
    if (typeof value !== "string") {
      return true;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return true;
    }
    const upper = trimmed.toUpperCase();
    return (
      upper.includes("YOUR_") ||
      upper.includes("REPLACE_") ||
      upper.includes("PASTE_") ||
      upper.includes("PLACEHOLDER") ||
      trimmed.includes("<") ||
      trimmed.includes(">")
    );
  });

  if (hasInvalidField) {
    return true;
  }

  const url = config.supabaseUrl.trim();
  return !url.startsWith("https://") && !url.startsWith("http://");
}

/**
 * ทำความสะอาด Job ID ให้รองรับกฎชื่อ key ของ Supabase Storage (เฉพาะ ASCII)
 */
export function sanitizeJobId(rawValue) {
  const trimmed = String(rawValue || "").trim();
  const hadUnsupportedChars =
    trimmed.length > 0 && /[^A-Za-z0-9._\-\s/\\]/.test(trimmed);

  const cleaned = trimmed
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  return { cleaned, hadUnsupportedChars };
}

/**
 * สร้าง Supabase client โดยสามารถส่ง custom fetch เพื่อติดตามความคืบหน้าได้
 */
export function createStorageClient(config, customFetch) {
  const options = customFetch ? { global: { fetch: customFetch } } : undefined;
  return createClient(config.supabaseUrl.trim(), config.supabaseAnonKey.trim(), options);
}

/**
 * แปลง Supabase Storage Error เป็นข้อความภาษาไทยที่เข้าใจง่าย
 */
export function getSupabaseErrorDetails(error, actionLabel, bucketName) {
  const rawMsg = error?.message || "";
  const msg = rawMsg.toLowerCase();
  const status = String(error?.statusCode || error?.status || "");

  if (error?.name === "AbortError" || msg.includes("aborted")) {
    return {
      message: "ยกเลิกการอัปโหลดเรียบร้อยแล้ว",
      hint: ""
    };
  }

  if (rawMsg === "RLS_DELETE_DENIED") {
    return {
      message: "ไม่สามารถลบรูปภาพได้ (ติดสิทธิ์ RLS Policy ของ Supabase Storage)",
      hint: `คำแนะนำ: กรุณาไปที่ Supabase -> SQL Editor แล้วรัน SQL เพิ่ม Policy แบบ FOR DELETE TO anon บน storage.objects สำหรับ bucket "${bucketName}" (ดูโค้ดใน README.md)`
    };
  }

  if (msg.includes("bucket not found") || status === "404") {
    return {
      message: `ไม่พบ Storage Bucket ชื่อ "${bucketName}" ในโปรเจกต์ Supabase`,
      hint: `คำแนะนำ: กรุณาไปที่ Supabase -> Storage -> กด New bucket ตั้งชื่อ "${bucketName}" และติ๊กเปิด "Public bucket" (หรือแก้ชื่อ bucketName ใน supabase-config.js ให้ตรงกัน)`
    };
  }

  if (
    msg.includes("row-level security") ||
    msg.includes("unauthorized") ||
    msg.includes("permission") ||
    status === "403" ||
    status === "401"
  ) {
    return {
      message: `ไม่มีสิทธิ์เข้าถึง Supabase Storage ระหว่าง${actionLabel} (${status || "RLS Policy"})`,
      hint: `คำแนะนำ: กรุณาตรวจสอบค่า supabaseAnonKey ในไฟล์ supabase-config.js และตรวจสอบว่าได้สร้าง RLS Policies (INSERT, SELECT, DELETE สำหรับ anon) บน storage.objects ใน Supabase SQL Editor แล้ว (ดูโค้ดใน README.md)`
    };
  }

  if (msg.includes("invalidkey") || msg.includes("invalid key")) {
    return {
      message: "ชื่อโฟลเดอร์หรือชื่อไฟล์มีอักขระที่ Supabase ไม่รองรับ (InvalidKey)",
      hint: "กรุณาใช้ตัวอักษรภาษาอังกฤษ ตัวเลข หรือเครื่องหมาย - _ ในช่อง Job ID"
    };
  }

  if (msg.includes("failed to fetch") || msg.includes("network")) {
    return {
      message: `เชื่อมต่อ Supabase ไม่สำเร็จระหว่าง${actionLabel}`,
      hint: "กรุณาตรวจสอบอินเทอร์เน็ต และตรวจสอบว่า supabaseUrl ใน supabase-config.js ถูกต้อง รวมถึงโปรเจกต์ Supabase ไม่ได้อยู่ในสถานะ Paused"
    };
  }

  return {
    message: `เกิดข้อผิดพลาดระหว่าง${actionLabel}: ${rawMsg || "ไม่ทราบสาเหตุ"}`,
    hint: status ? `รหัสสถานะ: ${status}` : "ตรวจสอบการตั้งค่าใน supabase-config.js และ Storage Policies"
  };
}

