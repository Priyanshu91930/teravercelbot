import mongoose from 'mongoose';
import { CONFIG } from './config.js';

let isConnected = false;

// Bot User Schema
const BotUserSchema = new mongoose.Schema(
  {
    user_id: { type: Number, required: true, unique: true, index: true },
    first_name: { type: String, default: '' },
    username: { type: String, default: '' },
    is_app_user: { type: Boolean, default: false }, // true if user came from Android Mobile App
    app_linked_at: { type: Date },
    daily_count: { type: Number, default: 0 },
    last_usage_date: { type: String, default: '' }, // YYYY-MM-DD (UTC date string)
    updated_at: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Token / Session Schema for Ads & 1-hour active window
const BotSessionSchema = new mongoose.Schema({
  user_id: { type: Number, required: true, index: true },
  token_id: { type: String, index: true },
  created_at: { type: Date, default: Date.now },
  expires_at: { type: Date, index: { expires: 0 } }, // Auto-delete via MongoDB TTL
});

// Force Sub Channel Schema (Configurable dynamically by admins via /settings)
const ForceSubChannelSchema = new mongoose.Schema({
  chat_id: { type: Number, required: true, unique: true, index: true },
  name: { type: String, default: 'Channel 📢' },
  url: { type: String, required: true },
  created_at: { type: Date, default: Date.now },
});

// Admin Conversation State Schema (For handling forwarded channel messages, etc.)
const AdminStateSchema = new mongoose.Schema({
  user_id: { type: Number, required: true, unique: true, index: true },
  state: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  updated_at: { type: Date, default: Date.now, expires: 900 }, // 15 min TTL
});

// Dynamic Bot Setting Schema (For toggling Force Sub or Token System via /settings)
const BotSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updated_at: { type: Date, default: Date.now },
});

// Join Request Schema (For private channel "Request to Join" verification)
const JoinRequestSchema = new mongoose.Schema({
  userId: { type: Number, required: true, index: true },
  chatId: { type: Number, required: true, index: true },
  status: { type: String, enum: ['pending', 'approved', 'declined'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
});
JoinRequestSchema.index({ userId: 1, chatId: 1 }, { unique: true });

export const BotUser = mongoose.models.BotUser || mongoose.model('BotUser', BotUserSchema);
export const BotSession = mongoose.models.BotSession || mongoose.model('BotSession', BotSessionSchema);
export const ForceSubChannel = mongoose.models.ForceSubChannel || mongoose.model('ForceSubChannel', ForceSubChannelSchema);
export const AdminState = mongoose.models.AdminState || mongoose.model('AdminState', AdminStateSchema);
export const BotSetting = mongoose.models.BotSetting || mongoose.model('BotSetting', BotSettingSchema);
export const JoinRequest = mongoose.models.JoinRequest || mongoose.model('JoinRequest', JoinRequestSchema);

export async function connectMongo() {
  if (isConnected || mongoose.connection.readyState === 1) {
    isConnected = true;
    return;
  }
  try {
    await mongoose.connect(CONFIG.MONGODB_URI, {
      bufferCommands: false,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = true;
    console.log('[DB] Connected to MongoDB');
  } catch (err) {
    console.error('[DB] Connection error:', err.message);
  }
}

