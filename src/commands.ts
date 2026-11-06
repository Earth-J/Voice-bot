import {
  SlashCommandBuilder,
  InteractionContextType,
  ApplicationIntegrationType,
} from "discord.js";

const CONTEXTS = [
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel,
];
const INTEGRATION_TYPES = [
  ApplicationIntegrationType.GuildInstall,
  ApplicationIntegrationType.UserInstall,
];

function buildEarthCommand(name: string, description: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(CONTEXTS)
    .setIntegrationTypes(INTEGRATION_TYPES)
    .addSubcommand((sub) =>
      sub.setName("help").setDescription("โชว์คำสั่งทั้งหมด + ขั้นตอนการใช้งาน"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("join")
        .setDescription("เอิร์ธเข้า voice channel (DM: ใส่ channel-id; guild: ตามคนสั่ง)")
        .addStringOption((opt) =>
          opt.setName("channel-id").setDescription("Voice channel ID — DM only").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("leave").setDescription("ออกจาก voice channel"),
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("ดูสถานะ (channel, duration, เพลงที่เล่นอยู่)"),
    )
    .addSubcommand((sub) =>
      sub.setName("stop").setDescription("หยุดเพลงที่กำลังเล่น (เอิร์ธยังอยู่ในห้อง)"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("stay")
        .setDescription("Persistent mode — อยู่ในห้องเสียงทั้งวัน (default 24h, max 24h)")
        .addNumberOption((opt) =>
          opt
            .setName("hours")
            .setDescription("ระยะเวลา (ชั่วโมง) — default 24, max 24")
            .setRequired(false)
            .setMinValue(0.1)
            .setMaxValue(24),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unstay")
        .setDescription("ปิด persistent mode — auto-leave กลับมาทำงานปกติ"),
    );
}

function aliasBase(name: string, description: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(CONTEXTS)
    .setIntegrationTypes(INTEGRATION_TYPES);
}

const cjCommand = aliasBase("ej", "alias: /earth join — เข้า voice channel").addStringOption(
  (opt) =>
    opt.setName("channel-id").setDescription("Voice channel ID (DM only)").setRequired(false),
);
const clCommand = aliasBase("el", "alias: /earth leave — ออกจากห้อง");
const cstCommand = aliasBase("est", "alias: /earth status");
const chCommand = aliasBase("eh", "alias: /earth help");

const cstopCommand = aliasBase("estop", "alias: /earth stop — หยุดเพลง");

const cviCommand = aliasBase("evi", "alias: /earth join — voice-in").addStringOption((opt) =>
  opt.setName("channel-id").setDescription("Voice channel ID (DM only)").setRequired(false),
);
const cvoCommand = aliasBase("evo", "alias: /earth leave — voice-out");

const cstayCommand = aliasBase("estay", "alias: /earth stay — keep Earth in channel (<=24h)")
  .addNumberOption((opt) =>
    opt
      .setName("hours")
      .setDescription("hours, max 24 (default 24)")
      .setRequired(false)
      .setMinValue(0.1)
      .setMaxValue(24),
  );
const cunstayCommand = aliasBase("eunstay", "alias: /earth unstay — turn off persistent mode");

export const earthCommand = buildEarthCommand(
  "earth",
  "Earth — ฟังเสียงในห้อง voice + เปิดเพลง YouTube ตามคำสั่งเสียง",
);
export const earthAliasCommand = buildEarthCommand("ear", "alias ของ /earth");

export const ALIAS_TO_SUBCOMMAND: Readonly<Record<string, string>> = {
  ej: "join",
  el: "leave",
  est: "status",
  estop: "stop",
  eh: "help",
  evi: "join",
  evo: "leave",
  estay: "stay",
  eunstay: "unstay",
};

export const YOI_BASE_NAMES = new Set(["earth", "ear"]);

export const commands = [
  earthCommand,
  earthAliasCommand,
  cjCommand,
  clCommand,
  cstCommand,
  cstopCommand,
  chCommand,
  cviCommand,
  cvoCommand,
  cstayCommand,
  cunstayCommand,
];
