# ทดสอบระบบถ่ายและอัปโหลดรูปภาพงานซ่อมรถขึ้น Supabase Storage

เว็บแอปแบบ Static (HTML + CSS + JavaScript ES Modules) สำหรับทดสอบถ่ายรูปจากกล้องมือถือ ย่อขนาดฝั่ง Client ด้วย Canvas (`ความกว้างสูงสุด 1280px`, `JPEG quality 0.8`) และอัปโหลดขึ้น **Supabase Storage** โดยตรง (**ฟรี 1 GB ไม่ต้องผูกบัตร**) พร้อมแสดงแกลเลอรี เปิดดู/ดาวน์โหลด และลบรูปได้ทันที (Deploy บน GitHub Pages ได้เลยโดยไม่ต้อง Build)

---

## โครงสร้างไฟล์

- `index.html` — หน้าเว็บหลักสำหรับมือถือ (Mobile-first UI ภาษาไทย)
- `style.css` — สไตล์การ์ดและเลย์เอาต์ Responsive
- `app.js` — โลจิกการย่อขนาดภาพ อัปโหลดพร้อมตัววัด % (`XMLHttpRequest` + Supabase SDK v2), โหลดรายการภาพ (`list`, `getPublicUrl`) และลบภาพ (`remove`)
- `supabase-config.js` — ไฟล์สำหรับวางค่า URL, Key และชื่อ Bucket ของ Supabase
- `README.md` — คู่มือการตั้งค่าและ Deploy

โครงสร้างโฟลเดอร์ที่ถูกจัดเก็บบน Supabase Storage (ใช้ชื่อโฟลเดอร์ภาษาอังกฤษเพื่อให้ผ่านกฎคีย์ของ Storage):

```text
jobs/{jobId}/{stepSlug}/{jobId}_{timestamp}.jpg
```

---

## คู่มือการตั้งค่าและใช้งาน (ฟรี ไม่ต้องผูกบัตร)

### 1. สมัคร Supabase และสร้างโปรเจกต์

1. เข้าไปที่ [Supabase](https://supabase.com/) แล้วกด **Start your project** (ล็อกอินด้วย GitHub ได้เลย **ไม่ต้องผูกบัตรเครดิต**)
2. กด **New project** ตั้งชื่อโปรเจกต์ (เช่น `autobody-test`), ตั้ง Database Password, เลือก Region ที่ใกล้ประเทศไทย เช่น **Southeast Asia (Singapore)** แล้วกด **Create new project**

---

### 2. สร้าง Storage Bucket แบบ Public

1. ในแถบเมนูด้านซ้าย เข้าไปที่ **Storage** แล้วกด **New bucket**
2. ช่อง **Name of bucket** พิมพ์: `autobody-photos` *(ต้องตรงกับ `bucketName` ใน `supabase-config.js`)*
3. **เปิดสวิตช์ `Public bucket`** ให้เป็น ON เพื่อให้เปิดดูภาพในแกลเลอรีและแท็บใหม่ได้
4. กด **Save**

---

### 3. ตั้งค่า Storage Security Rules (RLS Policies) สำหรับทดสอบ

1. ในแถบเมนูด้านซ้าย เข้าไปที่ **SQL Editor** → กด **New query**
2. วางคำสั่ง SQL ด้านล่างนี้ทั้งหมด แล้วกด **Run** (เพื่อให้เว็บที่ยังไม่ล็อกอินสามารถอัปโหลด ดู และลบรูปใน Bucket `autobody-photos` ได้ในช่วงทดสอบ):

```sql
CREATE POLICY "Allow public uploads to autobody-photos"
ON storage.objects
FOR INSERT
TO anon
WITH CHECK (bucket_id = 'autobody-photos');

CREATE POLICY "Allow public reads from autobody-photos"
ON storage.objects
FOR SELECT
TO anon
USING (bucket_id = 'autobody-photos');

CREATE POLICY "Allow public deletes from autobody-photos"
ON storage.objects
FOR DELETE
TO anon
USING (bucket_id = 'autobody-photos');
```

> **สำคัญ:** นี่คือ Policy สำหรับช่วงทดสอบระบบ หากนำไปใช้งานจริงควรเปิดใช้ **Supabase Auth** และเปลี่ยน `TO anon` เป็น `TO authenticated`

---

### 4. นำค่า Config มาใส่ใน `supabase-config.js`

1. ในหน้า Supabase Dashboard ไปที่ **Project Settings** (ไอคอนฟันเฟืองมุมซ้ายล่าง) → **Data API** หรือ **API Keys**
2. คัดลอกค่า 2 ตัวนี้มาใส่ในไฟล์ `supabase-config.js`:
   - **Project URL** (เช่น `https://abcdefghijkl.supabase.co`) → ใส่ใน `supabaseUrl`
   - **Publishable key** (`sb_publishable_...`) หรือ **anon public key** (`eyJ...`) → ใส่ใน `supabaseAnonKey`

```js
export const supabaseConfig = {
  supabaseUrl: "https://abcdefghijkl.supabase.co",
  supabaseAnonKey: "sb_publishable_...",
  bucketName: "autobody-photos"
};
```

> **หมายเหตุ:** โปรเจกต์ฟรีของ Supabase หากไม่มีการใช้งานเลยเกิน 7 วัน ระบบจะพักโปรเจกต์ชั่วคราว สามารถเข้าไปกดปุ่ม **Restore** ในหน้า Dashboard เพื่อปลุกกลับมาใช้งานต่อได้ฟรีเหมือนเดิมครับ

---

### 5. Deploy ขึ้น GitHub Pages

1. สร้าง Repository ใหม่บน GitHub และอัปโหลด (หรือ `git push`) ไฟล์ทั้งหมดในโฟลเดอร์ `autobody-firebase-test` ขึ้นไปยัง Branch `main` (ให้ `index.html` อยู่ที่ระดับ Root ของ Repository)
2. ในหน้า Repository บน GitHub ไปที่ **Settings > Pages**
3. ในหัวข้อ **Build and deployment**:
   - **Source:** เลือก `Deploy from a branch`
   - **Branch:** เลือก `main` และโฟลเดอร์ `/ (root)`
   - กด **Save**
4. เปิดลิงก์ HTTPS ของ GitHub Pages บนมือถือเพื่อทดสอบถ่ายรูป อัปโหลด ดู และลบรูปได้ทันที
