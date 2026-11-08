import { CONFIG } from './config.js';
import crypto from 'node:crypto';

const TELEGRAM_API = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}`;

/**
 * Call Telegram Bot API
 */
export async function tgCall(method, payload) {
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
 * Check if user is member of a specific Telegram chat/channel
 */
export async function isUserInChat(chatId, userId) {
  try {
    const res = await tgCall('getChatMember', {
      chat_id: chatId,
      user_id: userId,
    });
    if (res.ok && res.result) {
      const status = res.result.status;
      return ['creator', 'administrator', 'member', 'restricted'].includes(status);
    }
    return false;
  } catch (err) {
    console.error(`[ForceSub] Error checking chat ${chatId}:`, err.message);
    return false;
  }
}

/**
 * Check all force subscribe channels
 */
export async function checkForceSub(userId) {
  if (!CONFIG.FORCE_SUB_ENABLED || CONFIG.ADMINS.includes(userId)) {
    return { joined: true };
  }

  for (const ch of CONFIG.FORCE_SUB_CHANNELS) {
    const ok = await isUserInChat(ch.id, userId);
    if (!ok) {
      return { joined: false, missing: ch };
    }
  }

  return { joined: true };
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

