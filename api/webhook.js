import { CONFIG } from '../config.js';
import { connectMongo, BotUser, BotSession } from '../db.js';
import {
  tgCall,
  extractTeraboxUrl,
  checkForceSub,
  generateShortlink,
} from '../telegram.js';

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  // Allow GET for quick health check or webhook setup
  if (req.method === 'GET') {
    const { setup, url } = req.query;
    if (setup === '1' && url) {
      const setRes = await tgCall('setWebhook', { url });
      return res.status(200).json({ status: 'Webhook setup requested', result: setRes });
    }
    const info = await tgCall('getWebhookInfo', {});
    return res.status(200).json({ status: 'TeraBox Telegram Vercel Bot is Running!', webhookInfo: info });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const update = req.body;
  if (!update || (!update.message && !update.callback_query)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  // Acknowledge Telegram quickly
  res.status(200).json({ ok: true });

  try {
    await connectMongo();

    // 1. Handle Callback Queries (Buttons)
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return;
    }

    // 2. Handle Messages
    if (update.message) {
      await handleMessage(update.message);
    }
  } catch (err) {
    console.error('[Webhook] Unhandled error:', err);
  }
}

/**
 * Handle incoming Telegram messages
 */
async function handleMessage(m) {
  const chatId = m.chat.id;
  const userId = m.from?.id;
  const text = (m.text || '').trim();
  const firstName = m.from?.first_name || '';
  const username = m.from?.username || '';

  // Save / Update Bot User in DB asynchronously
  if (userId) {
    BotUser.updateOne(
      { user_id: userId },
      { $set: { user_id: userId, first_name: firstName, username: username, updated_at: new Date() } },
      { upsert: true }
    ).catch((e) => console.error('[DB] Save user error:', e.message));
  }

  // Command: /start
  if (text.startsWith('/start')) {
    const parts = text.split(' ');
    const arg = parts[1] || '';

    // Check if token activation via /start token_UUID
    if (arg.startsWith('token_')) {
      const tokenId = arg.replace('token_', '').trim();
      return await handleTokenActivation(chatId, userId, tokenId);
    }

    // Normal /start welcome
    return await handleStartCommand(chatId, userId, firstName);
  }

  // Command: /gen (Generate Ad Token)
  if (text === '/gen') {
    return await handleGenCommand(chatId, userId, firstName);
  }

  // Command: /id
  if (text === '/id') {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: `Your Chat ID: \`${chatId}\``,
      parse_mode: 'Markdown',
    });
  }

  // Command: /stats (Admins only)
  if (text === '/stats') {
    if (CONFIG.ADMINS.includes(userId)) {
      const userCount = await BotUser.countDocuments();
      const activeSessions = await BotSession.countDocuments({
        token_id: 'ACTIVE_WINDOW',
        expires_at: { $gt: new Date() },
      });
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: `📊 *Bot Statistics (Vercel Serverless)*\n\n• *Total Users:* \`${userCount}\`\n• *Active Token Sessions:* \`${activeSessions}\`\n• *API Base:* \`${CONFIG.TERABOX_API_BASE}\``,
        parse_mode: 'Markdown',
      });
    }
  }

  // Check if message contains a TeraBox link
  const teraboxUrl = extractTeraboxUrl(text);
  if (teraboxUrl) {
    return await handleTeraboxLink(chatId, userId, teraboxUrl, m.message_id);
  }
}

/**
 * Handle /start command
 */
async function handleStartCommand(chatId, userId, firstName) {
  const subCheck = await checkForceSub(userId);

  const welcomeText = `👋 *Hello ${firstName || 'Friend'}!*\n\nI am your *TeraBox Direct Downloader Bot* powered by fast serverless cloud!\n\nJust send me any *TeraBox link* and I will instantly give you:\n• ⬇️ *Direct High-Speed Download Link*\n• ▶️ *Direct Online Streaming Link*\n\n_No VPS delay, zero wait time!_ 🚀`;

  if (!subCheck.joined) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: `${welcomeText}\n\n⚠️ *Please join our official channels to use this bot:*`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: CONFIG.FORCE_SUB_CHANNELS[0].name, url: CONFIG.FORCE_SUB_CHANNELS[0].url },
            { text: CONFIG.FORCE_SUB_CHANNELS[1].name, url: CONFIG.FORCE_SUB_CHANNELS[1].url },
          ],
          [
            { text: CONFIG.FORCE_SUB_CHANNELS[2].name, url: CONFIG.FORCE_SUB_CHANNELS[2].url },
            { text: 'Updates 📢', url: CONFIG.UPDATE_CHANNEL_URL },
          ],
        ],
      },
    });
  }

  return await tgCall('sendMessage', {
    chat_id: chatId,
    text: welcomeText,
    parse_mode: 'Markdown',
  });
}

