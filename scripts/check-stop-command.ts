/**
 * ทดสอบ parseVoiceCommand() แบบรวดเร็ว นอก Discord
 *
 * ใช้ตอนไล่ความแม่นของคำสั่ง "เงียบ / หยุด / หุบปาก":
 *   1) รัน bot จริง (`bun run start`) แล้วพูดคำสั่งใส่ไมค์ในห้อง voice ซ้ำ ๆ
 *   2) เปิด console ของ bot — ทุกครั้งที่พูดจะมี log บรรทัด:
 *        [voice-session] heard user=...: "ข้อความที่ Whisper ถอดได้"
 *      copy ข้อความในเครื่องหมายคำพูดตรงนั้นมา
 *   3) วางที่นี่ (ทีละบรรทัด หรือใส่เป็น argument) แล้วรันสคริปต์นี้
 *   4) ถ้าบรรทัดไหนขึ้น "null" แปลว่า regex ยังไม่รู้จักคำที่ Whisper ถอดมา
 *      → เปิด src/voice-command.ts เติมสเปลลิงที่เจอจริงใน STOP_VERB แล้วรันใหม่
 *
 * วิธีรัน:
 *   bun run scripts/check-stop-command.ts                 (รันชุดทดสอบ default)
 *   bun run scripts/check-stop-command.ts "เอิร์ธ เงียบหน่อย" "เอิร์ธ หุบปาก"
 *   echo 'เอิร์ธ หยุด' | bun run scripts/check-stop-command.ts
 */
import { parseVoiceCommand } from "../src/voice-command.ts";

const DEFAULT_PHRASES = [
  "เอิร์ธ เงียบ",
  "เอิร์ธ เงียบหน่อย",
  "เอิร์ธ หยุด",
  "เอิร์ธ หยุดเพลง",
  "เอิร์ธ หุบปาก",
  "เอิร์ธ หุบปากหน่อย",
  "เอิร์ธ ช่วยหุบปากที",
  "Earth stop",
  "เอิร์ธ สต็อป",
];

async function readStdin(): Promise<string[]> {
  if (process.stdin.isTTY) return [];
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

const argPhrases = process.argv.slice(2);
const stdinPhrases = await readStdin();
const phrases = [...argPhrases, ...stdinPhrases];
const toTest = phrases.length > 0 ? phrases : DEFAULT_PHRASES;

let pass = 0;
let fail = 0;

for (const phrase of toTest) {
  const result = parseVoiceCommand(phrase);
  const isStop = result?.kind === "stop";
  const mark = isStop ? "✅ stop " : result ? `⚠️  ${result.kind} ` : "❌ null  ";
  if (isStop) pass++;
  else fail++;
  console.log(`${mark} | "${phrase}"`);
}

console.log(`\n${pass}/${toTest.length} ถูกจับเป็น stop`);
if (fail > 0) {
  console.log(
    `${fail} ประโยคยังไม่ถูกจับ — เอาคำที่ Whisper ถอดจริง (จาก console log) ไปเติมใน STOP_VERB ที่ src/voice-command.ts แล้วรันใหม่`,
  );
}
