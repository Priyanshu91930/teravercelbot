import { CONFIG } from './config.js';
import crypto from 'node:crypto';
import { BotUser, ForceSubChannel, BotSetting, JoinRequest } from './db.js';

const TELEGRAM_API = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}`;

/**
 * Call Telegram Bot API
 */
export async function tgCall(method, payload = {}) {
  try {
    const res = await fetch(`${TELEGRAM_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    console.error(`[Telegram] ${method} error:`, err.message);
    return { ok: false, description: err.message };
  }
}

/**
 * Check if a TeraBox link exists in the text
 */
export function extractTeraboxUrl(text) {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s]+/i);
  if (!match) return null;
  const url = match[0];
  const patterns = [
    /terabox\.com/i,
    /1024tera\.com/i,
    /1024tera\.co/i,
    /1024terabox\.com/i,
    /terabox\.app/i,
    /teraboxlink\.com/i,
    /terasharelink\.com/i,
    /terasharefile\.com/i,
    /terashare\.com/i,
    /nephobox\.com/i,
    /teraboxapp\.com/i,
    /mirrobox\.com/i,
    /freeterabox\.com/i,
    /momerybox\.com/i,
    /tibbox\.com/i,
    /tibibox\.com/i,
    /4funbox\.com/i,
    /dubox\.com/i,
    /terabox\.best/i,
    /teraboxshare\.com/i,
    /terafileshare\.com/i,
    /1024box\.com/i,
  ];
  return patterns.some((p) => p.test(url)) ? url : null;
}

/**
 * Check if dynamic Force Sub is enabled (MongoDB setting overrides .env)
 */
export async function isForceSubEnabled() {
  try {
    const setting = await BotSetting.findOne({ key: 'FORCE_SUB_ENABLED' });
    if (setting && typeof setting.value === 'boolean') {
      return setting.value;
    }
  } catch (e) {
    console.error('[Settings] Error checking FORCE_SUB_ENABLED:', e.message);
  }
  return CONFIG.FORCE_SUB_ENABLED;
}

/**
 * Check if dynamic Token System is enabled (MongoDB setting overrides .env)
 */
export async function isTokenSystemEnabled() {
  try {
    const setting = await BotSetting.findOne({ key: 'USE_TOKEN_SYSTEM' });
    if (setting && typeof setting.value === 'boolean') {
      return setting.value;
    }
  } catch (e) {
    console.error('[Settings] Error checking USE_TOKEN_SYSTEM:', e.message);
  }
  return CONFIG.USE_TOKEN_SYSTEM;
}

/**
 * Check if admin bypass for Force Sub is enabled (Default false)
 */
export async function isAdminBypassEnabled() {
  try {
    const setting = await BotSetting.findOne({ key: 'ADMIN_BYPASS_FORCESUB' });
    if (setting && typeof setting.value === 'boolean') {
      return setting.value;
    }
  } catch (e) {
    console.error('[Settings] Error checking ADMIN_BYPASS_FORCESUB:', e.message);
  }
  return false;
}

/**
 * Retrieve current Dump Channel ID from DB (BotSetting) or config
 */
export async function getDumpChannelId() {
  try {
    const setting = await BotSetting.findOne({ key: 'DUMP_CHANNEL_ID' });
    if (setting && setting.value) {
      return Number(setting.value);
    }
  } catch (e) {
    console.error('[Settings] Error reading DUMP_CHANNEL_ID:', e.message);
  }
  return CONFIG.DUMP_CHANNEL_ID ? Number(CONFIG.DUMP_CHANNEL_ID) : null;
}

/**
 * Retrieve active Force Sub channels from MongoDB (with auto-seeding if empty)
 */
export async function getActiveForceSubChannels() {
  try {
    let dbChannels = await ForceSubChannel.find({}).sort({ created_at: 1 });
    if (!dbChannels || dbChannels.length === 0) {
      // Auto-seed initial default channels from config into MongoDB
      if (CONFIG.FORCE_SUB_CHANNELS && CONFIG.FORCE_SUB_CHANNELS.length > 0) {
        for (const ch of CONFIG.FORCE_SUB_CHANNELS) {
          await ForceSubChannel.updateOne(
            { chat_id: ch.id },
            { $set: { chat_id: ch.id, name: ch.name, url: ch.url, created_at: new Date() } },
            { upsert: true }
          );
        }
        dbChannels = await ForceSubChannel.find({}).sort({ created_at: 1 });
      }
    }

    if (dbChannels && dbChannels.length > 0) {
      return dbChannels.map((c) => ({
        id: Number(c.chat_id),
        name: c.name,
        url: c.url,
      }));
    }
  } catch (e) {
    console.error('[ForceSub] Error loading channels from DB:', e.message);
  }

  return CONFIG.FORCE_SUB_CHANNELS || [];
}

