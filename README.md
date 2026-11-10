# Earth Voice Bot — STT + YouTube music

บอท Discord ที่เข้าห้อง voice แล้ว **ฟังเสียง (Whisper ผ่าน Groq)** และ **เงียบตลอด**
จนกว่าจะมีคนพูดว่า

```
earth เปิดเพลง <ชื่อเพลง>
```

บอทเพลง (Lavalink) จะเข้าห้องเดียวกัน ค้นใน YouTube แล้วเล่นผลแรก (สั่งใหม่ = เปลี่ยนเพลง)
**ไม่เซฟ transcript, ไม่อัดเสียง, ไม่โพสต์ข้อความ** — จดไว้แค่ประวัติเพลงที่เล่น (ปิดได้ด้วย `MUSIC_HISTORY=false`)

## สถาปัตยกรรม: บอท 2 ตัว

Discord ให้บอท 1 ตัวมี voice connection ได้ 1 อันต่อเซิร์ฟเวอร์ — Lavalink ต้องถือ connection เอง
ส่วนการฟังเสียง (STT) ก็ต้องถือ connection เหมือนกัน จึงแยกเป็น

- **บอทฟัง** (`DISCORD_TOKEN`) — เข้าห้อง, ถอดเสียง, รับ slash commands
- **บอทเพลง** (`MUSIC_BOT_TOKEN`) — เข้าห้องเดียวกันเมื่อมีคำสั่ง แล้วเล่นเพลงผ่าน Lavalink

## ติดตั้ง

