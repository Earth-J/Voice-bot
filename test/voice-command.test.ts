import { describe, expect, test } from "bun:test";
import { parseQueueNumber, parseVoiceCommand } from "../src/voice-command.ts";

const q = (s: string) => {
  const c = parseVoiceCommand(s);
  return c?.kind === "play" ? c.query : null;
};

describe("parseVoiceCommand", () => {
  test("basic latin wake words", () => {
    expect(q("earth เปิดเพลง แมวเหมียว")).toBe("แมวเหมียว");
    expect(q("Earth เปิดเพลง Shape of You")).toBe("Shape of You");
  });

  test("thai spellings of the wake words", () => {
    expect(q("เอิร์ธ เปิดเพลง ฤดูร้อน")).toBe("ฤดูร้อน");
    expect(q("เอิร์ท เปิดเพลง ฤดูร้อน")).toBe("ฤดูร้อน");
    expect(q("เออร์ธ เปิดเพลง ฤดูร้อน")).toBe("ฤดูร้อน");
  });

  test("no spaces / punctuation / polite words", () => {
    expect(q("เอิร์ธเปิดเพลงฤดูร้อน")).toBe("ฤดูร้อน");
    expect(q("เอิร์ธ, เปิดเพลง Lemon หน่อยครับ")).toBe("Lemon");
    expect(q("เอิร์ธ ช่วยเปิดเพลง Lemon ค่ะ")).toBe("Lemon");
    expect(q("เฮ้ เอิร์ธ เปิดเพลง Lemon นะครับ")).toBe("Lemon");
  });

  test("ignores everything else", () => {
    expect(parseVoiceCommand("เปิดเพลง Lemon")).toBeNull(); // no wake word
    expect(parseVoiceCommand("เอิร์ธ สวัสดี")).toBeNull();
    expect(parseVoiceCommand("วันนี้อากาศดีจัง")).toBeNull();
    expect(parseVoiceCommand("เอิร์ธ เปิดเพลง")).toBeNull(); // no song name
    expect(parseVoiceCommand("เอิร์ธ เปิดไฟ")).toBeNull();
    expect(parseVoiceCommand("โคดี้ เปิดเพลง Lemon")).toBeNull(); // old wake word
    expect(parseVoiceCommand("codey เปิดเพลง Lemon")).toBeNull();
  });

  test("stop command", () => {
    expect(parseVoiceCommand("earth เงียบ")).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("earth เงียบหน่อย")).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("เอิร์ธ เงียบหน่อยครับ")).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("เอิร์ธ ช่วยเงียบหน่อย")).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("เงียบ")).toBeNull(); // no wake word
    expect(parseVoiceCommand("เอิร์ธ ปิดเพลง")).toBeNull(); // old phrase no longer used
    expect(parseVoiceCommand("เอิร์ธ ปิดไฟ")).toBeNull();
  });

  test("stop command: หยุดเพลง and the ways Whisper mishears it", () => {
    for (const said of [
      "เอิร์ธ หยุดเพลง",
      "เอิร์ธ หยุด",
      "เอิร์ธ จุดเพลง",
      "เอิร์ธ ยุทธเพลง",
      "เอิร์ธ จิตเพ็ง",
      "เอิร์ธ เนียบ",
    ]) {
      expect(parseVoiceCommand(said)).toEqual({ kind: "stop" });
    }
    expect(parseVoiceCommand("จุดเพลง")).toBeNull(); // no wake word
    expect(parseVoiceCommand("เอิร์ธ จุดไฟ")).toBeNull();
    expect(parseVoiceCommand("เอิร์ธ เปิดเพลง Lemon")).toEqual({ kind: "play", query: "Lemon" });
  });

  test("stop command (english backup)", () => {
    expect(parseVoiceCommand("earth stop")).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("Earth, stop.")).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("earth stop")).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("เอิร์ธ สต็อป")).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("เอิร์ธ สตอป")).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("earth ช่วย stop หน่อย")).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("stop")).toBeNull(); // no wake word
    expect(parseVoiceCommand("earth start")).toBeNull();
  });

  test("kick-me command", () => {
    expect(parseVoiceCommand("earth เตะผม")).toEqual({ kind: "kick" });
    expect(parseVoiceCommand("Earth เตะผมหน่อย")).toEqual({ kind: "kick" });
    expect(parseVoiceCommand("earth เตะผมออกไป")).toEqual({ kind: "kick" });
    expect(parseVoiceCommand("เอิร์ธ เตะผม")).toEqual({ kind: "kick" });
    expect(parseVoiceCommand("เอิร์ธเตะผมที")).toEqual({ kind: "kick" });
    expect(parseVoiceCommand("เอิร์ธ ช่วยเตะผมหน่อย")).toEqual({ kind: "kick" });
    expect(parseVoiceCommand("เอิร์ธ เตะ ฉัน")).toEqual({ kind: "kick" });
    expect(parseVoiceCommand("เอิร์ธ เต๊ะผม")).toEqual({ kind: "kick" }); // tone-mark mishearing
    expect(parseVoiceCommand("เตะผม")).toBeNull(); // no wake word
    expect(parseVoiceCommand("เอิร์ธ เตะบอล")).toBeNull(); // not "kick me"
    expect(parseVoiceCommand("เอิร์ธ เตะ")).toBeNull();
  });

  test("skip command", () => {
    expect(parseVoiceCommand("earth ข้าม")).toEqual({ kind: "skip" });
    expect(parseVoiceCommand("Earth skip")).toEqual({ kind: "skip" });
    expect(parseVoiceCommand("earth ข้ามเพลง")).toEqual({ kind: "skip" });
    expect(parseVoiceCommand("เอิร์ธ ข้ามหน่อย")).toEqual({ kind: "skip" });
    expect(parseVoiceCommand("เอิร์ธ ช่วยข้าม")).toEqual({ kind: "skip" });
    expect(parseVoiceCommand("เอิร์ธ ข่าม")).toEqual({ kind: "skip" }); // tone mishearing
    expect(parseVoiceCommand("เอิร์ธ สกิป")).toEqual({ kind: "skip" });
    expect(parseVoiceCommand("ข้าม")).toBeNull(); // no wake word
    expect(parseVoiceCommand("earth ข้ามถนน")).toEqual({ kind: "skip" }); // prefix match, like เงียบ
  });

  test("queue: add", () => {
    expect(parseVoiceCommand("earth เพิ่มเพลง Lemon")).toEqual({ kind: "queue-add", query: "Lemon" });
    expect(parseVoiceCommand("เอิร์ธ เพิ่มเพลง ฤดูร้อน หน่อยครับ")).toEqual({ kind: "queue-add", query: "ฤดูร้อน" });
    expect(parseVoiceCommand("earth ช่วยเพิ่มเพลงในคิว Shape of You")).toEqual({ kind: "queue-add", query: "Shape of You" });
    expect(parseVoiceCommand("เอิร์ธ ต่อคิว Lemon")).toEqual({ kind: "queue-add", query: "Lemon" });
    expect(parseVoiceCommand("earth เพิ่มคิวเพลง Lemon")).toEqual({ kind: "queue-add", query: "Lemon" });
    expect(parseVoiceCommand("earth เพิ่มเพลง")).toBeNull(); // no song name
    expect(parseVoiceCommand("เพิ่มเพลง Lemon")).toBeNull(); // no wake word
    // still the old behaviours
    expect(parseVoiceCommand("earth เปิดเพลง Lemon")).toEqual({ kind: "play", query: "Lemon" });
    expect(parseVoiceCommand("earth เพิ่มเสียง")).toEqual({ kind: "volume", delta: 5 });
  });

  test("queue: show", () => {
    expect(parseVoiceCommand("earth แสดงคิว")).toEqual({ kind: "queue-show" });
    expect(parseVoiceCommand("เอิร์ธ ดูคิว")).toEqual({ kind: "queue-show" });
    expect(parseVoiceCommand("earth โชว์คิวหน่อย")).toEqual({ kind: "queue-show" });
    expect(parseVoiceCommand("เอิร์ธ ขอดูคิว")).toEqual({ kind: "queue-show" });
    expect(parseVoiceCommand("earth แสดงคิ้ว")).toEqual({ kind: "queue-show" }); // tone-mark mishearing
    expect(parseVoiceCommand("earth คิวมีอะไรบ้าง")).toEqual({ kind: "queue-show" });
    expect(parseVoiceCommand("แสดงคิว")).toBeNull(); // no wake word
  });

  test("queue: remove by number", () => {
    expect(parseVoiceCommand("earth ลบคิว 3")).toEqual({ kind: "queue-remove", index: 3 });
    expect(parseVoiceCommand("earth ลบคิวที่ 2")).toEqual({ kind: "queue-remove", index: 2 });
    expect(parseVoiceCommand("เอิร์ธ ลบคิวที่สาม")).toEqual({ kind: "queue-remove", index: 3 });
    expect(parseVoiceCommand("earth ลบคิว ๔")).toEqual({ kind: "queue-remove", index: 4 });
    expect(parseVoiceCommand("เอิร์ธ ลบเพลงที่ 5 ออก")).toEqual({ kind: "queue-remove", index: 5 });
    expect(parseVoiceCommand("earth ลบลำดับที่ 1")).toEqual({ kind: "queue-remove", index: 1 });
    expect(parseVoiceCommand("earth ลบคิวสิบเอ็ด")).toEqual({ kind: "queue-remove", index: 11 });
    expect(parseVoiceCommand("earth ลบคิว")).toBeNull(); // no number
    expect(parseVoiceCommand("earth ลบคิว 0")).toBeNull();
    expect(parseVoiceCommand("ลบคิว 3")).toBeNull(); // no wake word
  });

  test("parseQueueNumber", () => {
    expect(parseQueueNumber("7")).toBe(7);
    expect(parseQueueNumber(" ๑๒ ออก")).toBe(12);
    expect(parseQueueNumber("หนึ่ง")).toBe(1);
    expect(parseQueueNumber("สิบ")).toBe(10);
    expect(parseQueueNumber("ยี่สิบ")).toBe(20);
    expect(parseQueueNumber("ยี่สิบสอง")).toBe(22);
    expect(parseQueueNumber("สามสิบห้า")).toBe(35);
    expect(parseQueueNumber("เก้า")).toBe(9);
    expect(parseQueueNumber("ออก")).toBeNull();
    expect(parseQueueNumber("")).toBeNull();
  });

  test("volume commands (±5)", () => {
    expect(parseVoiceCommand("earth เพิ่มเสียง")).toEqual({ kind: "volume", delta: 5 });
    expect(parseVoiceCommand("earth เบาเสียง")).toEqual({ kind: "volume", delta: -5 });
    expect(parseVoiceCommand("เอิร์ธ เบาเสียงหน่อยครับ")).toEqual({ kind: "volume", delta: -5 });
    expect(parseVoiceCommand("เอิร์ธ เพิ่มเสียง")).toEqual({ kind: "volume", delta: 5 });
    // Whisper mishearings of "เบา"
    expect(parseVoiceCommand("เอิร์ธ เปล่าเสียง")).toEqual({ kind: "volume", delta: -5 });
    expect(parseVoiceCommand("เอิร์ธ บ่าเสียง")).toEqual({ kind: "volume", delta: -5 });
    expect(parseVoiceCommand("earth เปลาเสียงหน่อย")).toEqual({ kind: "volume", delta: -5 });
    expect(parseVoiceCommand("earth เป่า เสียง")).toEqual({ kind: "volume", delta: -5 });
    expect(parseVoiceCommand("เปล่าเสียง")).toBeNull(); // no wake word
    expect(parseVoiceCommand("เอิร์ธ เปล่า")).toBeNull(); // no "เสียง"
    expect(parseVoiceCommand("เพิ่มเสียง")).toBeNull(); // no wake word
    expect(parseVoiceCommand("เอิร์ธ เพิ่มความเร็ว")).toBeNull();
  });
});

describe("Jarvis is no longer a wake word", () => {
  test("none of the old Jarvis spellings trigger anything", () => {
    for (const t of [
      "jarvis เปิดเพลง Lemon",
      "Jarvis เปิดเพลง Shape of You",
      "jarvis เงียบ",
      "jarvis stop",
      "jarvis ข้าม",
      "jarvis แสดงคิว",
      "jarvis ลบคิว 2",
      "jarvis เตะผม",
      "jarvis เพิ่มเสียง",
      "จาร์วิส เปิดเพลง ฤดูร้อน",
      "จาวิส เปิดเพลง ฤดูร้อน",
      "จาร์วิด เปิดเพลง Lemon",
      "จาร์วิส เงียบ",
      "เฮ้ จาร์วิส เปิดเพลง Lemon นะครับ",
    ]) {
      expect(parseVoiceCommand(t)).toBeNull();
    }
  });

  test("Earth still works right next to a Jarvis mention", () => {
    expect(parseVoiceCommand("เอิร์ธ เปิดเพลง Lemon")).toEqual({ kind: "play", query: "Lemon" });
  });
});
