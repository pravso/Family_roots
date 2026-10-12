// Finds the numeric ID of the private storage channel and checks the bot's admin rights.
// Usage:  node scripts/find-channel-id.mjs <BOT_TOKEN>
// First add the bot as an administrator of the channel (or post a new message in it);
// Telegram keeps these updates for 24 hours.

const token = process.argv[2] || process.env.BOT_TOKEN;
if (!token) {
  console.error('Usage: node scripts/find-channel-id.mjs <BOT_TOKEN>');
  process.exit(1);
}

async function call(method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}

const me = await call('getMe');
console.log(`Bot: @${me.username}`);

const updates = await call('getUpdates');
const chats = new Map();
for (const u of updates) {
  const c = u.my_chat_member?.chat || u.channel_post?.chat;
  if (c && c.type === 'channel') chats.set(c.id, c);
}

if (!chats.size) {
  console.log('\nNo channels found yet.');
  console.log('1) Channel > Administrators > Add Admin > search @' + me.username);
  console.log('2) Or post a new message in the channel.');
  console.log('Then run this script again.');
  process.exit(0);
}

for (const c of chats.values()) {
  let status;
  try {
    const m = await call('getChatMember', { chat_id: c.id, user_id: me.id });
    status = m.status;
    if (m.status === 'administrator') {
      const ok = m.can_post_messages && m.can_edit_messages && m.can_delete_messages;
      status += ok
        ? ' ✔ rights OK'
        : ` ✖ missing rights (post:${!!m.can_post_messages} edit:${!!m.can_edit_messages} delete:${!!m.can_delete_messages})`;
    } else {
      status += ' ✖ bot must be an administrator';
    }
  } catch {
    status = 'no access';
  }
  console.log(`\n${c.title}\n  CHANNEL_ID = "${c.id}"\n  bot: ${status}`);
}
