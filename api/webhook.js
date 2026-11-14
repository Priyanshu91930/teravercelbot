import { CONFIG } from '../config.js';
import {
  connectMongo,
  BotUser,
  BotSession,
  ForceSubChannel,
  AdminState,
  BotSetting,
  JoinRequest,
} from '../db.js';
import {
  tgCall,
  extractTeraboxUrl,
  checkForceSub,
  generateShortlink,
  getActiveForceSubChannels,
  isForceSubEnabled,
  isTokenSystemEnabled,
  isAdminBypassEnabled,
  getDumpChannelId,
  sendToDumpChannel,
  buildForceSubKeyboard,
} from '../telegram.js';

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  // Allow GET for quick health check or webhook setup
  if (req.method === 'GET') {
    const { setup, url } = req.query;
    if (setup === '1' && url) {
      const setRes = await tgCall('setWebhook', {
        url,
        allowed_updates: ['message', 'callback_query', 'chat_join_request', 'chat_member'],
      });
      return res.status(200).json({ status: 'Webhook setup requested', result: setRes });
    }
    const info = await tgCall('getWebhookInfo', {});
    return res.status(200).json({ status: 'TeraBox Telegram Vercel Bot is Running!', webhookInfo: info });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const update = req.body;
  if (!update) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  try {
    if (CONFIG.MONGODB_URI) {
      await connectMongo();
    }

    // 0. Handle Chat Join Requests (for private channel auto-verification)
    if (update.chat_join_request) {
      await handleJoinRequest(update.chat_join_request);
      return res.status(200).json({ ok: true });
    }

    // 0.1 Handle Chat Member Updates (if user leaves, revoke pending request)
    if (update.chat_member) {
      await handleChatMember(update.chat_member);
      return res.status(200).json({ ok: true });
    }

    // 1. Handle Callback Queries (Buttons)
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return res.status(200).json({ ok: true });
    }

    // 2. Handle Messages
    if (update.message) {
      await handleMessage(update.message);
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Webhook] Unhandled error:', err);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

/**
 * Handle Telegram Chat Join Request (User clicked "Request to Join Channel")
 */
async function handleJoinRequest(cjr) {
  try {
    const userId = cjr.from?.id;
    const chatId = cjr.chat?.id;
    if (!userId || !chatId) return;

    await JoinRequest.updateOne(
      { userId: Number(userId), chatId: Number(chatId) },
      { $set: { userId: Number(userId), chatId: Number(chatId), status: 'pending', createdAt: new Date() } },
      { upsert: true }
    );
    console.log(`[JoinRequest] Recorded join request for user ${userId} in chat ${chatId}`);
  } catch (e) {
    console.error('[JoinRequest] Error saving request to DB:', e.message);
  }
}

/**
 * Handle Telegram Chat Member updates (user joins, leaves or is banned)
 */
async function handleChatMember(cm) {
  try {
    const userId = cm.user?.id || cm.from?.id;
    const chatId = cm.chat?.id;
    const newStatus = cm.new_chat_member?.status;
    if (!userId || !chatId) return;

    const numUserId = Number(userId);
    const numChatId = Number(chatId);

    if (['left', 'kicked'].includes(newStatus)) {
      await JoinRequest.deleteMany({
        userId: { $in: [numUserId, String(numUserId)] },
        chatId: { $in: [numChatId, String(numChatId)] },
      });
      console.log(`[ChatMember] User ${numUserId} left or kicked from chat ${numChatId}, removed JoinRequest`);
    } else if (['member', 'administrator', 'creator'].includes(newStatus)) {
      await JoinRequest.updateOne(
        { userId: numUserId, chatId: numChatId },
        { $set: { status: 'approved' } }
      );
    }
  } catch (e) {
    console.error('[ChatMember] Error processing chat_member update:', e.message);
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
  const isAdmin = CONFIG.ADMINS.includes(userId);

  // Save / Update Bot User in DB asynchronously
  if (userId) {
    BotUser.updateOne(
      { user_id: userId },
      { $set: { user_id: userId, first_name: firstName, username: username, updated_at: new Date() } },
      { upsert: true }
    ).catch((e) => console.error('[DB] Save user error:', e.message));
  }

  // ── ADMIN STATE MACHINE (Adding Channel via Forward or Link) ──
  if (isAdmin) {
    const adminState = await AdminState.findOne({ user_id: userId });
    if (adminState) {
      if (text === '/cancel') {
        await AdminState.deleteOne({ user_id: userId });
        return await tgCall('sendMessage', {
          chat_id: chatId,
          text: '✅ Action cancelled. Send /settings to open the panel.',
        });
      }

      if (adminState.state === 'AWAITING_FORWARD') {
        return await handleForwardedChannel(m, adminState);
      }

      if (adminState.state === 'AWAITING_INVITE_LINK') {
        return await handleCustomInviteLink(m, adminState);
      }

      if (adminState.state === 'AWAITING_DUMP_FORWARD') {
        return await handleForwardedDumpChannel(m, adminState);
      }
    }
  }

  // Command: /cancel
  if (text === '/cancel') {
    if (isAdmin) {
      await AdminState.deleteOne({ user_id: userId });
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '✅ Action cancelled. Send /settings to open settings.',
      });
    }
  }

  // Command: /settings (Admins only)
  if (text === '/settings') {
    if (!isAdmin) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '❌ *Access Denied:* This command is restricted to bot administrators only.',
        parse_mode: 'Markdown',
      });
    }
    await AdminState.deleteOne({ user_id: userId });
    const panel = await getSettingsPanelData();
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: panel.text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: panel.reply_markup,
    });
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
      text: `Your Chat ID: \`${chatId}\`\nYour User ID: \`${userId}\``,
      parse_mode: 'Markdown',
    });
  }

  // Command: /stats (Admins only)
  if (text === '/stats') {
    if (isAdmin) {
      const userCount = await BotUser.countDocuments();
      const activeSessions = await BotSession.countDocuments({
        token_id: 'ACTIVE_WINDOW',
        expires_at: { $gt: new Date() },
      });
      const channelCount = (await getActiveForceSubChannels()).length;
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: `📊 *Bot Statistics (Vercel Serverless)*\n\n• *Total Users:* \`${userCount}\`\n• *Active Token Sessions:* \`${activeSessions}\`\n• *Force Sub Channels:* \`${channelCount}\`\n• *API Base:* \`${CONFIG.TERABOX_API_BASE}\``,
        parse_mode: 'Markdown',
      });
    }
  }

  // Command: /setdump (Admins only)
  if (text.startsWith('/setdump')) {
    if (!isAdmin) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '❌ *Access Denied:* Admin command only.',
        parse_mode: 'Markdown',
      });
    }

    const parts = text.split(' ');
    const targetChat = parts[1]?.trim();

    if (targetChat) {
      const channelId = Number(targetChat);
      if (isNaN(channelId)) {
        return await tgCall('sendMessage', {
          chat_id: chatId,
          text: '❌ Invalid channel ID format. Must be numeric (e.g. `-100xxxxxxxxxx`).',
          parse_mode: 'Markdown',
        });
      }
      return await applyDumpChannel(chatId, channelId, 'Dump Channel 📢', userId);
    }

    // Set admin state to wait for forwarded message
    await AdminState.updateOne(
      { user_id: userId },
      { $set: { state: 'AWAITING_DUMP_FORWARD', data: {}, updated_at: new Date() } },
      { upsert: true }
    );

    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: `📢 *Set Dump Channel*\n\n👉 *Please forward any message from your Dump Channel* (\`https://t.me/+hbVmKnNuuwFlMGQ1\`) to this chat.\n\n⚠️ *Important:* Ensure @${CONFIG.BOT_USERNAME || 'the bot'} is added as an *Administrator* with "Post Messages" permission in that channel!\n\nOr send \`/setdump <channel_id>\`, or send /cancel to abort.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'settings_home' }]],
      },
    });
  }

  // Check if message contains a TeraBox link
  const teraboxUrl = extractTeraboxUrl(text);
  if (teraboxUrl) {
    return await handleTeraboxLink(chatId, userId, teraboxUrl, m.message_id, { username, firstName });
  }
}

/**
 * Handle admin forwarding a message from the channel to add it
 */
async function handleForwardedChannel(m, adminState) {
  const chatId = m.chat.id;
  const userId = m.from.id;

  // Telegram forwarded messages can come in forward_from_chat or forward_origin.chat
  const fwdChat = m.forward_from_chat || m.forward_origin?.chat;

  if (!fwdChat) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '⚠️ *That was not a forwarded message from a channel or group!*\n\nPlease forward any message directly from the target channel, or send /cancel to abort.',
      parse_mode: 'Markdown',
    });
  }

  const channelId = Number(fwdChat.id);
  const channelTitle = fwdChat.title || 'Channel 📢';

  // 1. Verify that the bot is an Administrator in that channel
  const meRes = await tgCall('getMe', {});
  const botId = meRes?.result?.id;

  if (botId) {
    const memberRes = await tgCall('getChatMember', {
      chat_id: channelId,
      user_id: botId,
    });

    if (!memberRes.ok || !['administrator', 'creator'].includes(memberRes.result?.status)) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: `⚠️ *Bot is not an administrator in that channel!*\n\n• *Channel:* *${channelTitle}*\n• *ID:* \`${channelId}\`\n\n👉 *Please promote @${CONFIG.BOT_USERNAME || 'the bot'} as an Admin in "${channelTitle}" with "Invite Users" rights*, and then forward the message again.\n\nSend /cancel to abort.`,
        parse_mode: 'Markdown',
      });
    }
  }

  // 2. Try to obtain invite link automatically
  let inviteUrl = '';
  if (fwdChat.username) {
    inviteUrl = `https://t.me/${fwdChat.username}`;
  } else {
    const invRes = await tgCall('exportChatInviteLink', { chat_id: channelId });
    if (invRes.ok && invRes.result) {
      inviteUrl = invRes.result;
    }
  }

  if (inviteUrl) {
    // Save channel directly in MongoDB
    await ForceSubChannel.updateOne(
      { chat_id: channelId },
      { $set: { chat_id: channelId, name: channelTitle, url: inviteUrl, created_at: new Date() } },
      { upsert: true }
    );
    await AdminState.deleteOne({ user_id: userId });

    await tgCall('sendMessage', {
      chat_id: chatId,
      text: `✅ *Channel Added Successfully!*\n\n• *Name:* *${channelTitle}*\n• *ID:* \`${channelId}\`\n• *Invite Link:* ${inviteUrl}\n\nThis channel is now active in Force Sub!`,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });

    const panel = await getSettingsPanelData();
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: panel.text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: panel.reply_markup,
    });
  }

  // If automatic invite link creation failed, ask admin to paste the invite link
  await AdminState.updateOne(
    { user_id: userId },
    {
      $set: {
        state: 'AWAITING_INVITE_LINK',
        data: { channelId, channelTitle },
        updated_at: new Date(),
      },
    },
    { upsert: true }
  );

  return await tgCall('sendMessage', {
    chat_id: chatId,
    text: `✅ *Channel Detected!*\n\n• *Name:* *${channelTitle}*\n• *ID:* \`${channelId}\`\n\n🔗 *Now please send the Invite Link for this channel:*\n(e.g. \`https://t.me/+abcd1234...\`)\n\nOr send /cancel to abort.`,
    parse_mode: 'Markdown',
  });
}

