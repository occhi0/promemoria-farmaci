// Promemoria farmaci — bot Telegram su Cloudflare Workers
// Un Durable Object ("Store") conserva farmaci, storico e accessi.
// Il cron ogni minuto controlla le dosi in scadenza e invia i promemoria.

const TZ = 'Europe/Rome';
const DOW_SHORT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const FOLLOW_UP_MIN = 30;   // secondo avviso se la dose non è segnata
const SNOOZE_MIN = 10;
const LOW_STOCK_DAYS = 5;

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const rid = () => Math.random().toString(36).slice(2, 8);
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const pad = n => String(n).padStart(2, '0');

function romeParts(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
  }).formatToParts(new Date(ts));
  const g = t => parts.find(p => p.type === t).value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[g('weekday')];
  const hm = `${g('hour')}:${g('minute')}`;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hm, min: toMin(hm), dow };
}
const hmOf = ts => romeParts(ts).hm;
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { date: t.toISOString().slice(0, 10), dow: t.getUTCDay() };
}
function fmtDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function parseTimes(s) {
  const out = [];
  for (const tok of s.toLowerCase().split(/[\s,;]+/).filter(t => t && !['e', 'alle', 'ore', 'le', 'h'].includes(t))) {
    const m = tok.match(/^(\d{1,2})(?:[:.h](\d{2}))?$/);
    if (!m) return null;
    const h = +m[1], mi = m[2] ? +m[2] : 0;
    if (h > 23 || mi > 59) return null;
    out.push(`${pad(h)}:${pad(mi)}`);
  }
  return out.length ? [...new Set(out)].sort() : null;
}
function parseDays(s) {
  const map = { lu: 1, ma: 2, me: 3, gi: 4, ve: 5, sa: 6, do: 0 };
  const out = new Set();
  for (const tok of s.toLowerCase().split(/[\s,;]+/).filter(t => t && t !== 'e')) {
    const k = tok.normalize('NFD').replace(/[^a-z]/g, '').slice(0, 2);
    if (!(k in map)) return null;
    out.add(map[k]);
  }
  return out.size ? [...out].sort() : null;
}
const daysText = days => (!days.length || days.length === 7) ? 'tutti i giorni' : [1, 2, 3, 4, 5, 6, 0].filter(d => days.includes(d)).map(d => DOW_SHORT[d]).join(', ');

