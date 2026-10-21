// Telegram-бот: регистрация чатов по /start (подтверждает админ в настройках),
// команда /otchet, ежедневная сводка в 21:00 и список решений по понедельникам.
const store = require('./store');

let offset = 0, running = false;

async function api(method, body) {
  const t = store.settings().tg_token;
  if (!t) return null;
  const r = await fetch('https://api.telegram.org/bot' + t + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json().catch(() => null);
}

const send = (chat_id, text) => api('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });

async function broadcast(text) {
  const chats = (store.settings().tg_chats || []).filter((c) => c.approved);
  for (const c of chats) await send(c.id, text);
  return chats.length;
}

function start(onReport) {
  if (running) return; running = true;
  const loop = async () => {
    try {
      if (store.settings().tg_token) {
        const r = await api('getUpdates', { offset, timeout: 25 });
        for (const u of (r && r.result) || []) {
          offset = u.update_id + 1;
          const msg = u.message; if (!msg || !msg.text) continue;
          const s = store.settings(), chats = s.tg_chats || [];
          let c = chats.find((x) => x.id === msg.chat.id);
          if (msg.text.startsWith('/start')) {
            if (!c) { c = { id: msg.chat.id, name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || String(msg.chat.id), approved: false }; chats.push(c); store.saveSettings({ tg_chats: chats }); }
            await send(msg.chat.id, c.approved ? 'Вы подключены к YESSIMOV CRM. Команда /otchet — сводка.' : 'Заявка отправлена. Подтвердите её в CRM: Настройки → Telegram.');
          } else if (msg.text.startsWith('/otchet')) {
            await send(msg.chat.id, c && c.approved ? await onReport() : 'Нет доступа. Нажмите /start и подтвердите в CRM.');
          }
        }
      } else await new Promise((r) => setTimeout(r, 15000));
    } catch { await new Promise((r) => setTimeout(r, 5000)); }
    setTimeout(loop, 500);
  };
  loop();
}

module.exports = { start, send, broadcast };
