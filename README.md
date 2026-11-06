# Earth Voice Bot — STT + YouTube music

บอท Discord ที่เข้าห้อง voice แล้ว **ฟังเสียง (Groq Whisper)** และ **เงียบตลอด**
จนกว่าจะมีคนพูดว่า

```
earth/jarvis เปิดเพลง <ชื่อเพลง>
```

บอทเพลง (Lavalink) จะเข้าห้องเดียวกัน ค้นใน YouTube แล้วเล่นผลแรก (สั่งใหม่ = เปลี่ยนเพลง)
**ไม่มีระบบจดบันทึก** — ไม่เซฟ transcript, ไม่อัดเสียง, ไม่โพสต์ข้อความ

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

- บอทฟัง: เชิญด้วยสิทธิ์ `Connect`, `View Channels`, `Use Application Commands` (ไม่ต้องเปิด Privileged Intent)
- บอทเพลง: สร้าง application ใหม่อีกอัน เชิญเข้าเซิร์ฟเวอร์เดียวกันด้วย `Connect`, `Speak`, `View Channels`

### .env ที่จำเป็น

| ตัวแปร | ความหมาย |
|---|---|
| `DISCORD_TOKEN`, `DISCORD_APP_ID` | จาก Developer Portal |
| `DISCORD_GUILD_ID` | guild หลัก (fallback เมื่อสั่งจาก DM) |
| `DC_OWNER_IDS` | Discord user ID ที่ใช้คำสั่งได้ (คั่นด้วย `,`) |
| `GROQ_API_KEY` | จาก [console.groq.com](https://console.groq.com) |
| `MUSIC_BOT_TOKEN` | token ของบอทเพลงตัวที่สอง |

ค่าอื่น ๆ ดู `.env.example`

## Deploy บน Railway

ดูขั้นตอนเต็มใน [DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md) — bot และ Lavalink เป็น 2 service
(`Dockerfile` ที่ root = bot, `lavalink/Dockerfile` = Lavalink) ค่า config ทั้งหมดตั้งผ่าน env var ดูตัวอย่างใน `.env.example`

## ใช้งาน

1. เข้า voice channel → `/earth join`
2. พูดว่า `earth/jarvis เปิดเพลง <ชื่อเพลง>` (ออกเสียงเป็น "เอิร์ธ" / "จาร์วิส" ก็ได้)
3. พูดว่า `earth/jarvis เงียบ` หรือ `earth/jarvis เงียบหน่อย` เพื่อหยุดเพลง (หรือ `/earth stop`) / `/earth leave` ออก

เอิร์ธฟังเฉพาะ user ใน `LISTEN_USER_IDS` (ค่าเริ่มต้น `918384557131173988`) — เสียงคนอื่นไม่ถูกจับและไม่ถูกส่งไปถอดความ
คำสั่งเสียง: `earth/jarvis เปิดเพลง <ชื่อ>` / `earth/jarvis เงียบ` (`เงียบหน่อย` / `stop` — หยุดเพลง + ล้างคิว) / `earth/jarvis เพิ่มเสียง` / `earth/jarvis เบาเสียง` (ทีละ 5%, 0–100%) / `earth/jarvis เพิ่มเพลง <ชื่อ>` (ต่อคิว) / `earth/jarvis ข้าม` (`skip` — ข้ามเพลง) / `earth/jarvis แสดงคิว` (ส่ง embed คิวใหม่ลงห้อง `QUEUE_CHANNEL_ID`) / `earth/jarvis ลบคิว <เลขลำดับ>` / `earth/jarvis เตะผม` (ตัดคนพูดออกจากห้อง voice — บอทฟังต้องมีสิทธิ์ **Move Members**)

| คำสั่ง | ทำอะไร |
|---|---|
| `/earth join [channel-id]` | เข้า voice channel |
| `/earth leave` | ออก (หยุดเพลง) |
| `/earth stop` | หยุดเพลง |
| `/earth status` | state, เพลงที่เล่นอยู่, STT usage |
| `/earth stay [hours]` / `unstay` | ปิด/เปิด auto-leave |
| `/earth help` | รายการคำสั่ง |

alias: `/ej` `/el` `/est` `/estop` `/eh` `/evi` `/evo` `/estay` `/eunstay` และ `/ear …`

ออกทันทีเมื่อในห้องไม่เหลือคนจริง ๆ (ไม่นับบอท, หน่วง `ALONE_LEAVE_DELAY_MS` default 2 วิ) / `/earth stay` เพื่อข้าม

Embed คิว: เริ่มเล่นเพลง → สร้าง embed คิวในห้อง `QUEUE_CHANNEL_ID` / เพิ่ม-ลบ-ข้ามเพลง หรือเพลงเปลี่ยน → edit embed เดิม / `เงียบ` (ล้างคิว) หรือเพลงหมด → ลบ embed (บอทฟังต้องมีสิทธิ์ View Channel + Send Messages + Embed Links)

Auto-leave สำรอง: อยู่คนเดียว 5 นาที (ไม่มี auto-leave เพราะเงียบ) / `/earth stay` เพื่อข้าม

## ความเป็นส่วนตัว

- เสียงถูกส่งไป Groq API เพื่อถอดความ แล้วไฟล์ชั่วคราวถูกลบทันที — แจ้งคนในห้องก่อนเสมอ
- ข้อความที่ถอดได้ใช้แค่ตรวจว่าเป็นคำสั่งเปิดเพลงไหม แล้วทิ้ง (แสดงใน console log เท่านั้น)

## พัฒนา

```bash
bun test
bun run typecheck
bun run voice-test  # ทดสอบแค่การ join voice (ตั้ง TEST_CHANNEL_ID)
```

## License

MIT