/**
 * Handle admin sending custom invite link
 */
async function handleCustomInviteLink(m, adminState) {
  const chatId = m.chat.id;
  const userId = m.from.id;
  const link = (m.text || '').trim();

  if (!link.startsWith('http')) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '⚠️ Invalid link. Please send a valid Telegram link starting with `https://t.me/...`, or send /cancel to abort.',
      parse_mode: 'Markdown',
    });
  }

  const { channelId, channelTitle } = adminState.data || {};
  if (!channelId) {
    await AdminState.deleteOne({ user_id: userId });
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '❌ Session expired. Please send /settings and try again.',
    });
  }

  await ForceSubChannel.updateOne(
    { chat_id: channelId },
    { $set: { chat_id: channelId, name: channelTitle || 'Channel 📢', url: link, created_at: new Date() } },
    { upsert: true }
  );
  await AdminState.deleteOne({ user_id: userId });

  await tgCall('sendMessage', {
    chat_id: chatId,
    text: `✅ *Channel Added Successfully!*\n\n• *Name:* *${channelTitle || 'Channel'}*\n• *ID:* \`${channelId}\`\n• *Invite Link:* ${link}\n\nThis channel is now active in Force Sub!`,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });

  const panel = await getSettingsPanelData();
  return await tgCall('sendMessage', {
    chat_id: chatId,
    text: panel.text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: panel.reply_markup,
  });
}