/**
 * Handle /gen command for Ads Token
 */
async function handleGenCommand(chatId, userId, firstName) {
  if (!CONFIG.USE_TOKEN_SYSTEM) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '✅ The token system is currently *disabled*. You can send TeraBox links directly!',
      parse_mode: 'Markdown',
    });
  }

  // Check if session is already active
  const active = await BotSession.findOne({
    user_id: userId,
    token_id: 'ACTIVE_WINDOW',
    expires_at: { $gt: new Date() },
  });

  if (active) {
    const minsLeft = Math.max(1, Math.round((active.expires_at - new Date()) / 60000));
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: `✅ *You are already active!*\nYour session will expire in *${minsLeft} minutes*. Send your TeraBox links directly.`,
      parse_mode: 'Markdown',
    });
  }

  const { uid, url } = await generateShortlink(userId);

  // Store token in MongoDB with 6 hour expiration
  await BotSession.create({
    user_id: userId,
    token_id: uid,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 6 * 3600 * 1000),
  });

  const text = `Hey *${firstName || 'User'}*!\n\nYour 1-hour ad token has expired. Complete this 1 quick ad link to activate the bot for the next *1 hour*:\n\n⏳ *Token Validity:* 1 Hour`;

  return await tgCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '🔓 Click Here To Refresh Token', url }]],
    },
  });
}

/**
 * Handle activation when user visits /start token_UUID
 */
async function handleTokenActivation(chatId, userId, tokenId) {
  const tokenDoc = await BotSession.findOne({ token_id: tokenId });

  if (!tokenDoc) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '❌ *Invalid or Expired Token!*\n\nPlease send /gen to generate a new token.',
      parse_mode: 'Markdown',
    });
  }

  if (tokenDoc.user_id !== userId) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '❌ This token belongs to another user. Please send /gen to get your own.',
      parse_mode: 'Markdown',
    });
  }

  // Anti-bypass check: ensure user didn't instantly click within MIN_SHORTLINK_TIME seconds
  const elapsedSec = (Date.now() - new Date(tokenDoc.created_at).getTime()) / 1000;
  if (elapsedSec < CONFIG.MIN_SHORTLINK_TIME && !CONFIG.ADMINS.includes(userId)) {
    await BotSession.deleteOne({ _id: tokenDoc._id });
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '❌ *Ad Bypass Detected!*\nPlease complete the link honestly without skipping.',
      parse_mode: 'Markdown',
    });
  }

  // Delete used token and activate 1 hour window
  await BotSession.deleteOne({ _id: tokenDoc._id });
  await BotSession.create({
    user_id: userId,
    token_id: 'ACTIVE_WINDOW',
    created_at: new Date(),
    expires_at: new Date(Date.now() + 3600 * 1000), // 1 hour
  });

  return await tgCall('sendMessage', {
    chat_id: chatId,
    text: '✅ *Account Activated Successfully!*\n\nYour session is active for *1 hour*. Send any TeraBox link to get instant download and stream links!',
    parse_mode: 'Markdown',
  });
}

/**
 * Handle TeraBox URL resolution and reply with Stream & Download buttons
 */