const botToken = env => String(env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^bot/i, '').replace(/\s+/g, '');
async function tg(env, method, body) {
  const base = env.TG_API || 'https://api.telegram.org';
  const r = await fetch(`${base}/bot${botToken(env)}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) console.log('Telegram', method, JSON.stringify(j).slice(0, 300));
  return j;
}
async function webhookSecret(env) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pf:' + botToken(env)));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

const HELP = `💊 <b>Promemoria farmaci</b>
All'orario di ogni dose ti mando un messaggio con i pulsanti ✅ Preso, ⏰ ${SNOOZE_MIN} min e ⏭ Salta. Se non rispondi, te lo ricordo dopo ${FOLLOW_UP_MIN} minuti.

/aggiungi – aggiungi un farmaco
/oggi – le dosi di oggi
/farmaci – elenco, pausa, scorte, elimina
/scorte – compresse rimaste
/storico – ultimi 7 giorni
/annulla – interrompi l'operazione in corso

Puoi gestire anche i farmaci dei familiari: quando aggiungi un farmaco scegli per chi è.`;

const COMMANDS = [
  { command: 'oggi', description: 'Dosi di oggi' },
  { command: 'aggiungi', description: 'Aggiungi un farmaco' },
  { command: 'farmaci', description: 'Elenco e modifica dei farmaci' },
  { command: 'scorte', description: 'Compresse rimaste' },
  { command: 'storico', description: 'Ultimi 7 giorni' },
  { command: 'annulla', description: "Interrompi l'operazione in corso" },
  { command: 'aiuto', description: 'Come funziona' }
];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const stub = env.STORE.get(env.STORE.idFromName('main'));
    if (url.pathname === '/setup') {
      const t = botToken(env);
      if (!t) return Response.json({ ok: false, problema: 'Il token non è arrivato al bot. Su Cloudflare: Impostazioni > Variabili e segreti > aggiungi un Segreto con nome TELEGRAM_BOT_TOKEN, poi Distribuisci.' }, { status: 500 });
      if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(t)) return Response.json({ ok: false, problema: `Il token c'è ma non ha il formato giusto (numeri, due punti, poi circa 35 caratteri). Lunghezza attuale: ${t.length} caratteri, contiene i due punti: ${t.includes(':') ? 'sì' : 'no'}. Ricopialo da BotFather.` }, { status: 500 });
      const me = await tg(env, 'getMe', {});
      if (!me.ok) return Response.json({ ok: false, problema: 'Telegram non riconosce questo token. Ricopialo da BotFather (oppure chiedine uno nuovo con /token) e aggiornalo su Cloudflare.' }, { status: 500 });
      const secret = await webhookSecret(env);
      const w = await tg(env, 'setWebhook', {
        url: url.origin + '/webhook', secret_token: secret,
        allowed_updates: ['message', 'callback_query'], drop_pending_updates: true
      });
      const c = await tg(env, 'setMyCommands', { commands: COMMANDS });
      return Response.json({ ok: !!w.ok, bot: '@' + me.result.username, webhook: w, commands: c, ...(w.ok ? { messaggio: 'Tutto pronto! Apri il bot su Telegram e scrivi /start.' } : {}) }, { status: w.ok ? 200 : 500 });
    }
    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await webhookSecret(env)) return new Response('forbidden', { status: 403 });
      return stub.fetch('https://store/update', { method: 'POST', body: await req.text() });
    }
    if (url.pathname === '/tick' && env.TG_API) { // solo per i test locali
      return stub.fetch('https://store/tick', { method: 'POST', body: url.searchParams.get('now') || '' });
    }
    return new Response('Promemoria farmaci: bot attivo.');
  },
  async scheduled(ev, env, ctx) {
    const stub = env.STORE.get(env.STORE.idFromName('main'));
    ctx.waitUntil(stub.fetch('https://store/tick', { method: 'POST' }));
  }
};

export class Store {
  constructor(state, env) { this.state = state; this.env = env; this.q = Promise.resolve(); }

  fetch(req) { // una richiesta alla volta: niente aggiornamenti persi
    const p = this.q.then(() => this.handle(req));
    this.q = p.catch(() => {});
    return p;
  }
  async handle(req) {
    const path = new URL(req.url).pathname;
    try {
      if (path === '/tick') { const t = await req.text(); await this.tick(t ? Number(t) : Date.now()); }
      else if (path === '/update') await this.onUpdate(await req.json());
    } catch (e) { console.log('errore', e && e.stack || e); }
    return new Response('ok');
  }

  /* ---------- archivio ---------- */
  async acl() { return (await this.state.storage.get('acl')) || { admin: null, chats: {} }; }
  saveAcl(a) { return this.state.storage.put('acl', a); }
  async chat(id) {
    const c = (await this.state.storage.get('c:' + id)) || {};
    return Object.assign({ persons: [], meds: [], log: {}, sent: {}, snooze: [], flows: {} }, c);
  }
  saveChat(id, c) { return this.state.storage.put('c:' + id, c); }