/**
 * Check if user is member of a specific Telegram chat/channel
 * Supports both direct membership and pending Join Requests (for private links)
 */
export async function isUserInChat(chatId, userId) {
  const numChatId = Number(chatId);
  const numUserId = Number(userId);

  try {
    const res = await tgCall('getChatMember', {
      chat_id: numChatId,
      user_id: numUserId,
    });
    if (res.ok && res.result) {
      const status = res.result.status;
      if (['creator', 'administrator', 'member', 'restricted'].includes(status)) {
        return true;
      }
    }
  } catch (err) {
    console.error(`[ForceSub] getChatMember error chat ${numChatId}:`, err.message);
  }

  // Check pending or approved join request in MongoDB (for private channels with Request to Join)
  try {
    const req = await JoinRequest.findOne({
      userId: { $in: [numUserId, String(numUserId)] },
      chatId: { $in: [numChatId, String(numChatId)] },
      status: { $in: ['pending', 'approved'] },
    });
    if (req) {
      return true;
    }
  } catch (err) {
    console.error('[ForceSub] JoinRequest check error:', err.message);
  }

  return false;
}

/**
 * Check all force subscribe channels for a user
 * @param {number} userId - Telegram user ID
 * @param {boolean} ignoreAdmin - Pass true when admin tests on self
 */
export async function checkForceSub(userId, ignoreAdmin = false) {
  const enabled = await isForceSubEnabled();
  if (!enabled) {
    return { joined: true, channels: [] };
  }

  const adminBypass = await isAdminBypassEnabled();
  if (adminBypass && !ignoreAdmin && CONFIG.ADMINS.includes(Number(userId))) {
    return { joined: true };
  }

  const channels = await getActiveForceSubChannels();
  if (!channels || channels.length === 0) {
    return { joined: true, channels: [] };
  }

  const missing = [];
  for (const ch of channels) {
    const ok = await isUserInChat(ch.id, userId);
    if (!ok) {
      missing.push(ch);
    }
  }

  if (missing.length > 0) {
    return { joined: false, missing, channels };
  }

  return { joined: true, channels };
}

/**
 * Build inline keyboard for Force Sub channels dynamically
 */
export function buildForceSubKeyboard(channels = [], showVerify = true) {
  const keyboard = [];
  for (let i = 0; i < channels.length; i += 2) {
    const row = [
      { text: channels[i].name || `Channel ${i + 1} 📢`, url: channels[i].url },
    ];
    if (channels[i + 1]) {
      row.push({ text: channels[i + 1].name || `Channel ${i + 2} 📢`, url: channels[i + 1].url });
    }
    keyboard.push(row);
  }
  if (CONFIG.UPDATE_CHANNEL_URL) {
    keyboard.push([{ text: 'Updates Channel 📢', url: CONFIG.UPDATE_CHANNEL_URL }]);
  }
  if (showVerify) {
    keyboard.push([{ text: '🔄 Verify / I Have Joined', callback_data: 'forcesub_check' }]);
  }
  return { inline_keyboard: keyboard };
}

/**
 * Send parsed file details and stream/download links to the configured Dump Channel
 */
export async function sendToDumpChannel({ file, user, originalUrl, downloadLink, streamLink }) {
  const dumpChatId = await getDumpChannelId();
  if (!dumpChatId) return null;

  const fileName = file.name || 'TeraBox_File';
  const fileSize = file.size || 'Unknown';
  const userMention = user.username
    ? `@${user.username}`
    : `[${user.firstName || 'User'}](tg://user?id=${user.id})`;

  const caption =
    `📦 *TeraBox File Dump*\n\n` +
    `📁 *File Name:* \`${fileName}\`\n` +
    `💾 *Size:* \`${fileSize}\`\n` +
    `👤 *Requested By:* ${userMention} (\`${user.id}\`)\n` +
    `🔗 *Original Link:* ${originalUrl}\n` +
    `⏰ *Time:* \`${new Date().toUTCString()}\``;

  const buttons = [
    [{ text: '⬇️ Direct Download', url: downloadLink }],
    [{ text: '▶️ Watch / Stream Online', url: streamLink }],
  ];

  try {
    if (file.thumbnail && file.thumbnail.startsWith('http')) {
      return await tgCall('sendPhoto', {
        chat_id: dumpChatId,
        photo: file.thumbnail,
        caption,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      });
    } else {
      return await tgCall('sendMessage', {
        chat_id: dumpChatId,
        text: caption,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      });
    }
  } catch (err) {
    console.error(`[DumpChannel] Failed to post to ${dumpChatId}:`, err.message);
    return null;
  }
}

