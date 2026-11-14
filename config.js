// Config for Telegram Vercel Bot - 100% Environment Variables Only
export const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  BOT_USERNAME: process.env.BOT_USERNAME || "",
  ADMINS: (process.env.ADMINS || "")
    .split(",")
    .filter(Boolean)
    .map((id) => Number(id.trim())),

  // Force Sub Channels & Group (from env)
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
  ].filter((ch) => ch.id !== 0 && ch.url),
  UPDATE_CHANNEL_URL: process.env.UPDATE_CHANNEL_URL || "https://t.me/TeraboxDownloaderINDIA",

  // Dump Channel (Where parsed files & download links are archived)
  DUMP_CHANNEL_ID: process.env.DUMP_CHANNEL_ID || "-1004161131573",

  // Download & Stream Proxy
  DOWNLOAD_PROXY_URL: process.env.DOWNLOAD_PROXY_URL || "https://teraboxdownloader.co.in/download.php",

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

  // User Limits & App Integration
  DAILY_LIMIT: Number(process.env.DAILY_LIMIT || "5"),
  APP_PLAYSTORE_URL: process.env.APP_PLAYSTORE_URL || "https://play.google.com/store/apps/details?id=com.anihub.teradownloader",
  WEBSITE_URL: process.env.WEBSITE_URL || "https://teraboxdownloader.co.in/",
};