  /* ---------- Telegram ---------- */
  send(chatId, text, markup, extra = {}) {
    return tg(this.env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}), ...extra });
  }
  edit(chatId, mid, text, markup) {
    return tg(this.env, 'editMessageText', { chat_id: chatId, message_id: mid, text, parse_mode: 'HTML', reply_markup: markup || { inline_keyboard: [] } });
  }
  ask(chatId, text, replyTo, placeholder) {
    const markup = { force_reply: true, input_field_placeholder: placeholder || '' };
    const extra = {};
    if (replyTo) { markup.selective = true; extra.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true }; }
    return this.send(chatId, text, markup, extra);
  }

  /* ---------- dosi ---------- */
  person(c, id) { return (c.persons.find(p => p.id === id) || {}).name || '—'; }
  dosesOn(c, date, dow) {
    const out = [];
    for (const m of c.meds) {
      if (m.paused) continue;
      if (m.start && date < m.start) continue;
      if (m.days.length && m.days.length < 7 && !m.days.includes(dow)) continue;
      for (const t of m.times) out.push({ m, time: t, key: m.id + '@' + t });
    }
    return out.sort((a, b) => toMin(a.time) - toMin(b.time) || a.m.name.localeCompare(b.m.name));
  }
  getLog(c, date, key) { return (c.log[date] || {})[key]; }
  perDay(m) { return (m.qty || 1) * m.times.length * ((m.days.length && m.days.length < 7) ? m.days.length / 7 : 1); }
  logDose(c, date, key, m, s, who) {
    c.log[date] = c.log[date] || {};
    const prev = c.log[date][key];
    if (prev && prev.s === 'taken' && m.stock != null) m.stock += (m.qty || 1);
    c.log[date][key] = { s, t: Date.now(), by: who || '' };
    c.snooze = c.snooze.filter(x => !(x.key === key && x.date === date));
    if (s === 'taken' && m.stock != null) {
      m.stock = Math.max(0, m.stock - (m.qty || 1));
      const left = m.stock / this.perDay(m);
      if (left <= LOW_STOCK_DAYS && !m.lowWarned) {
        m.lowWarned = true;
        return `📦 <b>${esc(m.name)}</b> (${esc(this.person(c, m.person))}): restano ${m.stock} unità, ${left < 1 ? 'meno di un giorno' : 'circa ' + Math.floor(left) + (Math.floor(left) === 1 ? ' giorno' : ' giorni')}. Ricordati di riordinarlo.\nQuando lo ricompri: /farmaci → ${esc(m.name)} → Scorte.`;
      }
    }
    return null;
  }
  unlog(c, date, key, m) {
    const e = this.getLog(c, date, key);
    if (!e) return;
    if (e.s === 'taken' && m.stock != null) m.stock += (m.qty || 1);
    delete c.log[date][key];
    if (!Object.keys(c.log[date]).length) delete c.log[date];
  }
  doseText(c, m, date, time, today) {
    return `💊 <b>${esc(this.person(c, m.person))}</b> · ${esc(m.name)}${m.dose ? ' ' + esc(m.dose) : ''}\n🕐 Ore ${time}${today && date !== today ? ' di ' + fmtDate(date) : ''}`;
  }
  doseKb(date, id, time) {
    const d = `${date}|${id}|${time}`;
    return { inline_keyboard: [[{ text: '✅ Preso', callback_data: 'T|' + d }], [{ text: `⏰ ${SNOOZE_MIN} min`, callback_data: 'Z|' + d }, { text: '⏭ Salta', callback_data: 'S|' + d }]] };
  }

  /* ---------- promemoria (cron) ---------- */
  async tick(nowTs) {
    const n = romeParts(nowTs);
    const acl = await this.acl();
    for (const chatId of Object.keys(acl.chats)) {
      const c = await this.chat(chatId);
      let changed = false;
      c.sent[n.date] = c.sent[n.date] || {};
      const sent = c.sent[n.date];
      for (const d of this.dosesOn(c, n.date, n.dow)) {
        if (this.getLog(c, n.date, d.key)) continue;
        const late = n.min - toMin(d.time);
        const S = sent[d.key];
        if (!S && late >= 0 && late <= 20) {
          const r = await this.send(chatId, this.doseText(c, d.m, n.date, d.time), this.doseKb(n.date, d.m.id, d.time));
          sent[d.key] = { m: r.result && r.result.message_id, f: 0 };
          changed = true;
        } else if (S && !S.f && late >= FOLLOW_UP_MIN && late <= 240) {
          await this.send(chatId, `⏰ <b>Non ancora segnato</b>\n` + this.doseText(c, d.m, n.date, d.time), this.doseKb(n.date, d.m.id, d.time));
          S.f = 1; changed = true;
        }
      }
      const due = c.snooze.filter(s => s.at <= nowTs);
      if (due.length) {
        c.snooze = c.snooze.filter(s => s.at > nowTs);
        for (const s of due) {
          const m = c.meds.find(x => x.id === s.medId);
          if (!m || this.getLog(c, s.date, s.key)) continue;
          await this.send(chatId, `⏰ <b>Te lo ricordo</b>\n` + this.doseText(c, m, s.date, s.time, n.date), this.doseKb(s.date, m.id, s.time));
        }
        changed = true;
      }
      // pulizia
      const keepSent = addDays(n.date, -1).date, keepLog = addDays(n.date, -90).date;
      for (const k of Object.keys(c.sent)) if (k < keepSent) { delete c.sent[k]; changed = true; }
      for (const k of Object.keys(c.log)) if (k < keepLog) { delete c.log[k]; changed = true; }
      if (!Object.keys(c.sent[n.date]).length) delete c.sent[n.date];
      if (changed) await this.saveChat(chatId, c);
    }
  }

  /* ---------- messaggi ---------- */
  async onUpdate(up) {
    if (up.callback_query) return this.onCallback(up.callback_query);
    const msg = up.message;
    if (!msg || !msg.from || msg.from.is_bot) return;
    const chatId = String(msg.chat.id), uid = String(msg.from.id), name = msg.from.first_name || 'Utente';
    const priv = msg.chat.type === 'private';
    const text = (msg.text || '').trim();
    const cmd = text.startsWith('/') ? text.split(/\s+/)[0].split('@')[0].toLowerCase() : null;
    const acl = await this.acl();

    // Bot personale: lo usa solo chi ha scritto /start per primo.
    if (!acl.admin && priv && cmd === '/start') {
      acl.admin = uid; acl.chats[chatId] = name;
      await this.saveAcl(acl);
      return this.send(chatId, `Ciao ${esc(name)}! Questo bot ora è solo tuo: nessun altro potrà usarlo.\n\n${HELP}`);
    }
    if (uid !== acl.admin) { if (priv) await this.send(chatId, 'Questo è un bot privato.'); return; }
    if (!acl.chats[chatId]) { acl.chats[chatId] = msg.chat.title || name; await this.saveAcl(acl); }

    const c = await this.chat(chatId);
    if (cmd) {
      switch (cmd) {
        case '/start': case '/aiuto': case '/help': return this.send(chatId, HELP);
        case '/aggiungi': return this.startAdd(chatId, c, uid);
        case '/annulla':
          delete c.flows[uid]; await this.saveChat(chatId, c);
          return this.send(chatId, 'Operazione annullata.', { remove_keyboard: true, selective: true });
        case '/oggi': { const v = this.todayView(c); return this.send(chatId, v.text, v.kb); }
        case '/farmaci': { const v = this.medsView(c); return this.send(chatId, v.text, v.kb); }
        case '/scorte': return this.send(chatId, this.stockView(c));
        case '/storico': return this.send(chatId, this.historyView(c));
        default: return priv ? this.send(chatId, 'Comando non riconosciuto. Scrivi /aiuto.') : null;
      }
    }
    const fl = c.flows[uid];
    if (fl && text) return this.flowInput(chatId, c, uid, fl, text, msg.message_id);
    if (priv) return this.send(chatId, 'Usa /oggi per le dosi di oggi o /aggiungi per un nuovo farmaco. Tutti i comandi: /aiuto');
  }

  /* ---------- aggiunta guidata ---------- */
  async startAdd(chatId, c, uid) {
    c.flows[uid] = { step: 'person', d: {} };
    await this.saveChat(chatId, c);
    const kb = c.persons.map(p => [{ text: p.name, callback_data: 'P|' + p.id }]);
    kb.push([{ text: '➕ Nuova persona', callback_data: 'PN' }], [{ text: 'Annulla', callback_data: 'X' }]);
    return this.send(chatId, '💊 <b>Nuovo farmaco</b>\nPer chi è?', { inline_keyboard: kb });
  }
  async flowInput(chatId, c, uid, fl, text, mid) {
    const d = fl.d;
    const save = () => this.saveChat(chatId, c);
    switch (fl.step) {
      case 'pname': {
        const nm = text.slice(0, 30);
        let p = c.persons.find(x => x.name.toLowerCase() === nm.toLowerCase());
        if (!p) { p = { id: rid(), name: nm }; c.persons.push(p); }
        d.person = p.id; fl.step = 'name'; await save();
        return this.ask(chatId, `Farmaco per <b>${esc(p.name)}</b>. Come si chiama?`, mid, 'Es. Ramipril');
      }
      case 'name':
        d.name = text.slice(0, 60); fl.step = 'dose'; await save();
        return this.ask(chatId, 'Dosaggio? Ad esempio <i>5 mg</i> o <i>1 compressa</i>.\nScrivi <b>-</b> per saltare.', mid, 'Es. 5 mg');
      case 'dose':
        d.dose = text === '-' ? '' : text.slice(0, 40); fl.step = 'times'; await save();
        return this.ask(chatId, 'A che ore va preso? Scrivi uno o più orari, ad esempio:\n<code>8 20</code> oppure <code>08:00 13:30 21:00</code>', mid, 'Es. 8 13 20');
      case 'times': {
        const t = parseTimes(text);
        if (!t) return this.ask(chatId, 'Non ho capito gli orari 🤔 Riprova, ad esempio <code>8 20</code> oppure <code>07:30 19:30</code>.', mid, 'Es. 8 20');
        d.times = t; fl.step = 'days'; await save();
        return this.send(chatId, `Orari: <b>${t.join(', ')}</b>\nIn quali giorni?`, {
          inline_keyboard: [[{ text: 'Tutti i giorni', callback_data: 'D|all' }], [{ text: 'Solo alcuni giorni', callback_data: 'D|some' }]]
        });
      }
      case 'days': {
        const ds = parseDays(text);
        if (!ds) return this.ask(chatId, 'Non ho capito i giorni. Scrivili così: <code>lun mer ven</code>', mid, 'Es. lun mer ven');
        d.days = ds.length === 7 ? [] : ds; fl.step = 'stock'; await save();
        return this.askStock(chatId, mid);
      }
      case 'stock': {
        let st = null;
        if (text !== '-') { st = parseInt(text, 10); if (isNaN(st) || st < 0) return this.ask(chatId, 'Scrivi un numero (ad esempio <code>28</code>) oppure <b>-</b> per saltare.', mid, 'Es. 28'); }
        const today = romeParts().date;
        const m = { id: rid(), person: d.person, name: d.name, dose: d.dose || '', times: d.times, days: d.days || [], qty: 1, stock: st, start: today, paused: false, lowWarned: false };
        c.meds.push(m); delete c.flows[uid]; await save();
        return this.send(chatId, `✅ Salvato!\n\n${this.medText(c, m)}\n\nTi avviserò a ogni orario.`, { remove_keyboard: true, selective: true });
      }
      case 'restock': {
        const st = parseInt(text, 10);
        const m = c.meds.find(x => x.id === d.med);
        if (!m) { delete c.flows[uid]; await save(); return this.send(chatId, 'Il farmaco non esiste più.'); }
        if (text === '-') { m.stock = null; }
        else if (isNaN(st) || st < 0) return this.ask(chatId, 'Scrivi un numero, ad esempio <code>30</code> (oppure <b>-</b> per non contare le scorte).', mid, 'Es. 30');
        else m.stock = st;
        m.lowWarned = false; delete c.flows[uid]; await save();
        return this.send(chatId, m.stock == null ? `Scorte di <b>${esc(m.name)}</b> non più conteggiate.` : `📦 Scorte di <b>${esc(m.name)}</b>: ${m.stock} unità.`);
      }
    }
  }
  askStock(chatId, mid) {
    return this.ask(chatId, 'Quante compresse (o unità) hai adesso? Le scalo a ogni dose e ti avviso quando stanno per finire.\nScrivi <b>-</b> per saltare.', mid, 'Es. 28');
  }

  /* ---------- viste ---------- */
  medText(c, m) {
    return `<b>${esc(m.name)}</b>${m.dose ? ' ' + esc(m.dose) : ''}${m.paused ? ' ⏸ <i>in pausa</i>' : ''}\n👤 ${esc(this.person(c, m.person))}\n🕐 ${m.times.join(', ')} · ${daysText(m.days)}${m.stock != null ? `\n📦 ${m.stock} unità` : ''}`;
  }
  todayView(c) {
    const n = romeParts();
    if (!c.meds.length) return { text: 'Non ci sono ancora farmaci. Usa /aggiungi per inserirne uno.' };
    const ds = this.dosesOn(c, n.date, n.dow);
    if (!ds.length) return { text: '📅 <b>Oggi</b>\nNessuna dose prevista.' };
    let taken = 0;
    const kb = [];
    const lines = ds.map(d => {
      const e = this.getLog(c, n.date, d.key);
      let ic;
      if (e) { ic = e.s === 'taken' ? '✅' : '⏭'; if (e.s === 'taken') taken++; }
      else if (toMin(d.time) > n.min) ic = '⏳';
      else { ic = n.min - toMin(d.time) > 60 ? '❗' : '🔔'; kb.push([{ text: `✅ ${d.time} ${d.m.name} · ${this.person(c, d.m.person)}`.slice(0, 60), callback_data: `O|${n.date}|${d.m.id}|${d.time}` }]); }
      return `${ic} ${d.time}  <b>${esc(this.person(c, d.m.person))}</b> · ${esc(d.m.name)}${d.m.dose ? ' ' + esc(d.m.dose) : ''}`;
    });
    const text = `📅 <b>Oggi, ${fmtDate(n.date)}</b>\n${taken} di ${ds.length} dosi prese\n\n${lines.join('\n')}${kb.length ? '\n\nTocca per segnare come prese:' : ''}`;
    kb.push([{ text: '🔄 Aggiorna', callback_data: 'OR' }]);
    return { text, kb: { inline_keyboard: kb } };
  }
  medsView(c) {
    if (!c.meds.length) return { text: 'Non ci sono ancora farmaci. Usa /aggiungi per inserirne uno.' };
    const order = id => c.persons.findIndex(p => p.id === id);
    const ms = [...c.meds].sort((a, b) => order(a.person) - order(b.person) || a.name.localeCompare(b.name));
    let text = '💊 <b>Farmaci</b>\n', last = null;
    for (const m of ms) {
      if (m.person !== last) { text += `\n👤 <b>${esc(this.person(c, m.person))}</b>\n`; last = m.person; }
      text += `• ${esc(m.name)}${m.dose ? ' ' + esc(m.dose) : ''} — ${m.times.join(', ')}${m.paused ? ' ⏸' : ''}\n`;
    }
    text += '\nTocca un farmaco per modificarlo:';
    return { text, kb: { inline_keyboard: ms.map(m => [{ text: `${m.paused ? '⏸ ' : ''}${m.name} · ${this.person(c, m.person)}`.slice(0, 60), callback_data: 'MM|' + m.id }]) } };
  }
  medDetail(c, m) {
    return {
      text: this.medText(c, m), kb: {
        inline_keyboard: [
          [{ text: m.paused ? '▶️ Riprendi' : '⏸ Metti in pausa', callback_data: 'MP|' + m.id }, { text: '📦 Scorte', callback_data: 'MS|' + m.id }],
          [{ text: '🗑 Elimina', callback_data: 'MD|' + m.id }, { text: '⬅️ Elenco', callback_data: 'ML' }]
        ]
      }
    };
  }
  stockView(c) {
    if (!c.meds.length) return 'Non ci sono ancora farmaci.';
    const lines = c.meds.map(m => {
      if (m.stock == null) return `• ${esc(m.name)} (${esc(this.person(c, m.person))}): non conteggiate`;
      const left = m.stock / this.perDay(m);
      return `${left <= LOW_STOCK_DAYS ? '⚠️' : '•'} ${esc(m.name)} (${esc(this.person(c, m.person))}): <b>${m.stock}</b> unità, circa ${Math.floor(left)} giorni`;
    });
    return `📦 <b>Scorte</b>\n\n${lines.join('\n')}\n\nPer aggiornarle: /farmaci → farmaco → Scorte.`;
  }
  historyView(c) {
    const n = romeParts();
    if (!c.meds.length) return 'Non ci sono ancora farmaci.';
    const per = {}; let miss = [];
    for (let i = 0; i < 7; i++) {
      const day = addDays(n.date, -i);
      for (const d of this.dosesOn(c, day.date, day.dow)) {
        if (i === 0 && toMin(d.time) > n.min) continue;
        const e = this.getLog(c, day.date, d.key);
        const p = per[d.m.id] = per[d.m.id] || { m: d.m, t: 0, n: 0 };
        p.n++;
        if (e && e.s === 'taken') p.t++;
        else if (!e && miss.length < 10) miss.push(`${fmtDate(day.date)} ${d.time} · ${esc(this.person(c, d.m.person))} · ${esc(d.m.name)}`);
      }
    }
    const rows = Object.values(per);
    if (!rows.length) return '📊 Nessuna dose negli ultimi 7 giorni.';
    const bar = r => { const k = Math.round(r * 5); return '🟩'.repeat(k) + '⬜'.repeat(5 - k); };
    let text = '📊 <b>Ultimi 7 giorni</b>\n\n' + rows.map(p => `${bar(p.t / p.n)} ${p.t}/${p.n}  <b>${esc(this.person(c, p.m.person))}</b> · ${esc(p.m.name)}`).join('\n');
    if (miss.length) text += `\n\n<b>Non segnate:</b>\n${miss.join('\n')}`;
    return text;
  }

  /* ---------- pulsanti ---------- */
  async onCallback(q) {
    const data = q.data || '';
    const ans = t => tg(this.env, 'answerCallbackQuery', { callback_query_id: q.id, ...(t ? { text: t } : {}) });
    if (!q.message) return ans();
    const chatId = String(q.message.chat.id), mid = q.message.message_id, uid = String(q.from.id), who = q.from.first_name || '';
    const acl = await this.acl();

    if (uid !== acl.admin) return ans('Bot privato');
    if (!acl.chats[chatId]) return ans('Chat non autorizzata');
    const c = await this.chat(chatId);
    const [k, ...r] = data.split('|');
    const today = romeParts().date;

    if (['T', 'S', 'Z', 'U', 'O'].includes(k)) {
      const [date, medId, time] = r;
      const m = c.meds.find(x => x.id === medId);
      if (!m) { await this.edit(chatId, mid, 'Questo farmaco non è più in elenco.'); return ans(); }
      const key = medId + '@' + time;
      if (k === 'O') {
        const low = this.getLog(c, date, key) ? null : this.logDose(c, date, key, m, 'taken', who);
        await this.saveChat(chatId, c);
        const v = this.todayView(c); await this.edit(chatId, mid, v.text, v.kb);
        if (low) await this.send(chatId, low);
        return ans('Segnato come preso');
      }
      if (k === 'T' || k === 'S') {
        const low = this.logDose(c, date, key, m, k === 'T' ? 'taken' : 'skipped', who);
        await this.saveChat(chatId, c);
        await this.edit(chatId, mid, this.doseText(c, m, date, time, today) + `\n\n${k === 'T' ? '✅ Preso' : '⏭ Saltato'} alle ${hmOf(Date.now())}${who ? ' · ' + esc(who) : ''}`,
          { inline_keyboard: [[{ text: '↩️ Annulla', callback_data: `U|${date}|${medId}|${time}` }]] });
        if (low) await this.send(chatId, low);
        return ans(k === 'T' ? 'Segnato come preso' : 'Segnato come saltato');
      }
      if (k === 'U') {
        this.unlog(c, date, key, m); await this.saveChat(chatId, c);
        await this.edit(chatId, mid, this.doseText(c, m, date, time, today), this.doseKb(date, medId, time));
        return ans('Annullato');
      }
      if (k === 'Z') {
        if (this.getLog(c, date, key)) return ans('Già segnato');
        const at = Date.now() + SNOOZE_MIN * 60e3;
        c.snooze = c.snooze.filter(s => !(s.key === key && s.date === date));
        c.snooze.push({ date, key, medId, time, at });
        const S = (c.sent[date] || {})[key]; if (S) S.f = 1;
        await this.saveChat(chatId, c);
        await this.edit(chatId, mid, this.doseText(c, m, date, time, today) + `\n\n⏰ Te lo ricordo alle ${hmOf(at)}`);
        return ans(`Rimandato di ${SNOOZE_MIN} minuti`);
      }
    }
    if (k === 'OR') { const v = this.todayView(c); await this.edit(chatId, mid, v.text, v.kb); return ans('Aggiornato'); }

    // aggiunta guidata
    const fl = c.flows[uid];
    if (k === 'X') { delete c.flows[uid]; await this.saveChat(chatId, c); await this.edit(chatId, mid, 'Operazione annullata.'); return ans(); }
    if (k === 'P' || k === 'PN' || k === 'D') {
      if (!fl) return ans('Ricomincia con /aggiungi');
      if (k === 'PN') {
        fl.step = 'pname'; await this.saveChat(chatId, c);
        await this.edit(chatId, mid, '💊 <b>Nuovo farmaco</b>');
        await this.ask(chatId, 'Come si chiama la persona? (es. Nonno, Mamma, Marco)', null, 'Nome');
        return ans();
      }
      if (k === 'P') {
        const p = c.persons.find(x => x.id === r[0]);
        if (!p || fl.step !== 'person') return ans();
        fl.d.person = p.id; fl.step = 'name'; await this.saveChat(chatId, c);
        await this.edit(chatId, mid, `💊 <b>Nuovo farmaco</b> per ${esc(p.name)}`);
        await this.ask(chatId, 'Come si chiama il farmaco?', null, 'Es. Ramipril');
        return ans();
      }
      if (k === 'D') {
        if (fl.step !== 'days') return ans();
        if (r[0] === 'all') { fl.d.days = []; fl.step = 'stock'; await this.saveChat(chatId, c); await this.edit(chatId, mid, `Orari: <b>${fl.d.times.join(', ')}</b>, tutti i giorni.`); await this.askStock(chatId, null); }
        else { await this.edit(chatId, mid, `Orari: <b>${fl.d.times.join(', ')}</b>`); await this.ask(chatId, 'Scrivi i giorni, ad esempio: <code>lun mer ven</code>', null, 'Es. lun mer ven'); }
        return ans();
      }
    }

    // gestione farmaci
    if (k === 'ML') { const v = this.medsView(c); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
    const m = c.meds.find(x => x.id === r[0]);
    if (['MM', 'MP', 'MS', 'MD', 'MDY'].includes(k) && !m) { const v = this.medsView(c); await this.edit(chatId, mid, v.text, v.kb); return ans('Farmaco non trovato'); }
    if (k === 'MM') { const v = this.medDetail(c, m); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
    if (k === 'MP') { m.paused = !m.paused; await this.saveChat(chatId, c); const v = this.medDetail(c, m); await this.edit(chatId, mid, v.text, v.kb); return ans(m.paused ? 'In pausa: niente promemoria' : 'Promemoria riattivati'); }
    if (k === 'MS') {
      c.flows[uid] = { step: 'restock', d: { med: m.id } }; await this.saveChat(chatId, c);
      await this.ask(chatId, `Quante unità di <b>${esc(m.name)}</b> hai adesso?${m.stock != null ? ` (ora: ${m.stock})` : ''}\nScrivi <b>-</b> per non contarle.`, null, 'Es. 30');
      return ans();
    }
    if (k === 'MD') {
      await this.edit(chatId, mid, `Eliminare <b>${esc(m.name)}</b> di ${esc(this.person(c, m.person))}? Si perde anche il suo storico.`,
        { inline_keyboard: [[{ text: '🗑 Sì, elimina', callback_data: 'MDY|' + m.id }, { text: 'No', callback_data: 'MM|' + m.id }]] });
      return ans();
    }
    if (k === 'MDY') {
      c.meds = c.meds.filter(x => x.id !== m.id);
      for (const dk of Object.keys(c.log)) { for (const key of Object.keys(c.log[dk])) if (key.startsWith(m.id + '@')) delete c.log[dk][key]; if (!Object.keys(c.log[dk]).length) delete c.log[dk]; }
      c.snooze = c.snooze.filter(s => s.medId !== m.id);
      c.persons = c.persons.filter(p => c.meds.some(x => x.person === p.id));
      await this.saveChat(chatId, c);
      const v = this.medsView(c); await this.edit(chatId, mid, `🗑 ${esc(m.name)} eliminato.\n\n` + v.text, v.kb);
      return ans('Eliminato');
    }
    return ans();
  }
}