ต้องมี [Bun](https://bun.sh) v1.0+ และ Docker (หรือ Java 17+) สำหรับ Lavalink

```bash
# 1) Lavalink server (+ youtube-source plugin)
cd lavalink && docker compose up -d && cd ..

# 2) บอท
bun install
cp .env.example .env     # หรือใช้ .env เดิม แล้วเพิ่ม MUSIC_BOT_TOKEN
bun run register         # ลงทะเบียน slash commands ใหม่ (คำสั่งเปลี่ยนแล้ว)
bun run start
```

- รหัสใน `lavalink/application.yml` (`password`) ต้องตรงกับ `LAVALINK_PASSWORD`
- ถ้า YouTube เล่นไม่ได้: อัปเดตเวอร์ชัน `youtube-plugin` ใน `application.yml` หรือเปิด `oauth`

### Discord Developer Portal

- บอทฟัง: เชิญด้วยสิทธิ์ `Connect`, `View Channels`, `Use Application Commands`
  - ห้องเพลง (`/earth setup`): เพิ่ม `Send Messages`, `Embed Links`, `Read Message History` ในห้องนั้น (+ `Manage Messages` ถ้าอยากให้บอทลบข้อความที่พิมพ์ขอเพลง)
  - ต้องเปิด **Message Content Intent** (Developer Portal → Bot → Privileged Gateway Intents) — ไม่เปิดบอทจะ login ไม่ผ่าน (`Used disallowed intents`)
- บอทเพลง: สร้าง application ใหม่อีกอัน เชิญเข้าเซิร์ฟเวอร์เดียวกันด้วย `Connect`, `Speak`, `View Channels`

### .env ที่จำเป็น

| ตัวแปร | ความหมาย |
|---|---|
| `DISCORD_TOKEN`, `DISCORD_APP_ID` | จาก Developer Portal |
| `DISCORD_GUILD_ID` | guild หลัก (fallback เมื่อสั่งจาก DM) |
| `DC_OWNER_IDS` | Discord user ID ที่ใช้คำสั่งได้ (คั่นด้วย `,`) |
| `GROQ_API_KEY` | จาก [console.groq.com](https://console.groq.com) |
| `GROQ_API_KEYS` *(ไม่บังคับ)* | Groq key เพิ่มเติม คั่นด้วย `,` — แต่ละ key มีโควตาแยก ติด limit (429) แล้วสลับไป key ถัดไปเอง ต้องเป็น key จากคนละบัญชี Groq (โควตานับต่อ organization) key ที่ 401/403 จะถูกข้ามจนกว่าจะรีสตาร์ท |
| `MUSIC_BOT_TOKEN` | token ของบอทเพลงตัวที่สอง |
| `GEMINI_API_KEY` *(ไม่บังคับ)* | key หลักของ Gemini — แก้ชื่อเพลงที่ Whisper ฟังเพี้ยน (ไม่ใส่ = ปิดฟีเจอร์) |
| `GEMINI_API_KEY_BACKUP` *(ไม่บังคับ)* | key สำรอง — สลับไปใช้ทันทีเมื่อ key หลักติด limit (429) |
| `GEMINI_MODEL` *(ไม่บังคับ)* | ชื่อโมเดล (ค่าเริ่มต้น `gemini-2.5-flash-lite`) |

**แก้คำเพี้ยนด้วย Gemini:** ส่งเฉพาะ "ชื่อเพลง" จากคำสั่ง `เปิดเพลง` / `เพิ่มเพลง` (ข้อความล้วน ไม่ส่งเสียง) ไปให้ Gemini แก้ก่อนค้นหา
คำสั่งอื่น ๆ ไม่ผ่าน Gemini จึงไม่ช้าลง ถ้า Gemini ช้าเกิน `GEMINI_TIMEOUT_MS` (2.5 วินาที) / ติด limit ทั้งสอง key / error จะใช้ข้อความเดิมจาก Whisper ทันที

ค่าอื่น ๆ ดู `.env.example`

## Deploy บน Railway

ดูขั้นตอนเต็มใน [DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md) — bot และ Lavalink เป็น 2 service
(`Dockerfile` ที่ root = bot, `lavalink/Dockerfile` = Lavalink) ค่า config ทั้งหมดตั้งผ่าน env var ดูตัวอย่างใน `.env.example`

## ใช้งาน

1. เข้า voice channel → `/earth join`
2. พูดว่า `earth เปิดเพลง <ชื่อเพลง>` (ออกเสียงเป็น "เอิร์ธ" ก็ได้)
3. พูดว่า `earth เงียบ` หรือ `earth เงียบหน่อย` เพื่อหยุดเพลง (หรือ `/earth stop`) / `/earth leave` ออก

เอิร์ธฟังเฉพาะ user ใน `LISTEN_USER_IDS` (ค่าเริ่มต้น `918384557131173988`) — เสียงคนอื่นไม่ถูกจับและไม่ถูกส่งไปถอดความ
คำสั่งเสียง: `earth เปิดเพลง <ชื่อ>` / `earth เงียบ` (`เงียบหน่อย` / `stop` — หยุดเพลง + ล้างคิว) / `earth เพิ่มเสียง` / `earth เบาเสียง` (ทีละ 5%, 0–100%) / `earth เพิ่มเพลง <ชื่อ>` (ต่อคิว) / `earth ข้าม` (`skip` — ข้ามเพลง) / `earth แสดงคิว` (ส่ง embed คิวใหม่ลงห้อง `QUEUE_CHANNEL_ID`) / `earth ลบคิว <เลขลำดับ>` / `earth เตะผม` (ตัดคนพูดออกจากห้อง voice — บอทฟังต้องมีสิทธิ์ **Move Members**)

| คำสั่ง | ทำอะไร |
|---|---|
| `/earth join [channel-id]` | เข้า voice channel |
| `/earth leave` | ออก (หยุดเพลง) |
| `/earth stop` | หยุดเพลง |
| `/earth status` | state, เพลงที่เล่นอยู่, STT usage |
| `/earth stay [hours]` / `unstay` | ปิด/เปิด auto-leave |
| `/earth setup [channel-id]` | ตั้งห้องเพลง (ไม่ใส่ id = ห้องที่พิมพ์คำสั่ง) — ดูหัวข้อ "ห้องเพลง" |
| `/earth unsetup` | ยกเลิกห้องเพลง |
| `/earth help` | รายการคำสั่ง |

alias: `/ej` `/el` `/est` `/estop` `/eh` `/evi` `/evo` `/estay` `/eunstay` `/esetup` `/eunsetup` และ `/ear …`

ออกทันทีเมื่อในห้องไม่เหลือคนจริง ๆ (ไม่นับบอท, หน่วง `ALONE_LEAVE_DELAY_MS` default 2 วิ) / `/earth stay` เพื่อข้าม

Embed คิว: เริ่มเล่นเพลง → สร้าง embed คิวในห้อง `QUEUE_CHANNEL_ID` / เพิ่ม-ลบ-ข้ามเพลง หรือเพลงเปลี่ยน → edit embed เดิม / `เงียบ` (ล้างคิว) หรือเพลงหมด → ลบ embed (บอทฟังต้องมีสิทธิ์ View Channel + Send Messages + Embed Links)

Auto-leave สำรอง: อยู่คนเดียว 5 นาที (ไม่มี auto-leave เพราะเงียบ) / `/earth stay` เพื่อข้าม

### ห้องเพลง (`/earth setup`)

`/earth setup channel-id:<id ห้องข้อความ>` (หรือพิมพ์ในห้องนั้นโดยไม่ใส่ id)

- วางลิงก์ YouTube ได้เหมือนพิมพ์ชื่อเพลง: ลิงก์คลิป (`youtube.com/watch?v=…`, `youtu.be/…`, `music.youtube.com`, shorts) เล่นคลิปนั้นตรง ๆ ไม่ค้นหา (ตัด `si=` / `t=` / `list=` ทิ้ง เล่นเฉพาะคลิปเดียว) ส่วนลิงก์เพลย์ลิสต์ (`youtube.com/playlist?list=…`) จะเพิ่มทั้งเพลย์ลิสต์: ไม่มีเพลงเล่น = เพลงแรกเล่นทันที ที่เหลือต่อคิว, มีเพลงเล่นอยู่ = ต่อคิวทั้งหมด จนคิวเต็ม (`MUSIC_MAX_QUEUE`, ค่าเริ่มต้น 50) — ข้ามไลฟ์สดและคลิปที่ยาวเกิน `MUSIC_MAX_MINUTES`
- พิมพ์ชื่อเพลงในห้องนั้นได้เลย **ไม่ต้องมี prefix/คำปลุก** — ไม่มีเพลงเล่น = เล่นทันที, มีเพลงเล่นอยู่ = ต่อคิว (ข้อความที่พิมพ์จะถูกลบถ้าบอทมีสิทธิ์ Manage Messages; ปิดได้ด้วย `SETUP_DELETE_MESSAGES=false`)
- ผู้พิมพ์ต้องอยู่ voice channel เดียวกับเอิร์ธ ถ้าเอิร์ธยังไม่อยู่ห้องไหน เฉพาะ `DC_OWNER_IDS` ที่พิมพ์แล้วเอิร์ธจะตามเข้าห้องให้
- embed คิว (รวมตอนสั่งด้วยเสียง) ย้ายมาอยู่ห้องนี้แทน `QUEUE_CHANNEL_ID` เป็นข้อความเดียวถาวรที่ถูก edit — ไม่มีเพลงก็ไม่ลบ แค่เปลี่ยนเป็นหน้า idle
- ค่าที่ตั้งเก็บไว้ที่ `DATA_DIR/setup.json` (default `./data/setup.json`) — บน Railway ต้องผูก Volume ไว้ที่ `/app/data` ไม่งั้นต้อง `/earth setup` ใหม่ทุกครั้งที่ deploy

### ประวัติเพลง (เล่นซ้ำให้ตรงเพลงเดิม)

บอทจำว่าแต่ละเซิร์ฟเวอร์เคยเล่นเพลงอะไรไปแล้ว เก็บใน SQLite ที่ `DATA_DIR/music-history.db` (ใช้ `bun:sqlite` ในตัว Bun ไม่ต้องติดตั้งอะไรเพิ่ม) แล้วใช้ช่วยตอนมีคนขอเพลงซ้ำ:

- ขอด้วยข้อความเดิมอีกครั้ง (หลังแก้ชื่อศิลปินที่ Whisper ฟังเพี้ยนแล้ว) → เล่นคลิปเดิมที่เคยเล่น แทนที่จะเชื่อผลค้นหา YouTube อันดับแรก ถ้าเคยมีหลายคลิปจะเลือกอันที่ถูกเลือกบ่อยสุด
- ขอแบบ `<เพลง> ของ <ศิลปิน>` ที่ไม่ตรงกับคำขอเดิมเป๊ะ → หาในชื่อคลิปที่เคยเล่น ต้องเจอทั้งชื่อเพลงและศิลปิน
- ขอแค่ชื่อเพลง (ไม่ระบุศิลปิน) → ใช้ประวัติเฉพาะเมื่อชื่อยาวพอ (6 ตัวอักษรขึ้นไป) และตรงกับเพลงที่เคยเล่นแค่เพลงเดียว ถ้าไม่แน่ใจจะค้นหา YouTube ตามปกติ
- กด ข้าม ภายใน 20 วินาทีแรก = ถือว่าเลือกผิด ระบบลืมคู่ "คำขอ → คลิป" นั้นและไม่เสนอคลิปนั้นให้คำขอนี้อีก
- ลิงก์ YouTube ไม่ผ่านประวัติ (ลิงก์ระบุคลิปชัดเจนอยู่แล้ว) และการเล่นซ้ำจากปุ่ม ⏮ / วนซ้ำ ไม่นับเป็นการเล่นใหม่
- ถ้าเปิดฐานข้อมูลไม่ได้ บอทยังทำงานได้ตามปกติ แค่ค้นหา YouTube ทุกครั้งเหมือนเดิม ปิดฟีเจอร์นี้ด้วย `MUSIC_HISTORY=false`
- บน Railway ต้องผูก Volume ที่ `/app/data` เหมือน `setup.json` ไม่งั้นประวัติหายทุกครั้งที่ deploy

ที่เก็บ: ชื่อคลิป ช่อง ความยาว ลิงก์ ข้อความคำขอ (ที่ผ่านการปรับแล้ว) Discord user id ของคนขอ และเวลาที่เล่น — ไม่เก็บ transcript เสียง

## ความเป็นส่วนตัว

- เสียงถูกส่งไปที่ Groq (API ถอดเสียง) แล้วไฟล์ชั่วคราวถูกลบทันที — แจ้งคนในห้องก่อนเสมอ
- ข้อความที่ถอดได้ใช้แค่ตรวจว่าเป็นคำสั่งเปิดเพลงไหม แล้วทิ้ง (แสดงใน console log เท่านั้น)
- สิ่งเดียวที่บันทึกถาวรคือประวัติเพลงที่เล่น (ดูหัวข้อ "ประวัติเพลง") ไม่ใช่เสียงหรือ transcript

## พัฒนา

```bash
bun test
bun run typecheck
bun run voice-test  # ทดสอบแค่การ join voice (ตั้ง TEST_CHANNEL_ID)
```

## License

MIT