/**
 * Generate VPLink shortened ad url for /gen
 */
export async function generateShortlink(userId) {
  const uid = crypto.randomUUID();
  const targetUrl = `https://t.me/${CONFIG.BOT_USERNAME}?start=token_${uid}`;

  if (!CONFIG.SHORTLINK_API_KEY) {
    return { uid, url: targetUrl };
  }

  const endpoints = [CONFIG.SHORTLINK_API_URL, 'https://vplink.in/api', 'https://vplinks.in/api'];

  for (const ep of endpoints) {
    try {
      const u = new URL(ep);
      u.searchParams.set('api', CONFIG.SHORTLINK_API_KEY);
      u.searchParams.set('url', targetUrl);
      u.searchParams.set('alias', uid.split('-')[0]);

      const res = await fetch(u.toString(), { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'success' && data.shortenedUrl) {
          return { uid, url: data.shortenedUrl };
        }
      }
    } catch (e) {
      console.warn(`[Shortlink] Failed endpoint ${ep}:`, e.message);
    }
  }

  return { uid, url: targetUrl };
}

/**
 * Check if a user is within daily link limit or is an unlimited Android App user / Admin
 */
export async function checkUserLimit(userId) {
  const numUserId = Number(userId);

  // Admins always have unlimited downloads
  if (CONFIG.ADMINS.includes(numUserId)) {
    return { allowed: true, isAppUser: true, isAdmin: true, remaining: Infinity };
  }

  try {
    const user = await BotUser.findOne({ user_id: numUserId });

    // App users have 100% UNLIMITED downloads
    if (user && user.is_app_user) {
      return { allowed: true, isAppUser: true, isAdmin: false, remaining: Infinity };
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const count = (user && user.last_usage_date === todayStr) ? (user.daily_count || 0) : 0;
    const limit = CONFIG.DAILY_LIMIT || 5;

    if (count >= limit) {
      return { allowed: false, isAppUser: false, count, limit, remaining: 0 };
    }

    return { allowed: true, isAppUser: false, count, limit, remaining: limit - count };
  } catch (e) {
    console.error('[Limit] Error checking user limit:', e.message);
    return { allowed: true, isAppUser: false, remaining: 1 };
  }
}

/**
 * Increment daily usage for a user
 */
export async function incrementUserUsage(userId) {
  const numUserId = Number(userId);
  const todayStr = new Date().toISOString().slice(0, 10);

  try {
    const user = await BotUser.findOne({ user_id: numUserId });
    if (user && user.last_usage_date === todayStr) {
      const newCount = (user.daily_count || 0) + 1;
      await BotUser.updateOne(
        { user_id: numUserId },
        { $set: { daily_count: newCount, updated_at: new Date() } }
      );
      return newCount;
    } else {
      await BotUser.updateOne(
        { user_id: numUserId },
        { $set: { daily_count: 1, last_usage_date: todayStr, updated_at: new Date() } },
        { upsert: true }
      );
      return 1;
    }
  } catch (e) {
    console.error('[Limit] Error incrementing usage:', e.message);
    return 1;
  }
}

/**
 * Mark user as an Android Mobile App user (Unlimited status)
 */
export async function markUserAsAppUser(userId) {
  const numUserId = Number(userId);
  try {
    await BotUser.updateOne(
      { user_id: numUserId },
      { $set: { is_app_user: true, app_linked_at: new Date(), updated_at: new Date() } },
      { upsert: true }
    );
    console.log(`[AppUser] User ${numUserId} verified as Android App User (Unlimited status)`);
  } catch (e) {
    console.error('[AppUser] Error saving app user:', e.message);
  }
}