/**
 * Handle admin forwarding a message from the dump channel to configure it
 */
async function handleForwardedDumpChannel(m, adminState) {
  const chatId = m.chat.id;
  const userId = m.from.id;

  const fwdChat = m.forward_from_chat || m.forward_origin?.chat;
  if (!fwdChat) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '⚠️ *That was not a forwarded message from a channel!*\n\nPlease forward any message directly from the target Dump Channel, or send /cancel to abort.',
      parse_mode: 'Markdown',
    });
  }

  const channelId = Number(fwdChat.id);
  const channelTitle = fwdChat.title || 'Dump Channel 📢';
  return await applyDumpChannel(chatId, channelId, channelTitle, userId);
}

/**
 * Validate and save Dump Channel
 */
async function applyDumpChannel(chatId, channelId, channelTitle, userId = null) {
  // Test if bot can post to that channel
  const testRes = await tgCall('sendMessage', {
    chat_id: channelId,
    text: `🚀 *Dump Channel Connected!*\n\nTeraBox Vercel Bot will automatically dump all parsed files and download links here.`,
    parse_mode: 'Markdown',
  });

  if (!testRes.ok) {
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: `⚠️ *Cannot post to that channel!*\n\n• *Channel:* *${channelTitle}*\n• *ID:* \`${channelId}\`\n• *Error:* \`${testRes.description || 'Forbidden/Not admin'}\`\n\n👉 *Please make sure @${CONFIG.BOT_USERNAME || 'the bot'} is an Administrator in that channel with "Post Messages" rights!*`,
      parse_mode: 'Markdown',
    });
  }

  await BotSetting.updateOne(
    { key: 'DUMP_CHANNEL_ID' },
    { $set: { key: 'DUMP_CHANNEL_ID', value: channelId, updated_at: new Date() } },
    { upsert: true }
  );

  if (userId) {
    await AdminState.deleteOne({ user_id: userId });
  }

  await tgCall('sendMessage', {
    chat_id: chatId,
    text: `✅ *Dump Channel Configured Successfully!*\n\n• *Name:* *${channelTitle}*\n• *ID:* \`${channelId}\`\n\nAll downloaded TeraBox files and stream links will now be dumped to this channel! 🚀`,
    parse_mode: 'Markdown',
  });

  const panel = await getSettingsPanelData();
  return await tgCall('sendMessage', {
    chat_id: chatId,
    text: panel.text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: panel.reply_markup,
  });
}

