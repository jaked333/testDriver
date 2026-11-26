/**
 * การตั้งค่า Supabase Storage (ฟรี 1 GB ไม่ต้องผูกบัตร)
 *
 * วิธีใช้งาน:
 * 1. เข้าไปที่ Supabase Dashboard -> Project Settings -> API (หรือ Data API / API Keys)
 * 2. คัดลอก Project URL และ Publishable Key (หรือ anon public key) มาวางด้านล่าง
 * 3. สร้าง Storage Bucket ชื่อเดียวกับ bucketName (ค่าเริ่มต้น: "autobody-photos")
 *    และตั้งค่า Bucket เป็น Public พร้อมเพิ่ม RLS Policy (ดูตัวอย่าง SQL ใน README.md)
 */
export const supabaseConfig = {
  supabaseUrl: "https://ooizhgufptjmgxkkhmpt.supabase.co",
  supabaseAnonKey: "sb_publishable_5___PIspqOWyftLgpc4jwg_bREOiSrp",
  bucketName: "autobody-photos"
};

