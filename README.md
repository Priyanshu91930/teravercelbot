# TeraBox Telegram Vercel Bot (Serverless Edition)

A 100% serverless Telegram bot running on Vercel. 
- **Zero VPS needed**: No downloading or uploading large files through servers.
- **Direct Links**: Directly generates high-speed Download Links and Online Video Streaming links from your Vercel TeraBox API (`/parse`).
- **Force Sub**: Channel & Group join verification.
- **Ads Token System**: Supports `/gen` (VPLink / AdLinkFly) with anti-bypass verification stored directly in MongoDB (no Redis required).

---

## 🚀 How to Deploy to Vercel

### Step 1: Deploy to Vercel
You can deploy using GitHub or the Vercel CLI:
```bash
cd vercel-bot
vercel
```
Or push this `vercel-bot` folder to a GitHub repository and import it into [Vercel](https://vercel.com).

### Step 2: Set Environment Variables on Vercel
Go to **Project Settings > Environment Variables** on Vercel:
- `BOT_TOKEN`: `8811732867:AAGErBo5jt-18Hcyu2m9ydwoX9xNsl97QUk`
- `BOT_USERNAME`: `teraboxdownloader2027_bot`
- `TERABOX_API_BASE`: `https://teraapi-six.vercel.app`
- `TERABOX_API_KEY`: `AnihubTeraSecureKey2026_xYz`
- `MONGODB_URI`: `mongodb+srv://anihubyt:Zxcvbnmm9193@cluster0.qv5tu12.mongodb.net/terabox_downloader?appName=Cluster0`
- `USE_TOKEN_SYSTEM`: `false` (Default: Shortener is OFF for direct instant links)
- `FORCE_SUB_ENABLED`: `true`

---

## 🔗 Step 3: Connect Telegram Webhook (One-Time Setup)

Once deployed, Vercel will give you a domain (e.g. `https://my-terabox-bot.vercel.app`).
Simply open your browser and visit:

```
https://my-terabox-bot.vercel.app/?setup=1&url=https://my-terabox-bot.vercel.app/api/webhook
```

You will see:
```json
{
  "status": "Webhook setup requested",
  "result": { "ok": true, "result": true, "description": "Webhook was set" }
}
```

Now open your bot on Telegram: **@teraboxdownloader2027_bot** and send any TeraBox link! 🚀