/**
 * Generate Settings Panel text and buttons
 */
async function getSettingsPanelData() {
  const forceSubOn = await isForceSubEnabled();
  const tokenOn = await isTokenSystemEnabled();
  const adminBypassOn = await isAdminBypassEnabled();
  const dumpChannelId = await getDumpChannelId();
  const channels = await getActiveForceSubChannels();

  let channelListText = '';
  if (!channels || channels.length === 0) {
    channelListText = '_No channels configured yet._';
  } else {
    channelListText = channels
      .map((c, idx) => `${idx + 1}. *${c.name}* (\`${c.id}\`)\n   🔗 [Invite Link](${c.url})`)
      .join('\n');
  }

  const text = `⚙️ *Bot Admin Settings Panel*\n\n` +
    `• *Force Subscription:* ${forceSubOn ? '✅ Enabled' : '❌ Disabled'}\n` +
    `• *Admin ForceSub Bypass:* ${adminBypassOn ? '✅ ON (Admins skip)' : '❌ OFF (Admins checked)'}\n` +
    `• *Token System (/gen):* ${tokenOn ? '✅ Enabled' : '❌ Disabled'}\n` +
    `• *Dump Channel:* ${dumpChannelId ? `\`${dumpChannelId}\`` : '❌ Not Set'}\n` +
    `• *Active Channels:* \`${channels.length}\`\n\n` +
    `📢 *Current Force Sub Channels:*\n${channelListText}\n\n` +
    `_Use the buttons below to configure channels, settings, and dumps:_`;

  const buttons = [
    [
      { text: '➕ Add Channel', callback_data: 'settings_add_channel' },
      { text: '🗑️ Delete Channel', callback_data: 'settings_del_menu' },
    ],
    [
      { text: `Force Sub: ${forceSubOn ? '✅ ON' : '❌ OFF'}`, callback_data: 'toggle_forcesub' },
      { text: `Token System: ${tokenOn ? '✅ ON' : '❌ OFF'}`, callback_data: 'toggle_token' },
    ],
    [
      { text: `Admin Bypass: ${adminBypassOn ? '✅ ON' : '❌ OFF'}`, callback_data: 'toggle_admin_bypass' },
      { text: '📢 Set Dump Channel', callback_data: 'settings_set_dump' },
    ],
    [
      { text: '🧪 Test Force Sub On Myself', callback_data: 'test_forcesub' },
      { text: '🔒 Close Panel', callback_data: 'close_settings' },
    ],
  ];

  return { text, reply_markup: { inline_keyboard: buttons } };
}

