// Config for Telegram Vercel Bot - 100% Environment Variables Only
export const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  BOT_USERNAME: process.env.BOT_USERNAME || "",
  ADMINS: (process.env.ADMINS || "")
    .split(",")
    .filter(Boolean)
    .map((id) => Number(id.trim())),

  // Force Sub Channels & Group (from env)
  FORCE_SUB_ENABLED: process.env.FORCE_SUB_ENABLED === "true",
  FORCE_SUB_CHANNELS: [
    {
      id: Number(process.env.FORCE_SUB_ID_1 || "0"),
      name: "Channel 1 📢",
      url: process.env.FORCE_LINK_1 || "",
    },
    {
      id: Number(process.env.FORCE_SUB_ID_2 || "0"),
      name: "Channel 2 📢",
      url: process.env.FORCE_LINK_2 || "",
    },
    {
      id: Number(process.env.FORCE_SUB_ID_3 || "0"),
      name: "Group 💬",
      url: process.env.FORCE_LINK_3 || "",
    },
  ].filter((ch) => ch.id !== 0 && ch.url),
  UPDATE_CHANNEL_URL: process.env.UPDATE_CHANNEL_URL || "",

  // Shortlink Ad Configuration (Disabled by default)
  USE_TOKEN_SYSTEM: process.env.USE_TOKEN_SYSTEM === "true",
  SHORTLINK_API_URL: process.env.SHORTLINK_API_URL || "",
  SHORTLINK_API_KEY: process.env.SHORTLINK_API_KEY || "",
  MIN_SHORTLINK_TIME: Number(process.env.MIN_SHORTLINK_TIME || "60"),

  // TeraBox Parser API Details (from env)
  TERABOX_API_BASE: process.env.TERABOX_API_BASE || "",
  TERABOX_API_KEY: process.env.TERABOX_API_KEY || "",

  // Database (from env)
  MONGODB_URI: process.env.MONGODB_URI || "",
};
