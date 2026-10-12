# Roots & Memories – Telegram edition

A family tree and memories app. Family members sign in with Telegram, and all data and photos are stored in a **private Telegram channel owned by the admin's account**.

```
public/index.html   the app (also has a demo mode with sample data)
src/worker.js       Cloudflare Worker backend: login, access list, storage
wrangler.toml       configuration
```

## How it works

- **Sign-in** uses Telegram's OpenID Connect login (Authorization Code + PKCE). The Worker checks Telegram's signed ID token and then sets an HttpOnly session cookie that lasts 30 days.
- **Access** is limited to the Telegram user IDs in `ADMIN_USER_ID` and `ALLOWED_USER_IDS`. The Worker checks this list on every request, so removing an ID cuts off access straight away.
- **Storage:** a bot that is an admin of the private channel posts every photo there as a document, so the original quality is kept. It also posts the family data as a JSON file and **pins** it. The pinned file is the current version. Older JSON posts stay in the channel as version history.
- **Secrets** (the bot token and client secret) stay inside the Worker. The browser never sees Telegram file URLs, because photos are passed through `/api/file/...`.

## Setup (about 20 minutes)

**1. Create the bot.** In Telegram, open **@BotFather** and use `/newbot`. Save the **bot token**. Give the bot a recognisable name and picture, because people see them on the sign-in screen.

**2. Turn on login for the bot.** Open the @BotFather mini app, choose your bot, then **Login Widget**. Note the **Client ID** and **Client Secret**. You'll add the allowed URLs in step 6.

**3. Create the storage channel (from the admin account).** Create a **private channel**, for example "Family Roots Storage". Add the bot as an **administrator** with these rights: *Post messages*, *Edit messages of others* (this is what lets it pin), and *Delete messages*.

**4. Find the channel ID.** The Bot API can't use an invite link (`t.me/+…`). It needs the channel's numeric ID. Once the bot is an admin, run:
```bash
node scripts/find-channel-id.mjs <BOT_TOKEN>
```
This prints `CHANNEL_ID = "-100…"` and checks that the bot has the right admin rights.

**5. Configure and deploy** (you need Node.js 18 or newer):
```bash
npm install -g wrangler        # or use npx wrangler
wrangler login
# edit wrangler.toml: TG_CLIENT_ID, CHANNEL_ID (ADMIN_USER_ID can wait until step 7)
wrangler secret put BOT_TOKEN
wrangler secret put TG_CLIENT_SECRET
wrangler secret put SESSION_SECRET   # paste a random value, e.g. from: openssl rand -hex 32
wrangler deploy
```
Write down the URL it prints, for example `https://family-roots.<you>.workers.dev`.

**6. Register the URLs.** In BotFather, go to **Login Widget → Allowed URLs** and add:
- `https://family-roots.<you>.workers.dev`
- `https://family-roots.<you>.workers.dev/auth/callback`

**7. Find your admin ID.** Open the app and sign in. Because no one is allowed yet, the screen shows **your Telegram ID**. Put that number in `ADMIN_USER_ID` and run `wrangler deploy` again.

**8. Invite family.** Relatives open the app and try to sign in. Each one sees their own ID. Add those IDs to `ALLOWED_USER_IDS`, separated by commas, and redeploy.

## Installing the apps

All three options open the same deployed app, so family data stays in sync between them.

### Android: APK
You can only build the APK once the app is deployed, because the APK points to your app's web address.
1. Go to **https://www.pwabuilder.com**, enter your app URL and click **Package for stores**. Under **Android**, choose **Generate Package**.
2. Set a Package ID such as `com.yourfamily.roots` and leave **Signing key: New**. Then download the zip.
3. Open `assetlinks.json` from the zip and paste its contents (on one line) into `ANDROID_ASSETLINKS` in `wrangler.toml`. Run `wrangler deploy`. Without this step the app shows a browser address bar.
4. Copy the `.apk` to the phone and open it. Android asks you to allow installs from that source the first time.
5. Keep `signing.keystore` and `signing-key-info.txt` safe. You'll need them to publish updates.

The APK is a Trusted Web Activity: it runs the app through Chrome, so Telegram sign-in works as it does in the browser.

**Quicker option without an APK:** open the URL in Chrome on Android and choose *⋮ → Add to Home screen → Install*.

### Windows: .exe
Use `RootsAndMemories-Windows.zip`. Unzip it, put your app URL in `app-url.txt`, then run `Roots & Memories.exe`. It opens the app in its own window using Edge, which is built into Windows, or Chrome. To rebuild it from source, see `windows/launcher.c`.

**Quicker option:** open the URL in Edge or Chrome and choose *⋯ → Apps → Install this site as an app*.

### iPhone
In Safari, choose *Share → Add to Home Screen*.

## Limits and good practice

- **Photos up to 20 MB each.** This is the Bot API download limit. Normal phone photos are well under it.
- **Don't delete the bot or the channel.** Saved photo references (`file_id`s) only work with this bot. If either one is lost, the data is lost. Use **Export JSON** in the app now and then as a backup.
- **Simultaneous edits:** if two people save at the same moment, the second save is rejected. That person sees the latest data and redoes their change.
- **Scale:** all the family data is loaded as one JSON file. That's fine for thousands of memories, but it is not a database.
- **Privacy:** photos are stored in the admin's Telegram channel and subject to Telegram's terms. Anyone with admin rights on the channel can see everything.

## Local testing

Run `wrangler dev`. Telegram login needs the URL to be registered (step 6), so the easiest way to test sign-in is on the deployed `workers.dev` URL. Opening `public/index.html` directly from disk gives you demo mode.
