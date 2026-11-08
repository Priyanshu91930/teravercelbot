import mongoose from 'mongoose';
import { CONFIG } from './config.js';

let isConnected = false;

// Bot User Schema
const BotUserSchema = new mongoose.Schema(
  {
    user_id: { type: Number, required: true, unique: true, index: true },
    first_name: { type: String, default: '' },
    username: { type: String, default: '' },
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

export const BotUser = mongoose.models.BotUser || mongoose.model('BotUser', BotUserSchema);
export const BotSession = mongoose.models.BotSession || mongoose.model('BotSession', BotSessionSchema);

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