async function handleTeraboxLink(chatId, userId, url, replyToId) {
  // 1. Force Sub Check
  const subCheck = await checkForceSub(userId);
  if (!subCheck.joined) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '⚠️ *You must join our channels before downloading!*\n\nPlease join the channels below and send the link again:',
      parse_mode: 'Markdown',
      reply_to_message_id: replyToId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: CONFIG.FORCE_SUB_CHANNELS[0].name, url: CONFIG.FORCE_SUB_CHANNELS[0].url },
            { text: CONFIG.FORCE_SUB_CHANNELS[1].name, url: CONFIG.FORCE_SUB_CHANNELS[1].url },
          ],
          [
            { text: CONFIG.FORCE_SUB_CHANNELS[2].name, url: CONFIG.FORCE_SUB_CHANNELS[2].url },
            { text: 'Updates 📢', url: CONFIG.UPDATE_CHANNEL_URL },
          ],
        ],
      },
    });
  }

  // 2. Token system check
  if (CONFIG.USE_TOKEN_SYSTEM && !CONFIG.ADMINS.includes(userId)) {
    const active = await BotSession.findOne({
      user_id: userId,
      token_id: 'ACTIVE_WINDOW',
      expires_at: { $gt: new Date() },
    });
    if (!active) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '⚠️ *Your 1-hour session has expired!*\n\nPlease send /gen to activate the bot with a quick ad.',
        parse_mode: 'Markdown',
        reply_to_message_id: replyToId,
      });
    }
  }

  // 3. Send "Searching / Fetching" message
  const statusRes = await tgCall('sendMessage', {
    chat_id: chatId,
    text: '🔍 *Fetching file details from TeraBox servers...*',
    parse_mode: 'Markdown',
    reply_to_message_id: replyToId,
  });
  const statusMsgId = statusRes?.result?.message_id;

  try {
    // 4. Call Vercel API /parse
    const parseEndpoint = new URL(`${CONFIG.TERABOX_API_BASE}/parse`);
    parseEndpoint.searchParams.set('url', url);
    parseEndpoint.searchParams.set('apiKey', CONFIG.TERABOX_API_KEY);
    parseEndpoint.searchParams.set('from', 'bot');

    const apiRes = await fetch(parseEndpoint.toString(), {
      signal: AbortSignal.timeout(25000),
    });

    if (!apiRes.ok) {
      const errData = await apiRes.json().catch(() => ({}));
      const msg = errData.error || 'API response was invalid or server is busy.';
      return await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: statusMsgId,
        text: `❌ *Error:* ${msg}`,
        parse_mode: 'Markdown',
      });
    }

    const result = await apiRes.json();
    const files = result?.list || [];

    if (!files.length) {
      return await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: statusMsgId,
        text: '❌ *No downloadable file found in this link.* It may be expired or password protected.',
        parse_mode: 'Markdown',
      });
    }

    // Support single file or multiple files
    for (let i = 0; i < Math.min(files.length, 5); i++) {
      const file = files[i];
      const fileName = file.name || 'TeraBox_File';
      const fileSize = file.size || 'Unknown';
      const downloadLink = file.dlink || file.download_url;
      const streamLink = file.stream_url || downloadLink;

      if (!downloadLink) {
        continue;
      }

      const buttons = [];

      // Download Button
      buttons.push([
        { text: '⬇️ Direct Fast Download', url: downloadLink },
      ]);

      // Stream Button (if available)
      if (streamLink) {
        buttons.push([
          { text: '▶️ Watch / Stream Online', url: streamLink },
        ]);
      }

      const caption = `📁 *File Name:* \`${fileName}\`\n📦 *Size:* \`${fileSize}\`\n\n⚡ *Status:* \`Ready for Download & Stream\`\n_Click the buttons below to open directly in your browser or player:_`;

      // If thumbnail is available, send as photo
      if (file.thumbnail && file.thumbnail.startsWith('http')) {
        await tgCall('sendPhoto', {
          chat_id: chatId,
          photo: file.thumbnail,
          caption,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        });
      } else {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: caption,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        });
      }
    }

    // Delete or edit initial status message
    if (statusMsgId) {
      await tgCall('deleteMessage', { chat_id: chatId, message_id: statusMsgId });
    }
  } catch (err) {
    console.error('[Bot Error]:', err);
    if (statusMsgId) {
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: statusMsgId,
        text: `❌ *Failed to fetch links:* ${err.message || 'Timeout/Network error'}`,
        parse_mode: 'Markdown',
      });
    }
  }
}

/**
 * Handle Callback Query (if user clicks inline buttons)
 */
async function handleCallback(cq) {
  await tgCall('answerCallbackQuery', {
    callback_query_id: cq.id,
    text: 'Redirecting to your link...',
  });
}