/**
 * Handle /start command
 */
async function handleStartCommand(chatId, userId, firstName) {
  const subCheck = await checkForceSub(userId);

  const welcomeText = `👋 *Hello ${firstName || 'Friend'}!*\n\nI am your *TeraBox Direct Downloader Bot* powered by fast serverless cloud!\n\nJust send me any *TeraBox link* and I will instantly give you:\n• ⬇️ *Direct High-Speed Download Link*\n• ▶️ *Direct Online Streaming Link*\n\n_No VPS delay, zero wait time!_ 🚀`;

  if (!subCheck.joined) {
    const keyboard = buildForceSubKeyboard(subCheck.channels || []);
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: `${welcomeText}\n\n⚠️ *Please join our official channels to use this bot:*`,
      parse_mode: 'Markdown',
      reply_markup: keyboard,
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
  const tokenEnabled = await isTokenSystemEnabled();
  if (!tokenEnabled) {
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
async function handleTeraboxLink(chatId, userId, url, replyToId, userInfo = {}) {
  // 1. Force Sub Check
  const subCheck = await checkForceSub(userId);
  if (!subCheck.joined) {
    const keyboard = buildForceSubKeyboard(subCheck.channels || []);
    return await tgCall('sendMessage', {
      chat_id: chatId,
      text: '⚠️ *You must join our channels before downloading!*\n\nPlease join the channels below and send the link again:',
      parse_mode: 'Markdown',
      reply_to_message_id: replyToId,
      reply_markup: keyboard,
    });
  }

  // 2. Token system check
  const tokenEnabled = await isTokenSystemEnabled();
  if (tokenEnabled && !CONFIG.ADMINS.includes(userId)) {
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
      const rawLink = file.dlink || file.download_url;

      if (!rawLink) {
        continue;
      }

      // Route through download.php proxy to attach TeraBox headers and eliminate 403 sign errors
      const b64Url = Buffer.from(rawLink).toString('base64');
      const cookieVal = result?.downloadHeaders?.Cookie || '';

      let downloadLink = `${CONFIG.DOWNLOAD_PROXY_URL}?url=${encodeURIComponent(b64Url)}&b64=1&filename=${encodeURIComponent(fileName)}`;
      let streamLink = `${CONFIG.DOWNLOAD_PROXY_URL}?url=${encodeURIComponent(b64Url)}&b64=1&stream=1&filename=${encodeURIComponent(fileName)}`;

      if (cookieVal) {
        downloadLink += `&cookie=${encodeURIComponent(cookieVal)}`;
        streamLink += `&cookie=${encodeURIComponent(cookieVal)}`;
      }

      const buttons = [
        [{ text: '⬇️ Direct Fast Download', url: downloadLink }],
        [{ text: '▶️ Watch / Stream Online', url: streamLink }],
      ];

      const caption = `📁 *File Name:* \`${fileName}\`\n📦 *Size:* \`${fileSize}\`\n\n⚡ *Status:* \`Ready for Download & Stream\`\n_Click the buttons below to open directly in your browser or player:_`;

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

      // Archive link & details to Dump Channel in background
      sendToDumpChannel({
        file,
        user: { id: userId, username: userInfo.username, firstName: userInfo.firstName },
        originalUrl: url,
        downloadLink,
        streamLink,
      }).catch((e) => console.error('[Dump] Error sending to dump channel:', e.message));
    }

    // Delete initial status message
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
 * Handle Callback Query (Buttons)
 */
async function handleCallback(cq) {
  const cqId = cq.id;
  const userId = cq.from.id;
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const data = cq.data || '';
  const isAdmin = CONFIG.ADMINS.includes(userId);

  // 0. Force Sub User Verification Button (Available to all users)
  if (data === 'forcesub_check') {
    const subCheck = await checkForceSub(userId);
    if (subCheck.joined) {
      await tgCall('answerCallbackQuery', {
        callback_query_id: cqId,
        text: '✅ Verified! You have joined all channels.',
      });
      return await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: '✅ *Verification Successful!*\n\n🎉 You have joined all required channels!\n\nNow send any *TeraBox link* to instantly get high-speed download and stream links! 🚀',
        parse_mode: 'Markdown',
      });
    } else {
      await tgCall('answerCallbackQuery', {
        callback_query_id: cqId,
        text: "❌ You haven't joined all channels or sent join request yet! Please join and click Verify again.",
        show_alert: true,
      });
      const keyboard = buildForceSubKeyboard(subCheck.channels || []);
      return await tgCall('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
      });
    }
  }

  // Settings permission protection
  if (
    data.startsWith('settings_') ||
    data.startsWith('del_ch_') ||
    data.startsWith('toggle_') ||
    data === 'close_settings' ||
    data === 'test_forcesub'
  ) {
    if (!isAdmin) {
      return await tgCall('answerCallbackQuery', {
        callback_query_id: cqId,
        text: '❌ You are not authorized to use admin settings!',
        show_alert: true,
      });
    }
  }

  // 1. Close Settings Panel
  if (data === 'close_settings') {
    await tgCall('deleteMessage', { chat_id: chatId, message_id: messageId });
    await AdminState.deleteOne({ user_id: userId });
    return await tgCall('answerCallbackQuery', {
      callback_query_id: cqId,
      text: 'Settings closed.',
    });
  }

  // 2. Add Channel
  if (data === 'settings_add_channel') {
    await AdminState.updateOne(
      { user_id: userId },
      { $set: { state: 'AWAITING_FORWARD', data: {}, updated_at: new Date() } },
      { upsert: true }
    );
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `📢 *Add Force Sub Channel*\n\n👉 *Please forward any message from the channel or group you want to add.*\n\n⚠️ *Important:* Make sure @${CONFIG.BOT_USERNAME || 'the bot'} is already an *Administrator* in that channel with "Invite Users" permission!\n\nSend /cancel to return to settings.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'settings_home' }]],
      },
    });
  }

  // 3. Settings Home
  if (data === 'settings_home') {
    await AdminState.deleteOne({ user_id: userId });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    const panel = await getSettingsPanelData();
    return await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: panel.text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: panel.reply_markup,
    });
  }

  // 4. Delete Channel Menu
  if (data === 'settings_del_menu') {
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    const channels = await getActiveForceSubChannels();

    if (!channels || channels.length === 0) {
      return await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: '🗑️ *Delete Force Sub Channels*\n\n_No channels configured to delete._',
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Back to Settings', callback_data: 'settings_home' }]],
        },
      });
    }

    const delButtons = channels.map((c) => [
      { text: `❌ Delete: ${c.name} (${c.id})`, callback_data: `del_ch_${c.id}` },
    ]);
    delButtons.push([{ text: '⬅️ Back to Settings', callback_data: 'settings_home' }]);

    return await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '🗑️ *Delete Force Sub Channels*\n\nClick on any channel below to remove it from Force Sub:',
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: delButtons },
    });
  }

  // 5. Delete specific channel
  if (data.startsWith('del_ch_')) {
    const targetId = Number(data.replace('del_ch_', ''));
    await ForceSubChannel.deleteOne({ chat_id: targetId });
    await tgCall('answerCallbackQuery', {
      callback_query_id: cqId,
      text: `Channel ${targetId} removed successfully!`,
      show_alert: true,
    });

    const channels = await getActiveForceSubChannels();
    if (!channels || channels.length === 0) {
      return await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: '🗑️ *Delete Force Sub Channels*\n\n_All channels removed._',
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Back to Settings', callback_data: 'settings_home' }]],
        },
      });
    }

    const delButtons = channels.map((c) => [
      { text: `❌ Delete: ${c.name} (${c.id})`, callback_data: `del_ch_${c.id}` },
    ]);
    delButtons.push([{ text: '⬅️ Back to Settings', callback_data: 'settings_home' }]);

    return await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '🗑️ *Delete Force Sub Channels*\n\nClick on any channel below to remove it from Force Sub:',
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: delButtons },
    });
  }

  // 6. Toggle Force Sub
  if (data === 'toggle_forcesub') {
    const current = await isForceSubEnabled();
    const nextVal = !current;
    await BotSetting.updateOne(
      { key: 'FORCE_SUB_ENABLED' },
      { $set: { key: 'FORCE_SUB_ENABLED', value: nextVal, updated_at: new Date() } },
      { upsert: true }
    );
    await tgCall('answerCallbackQuery', {
      callback_query_id: cqId,
      text: `Force Subscription is now ${nextVal ? 'ENABLED ✅' : 'DISABLED ❌'}`,
    });
    const panel = await getSettingsPanelData();
    return await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: panel.text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: panel.reply_markup,
    });
  }

  // 7. Toggle Token System
  if (data === 'toggle_token') {
    const current = await isTokenSystemEnabled();
    const nextVal = !current;
    await BotSetting.updateOne(
      { key: 'USE_TOKEN_SYSTEM' },
      { $set: { key: 'USE_TOKEN_SYSTEM', value: nextVal, updated_at: new Date() } },
      { upsert: true }
    );
    await tgCall('answerCallbackQuery', {
      callback_query_id: cqId,
      text: `Token System is now ${nextVal ? 'ENABLED ✅' : 'DISABLED ❌'}`,
    });
    const panel = await getSettingsPanelData();
    return await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: panel.text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: panel.reply_markup,
    });
  }

  // 8. Toggle Admin Bypass
  if (data === 'toggle_admin_bypass') {
    const current = await isAdminBypassEnabled();
    const nextVal = !current;
    await BotSetting.updateOne(
      { key: 'ADMIN_BYPASS_FORCESUB' },
      { $set: { key: 'ADMIN_BYPASS_FORCESUB', value: nextVal, updated_at: new Date() } },
      { upsert: true }
    );
    await tgCall('answerCallbackQuery', {
      callback_query_id: cqId,
      text: `Admin Bypass is now ${nextVal ? 'ON (Admins skip)' : 'OFF (Admins checked)'}`,
    });
    const panel = await getSettingsPanelData();
    return await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: panel.text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: panel.reply_markup,
    });
  }

  // 9. Set Dump Channel Menu
  if (data === 'settings_set_dump') {
    await AdminState.updateOne(
      { user_id: userId },
      { $set: { state: 'AWAITING_DUMP_FORWARD', data: {}, updated_at: new Date() } },
      { upsert: true }
    );
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `📢 *Set Dump Channel*\n\n👉 *Please forward any message from your Dump Channel* (\`https://t.me/+hbVmKnNuuwFlMGQ1\`) to this chat.\n\n⚠️ *Important:* Make sure @${CONFIG.BOT_USERNAME || 'the bot'} is an *Administrator* in that channel with "Post Messages" permission!\n\nOr send \`/setdump <channel_id>\`, or send /cancel to abort.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'settings_home' }]],
      },
    });
  }

  // 10. Test Force Sub On Myself (Admin self-test)
  if (data === 'test_forcesub') {
    await tgCall('answerCallbackQuery', { callback_query_id: cqId, text: 'Testing force sub...' });
    const subCheck = await checkForceSub(userId, true); // ignoreAdmin = true
    if (subCheck.joined) {
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '✅ *Test Result:* You are a member or have requested to join all active channels! Regular users would be allowed to download.',
        parse_mode: 'Markdown',
      });
    } else {
      const keyboard = buildForceSubKeyboard(subCheck.channels || []);
      return await tgCall('sendMessage', {
        chat_id: chatId,
        text: '🧪 *Test Result (What a normal user sees):*\n\n⚠️ *You must join our channels before downloading!*\n\nPlease join the channels below and send the link again:',
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    }
  }

  // Generic callback fallback
  await tgCall('answerCallbackQuery', {
    callback_query_id: cqId,
    text: 'Processing...',
  });
}
