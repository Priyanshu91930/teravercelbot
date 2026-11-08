// Config for Telegram Vercel Bot - Read purely from environment variables
export const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  BOT_USERNAME: process.env.BOT_USERNAME || "",
  ADMINS: (process.env.ADMINS || "")
    .split(",")
    .filter(Boolean)
    .map((id) => Number(id.trim())),

  // Force Sub Channels & Group
  FORCE_SUB_ENABLED: process.env.FORCE_SUB_ENABLED !== "false",
  FORCE_SUB_CHANNELS: [
    {
      id: Number(process.env.FORCE_SUB_ID_1 || "-1003983694204"),
      name: "Channel 1 📢",
      url: process.env.FORCE_LINK_1 || "https://t.me/+exoDGnQTZwM0N2M1",
    },
    {
      id: Number(process.env.FORCE_SUB_ID_2 || "-1004396922446"),
      name: "Channel 2 📢",
      url: process.env.FORCE_LINK_2 || "https://t.me/+cySPj7iDogFkMzc1",
    },
    {
      id: Number(process.env.FORCE_SUB_ID_3 || "-1004290277720"),
      name: "Group 💬",
      url: process.env.FORCE_LINK_3 || "https://t.me/+LaAHxuNGHgBmYmE1",
    },
  ],
  UPDATE_CHANNEL_URL:
    process.env.UPDATE_CHANNEL_URL || "https://t.me/TeraboxDownloaderINDIA",

  // Shortlink Ad Configuration (Disabled by default)
  USE_TOKEN_SYSTEM: process.env.USE_TOKEN_SYSTEM === "true",
  SHORTLINK_API_URL: process.env.SHORTLINK_API_URL || "https://vplink.in/api",
  SHORTLINK_API_KEY: process.env.SHORTLINK_API_KEY || "",
  MIN_SHORTLINK_TIME: Number(process.env.MIN_SHORTLINK_TIME || "60"),

  // TeraBox Parser API Details
  TERABOX_API_BASE: process.env.TERABOX_API_BASE || "",
  TERABOX_API_KEY: process.env.TERABOX_API_KEY || "",

  // Database
  MONGODB_URI: process.env.MONGODB_URI || "",
};
