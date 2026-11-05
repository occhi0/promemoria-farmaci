// Promemoria farmaci — bot Telegram su Cloudflare Workers
// Un Durable Object ("Store") conserva farmaci, storico e accessi.
// Il cron ogni minuto controlla le dosi in scadenza e invia i promemoria.

const TZ = 'Europe/Rome';
const DOW_SHORT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const FOLLOW_UP_MIN = 30;   // secondo avviso se la dose non è segnata
const SNOOZE_MIN = 10;
const LOW_STOCK_DAYS = 7;   // primo avviso scorte
const LAST_STOCK_DAYS = 2;  // ultimo avviso
const YELLOW_DAYS = 15;     // pallino giallo in /scorte
const STOCK_CHECK_HM = '09:00';

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
const MONTHS = { gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12 };
// Capisce: oggi, domani, "tra 5 giorni", "9/11", "9/11/2026", "9 novembre"
function parseDate(text, today) {
  const t = text.toLowerCase().trim();
  if (/^oggi$/.test(t)) return today;
  if (/^domani$/.test(t)) return addDays(today, 1).date;
  let m = t.match(/(?:tra|fra|dopo|fra)\s+(\d{1,3})\s*g/);
  if (m) return addDays(today, +m[1]).date;
  let d, mo, y;
  if ((m = t.match(/^(\d{1,2})\s*[\/.\-]\s*(\d{1,2})(?:\s*[\/.\-]\s*(\d{2,4}))?$/))) { d = +m[1]; mo = +m[2]; y = m[3] ? +m[3] : null; }
  else if ((m = t.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*(?:\s+(\d{4}))?$/)) && MONTHS[m[2]]) { d = +m[1]; mo = MONTHS[m[2]]; y = m[3] ? +m[3] : null; }
  else return null;
  if (y != null && y < 100) y += 2000;
  const ty = +today.slice(0, 4);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const mk = yy => `${yy}-${pad(mo)}-${pad(d)}`;
  let out = mk(y || ty);
  if (!y && out < addDays(today, -180).date) out = mk(ty + 1);
  return out;
}
// Fine terapia: "7" o "7 giorni" = 7 giorni contando da `from`; altrimenti una data.
function parseEnd(text, from, today) {
  const m = text.trim().toLowerCase().match(/^(?:per\s+)?(?:altri\s+)?(\d{1,3})(?:\s*g(?:iorn[io])?)?$/);
  if (m && +m[1] > 0) return addDays(from, +m[1] - 1).date;
  return parseDate(text, today);
}
// Periodo: "dal 3/11 al 7/11", "3/11 - 7/11", "7" (giorni da oggi), "fino al 15/11", una sola data = ultimo giorno
function parsePeriod(text, today) {
  const t = text.toLowerCase().trim().replace(/^(?:dal|da)\s+/, '');
  let a = null, b = null;
  if (/^(?:fino\s+al?|al)\s+/.test(t)) { b = parseDate(t.replace(/^(?:fino\s+al?|al)\s+/, ''), today); a = today; return b && b >= today ? { start: a, end: b } : null; }
  const parts = t.split(/\s+(?:al|a|fino al|fino a)\s+|\s*[–—]\s*|\s+-\s+/);
  if (parts.length === 2) { a = parseDate(parts[0], today); b = parseDate(parts[1], today); }
  else {
    const ds = t.match(/\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?/g);
    if (ds && ds.length === 2) { a = parseDate(ds[0], today); b = parseDate(ds[1], today); }
    else {
      const only = t.replace(/^(?:fino\s+al?|al)\s+/, '');
      b = parseEnd(only, today, today); a = today;
    }
  }
  if (!a || !b || b < a || b < today) return null;
  return { start: a, end: b };
}
const isForever = s => /^(sempre|per sempre|nessuna|continua|cronico|senza fine|no)$/i.test(s.trim());
const shortName = n => String(n || '').split(' (')[0].trim() || n;   // "Micardis (Telmisartan…)" → "Micardis" per i pulsanti
const isSkip = s => /^(-|–|—|salta|saltare|per saltare|skip|no|niente|nessuno|non so|boh)$/i.test(s.trim().replace(/[.!]+$/, ''));
const firstNum = s => { const m = s.match(/\d+/); return m ? parseInt(m[0], 10) : NaN; };
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
/farmaci – elenco, modifica, pausa, scorte, elimina
/scorte – compresse rimaste
/storico – terapie a tempo, in corso e concluse
/terapia – elenco della terapia da mostrare al medico
/esporta – copia di sicurezza completa
/annulla – interrompi l'operazione in corso

Puoi gestire anche i farmaci dei familiari: quando aggiungi un farmaco scegli per chi è. Per condividerli (ad esempio con le sorelle per i farmaci della mamma) crea un gruppo Telegram, aggiungimi e scrivi lì /start: nel gruppo potranno usarmi tutti.`;

const COMMANDS = [
  { command: 'oggi', description: 'Dosi di oggi' },
  { command: 'aggiungi', description: 'Aggiungi un farmaco' },
  { command: 'farmaci', description: 'Elenco e modifica dei farmaci' },
  { command: 'scorte', description: 'Compresse rimaste' },
  { command: 'storico', description: 'Storico delle terapie a tempo' },
  { command: 'terapia', description: 'Elenco della terapia per il medico' },
  { command: 'esporta', description: 'Copia di sicurezza completa' },
  { command: 'trasferisci', description: 'Sposta farmaci nel gruppo' },
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
      await stub.fetch('https://store/cmds', { method: 'POST' });
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
    this._acl = null;   // un solo oggetto acl per richiesta (così le migrazioni non vengono sovrascritte)
    try {
      if (path === '/tick') { const t = await req.text(); await this.tick(t ? Number(t) : Date.now()); }
      else if (path === '/update') await this.onUpdate(await req.json());
      else if (path === '/cmds') { const a = await this.acl(); if (a.admin) await this.syncCommands(a); }
    } catch (e) { console.log('errore', e && e.stack || e); }
    return new Response('ok');
  }

  /* ---------- archivio ---------- */
  async acl() {
    if (!this._acl) this._acl = (await this.state.storage.get('acl')) || { admin: null, chats: {} };
    return this._acl;
  }
  saveAcl(a) { return this.state.storage.put('acl', a); }
  async chat(id) {
    const c = (await this.state.storage.get('c:' + id)) || {};
    return Object.assign({ persons: [], meds: [], log: {}, sent: {}, snooze: [], flows: {} }, c);
  }
  saveChat(id, c) { return this.state.storage.put('c:' + id, c); }

  /* ---------- Telegram ---------- */
  // Un gruppo normale diventato "supergruppo" cambia id: aggiorniamo tutti i riferimenti.
  async migrateChat(oldId, newId) {
    oldId = String(oldId); newId = String(newId);
    if (oldId === newId) return;
    const acl = await this.acl();
    let touched = false;
    if (acl.chats[oldId] !== undefined) { acl.chats[newId] = acl.chats[oldId]; delete acl.chats[oldId]; touched = true;
      const c = await this.state.storage.get('c:' + oldId); if (c) { await this.state.storage.put('c:' + newId, c); await this.state.storage.delete('c:' + oldId); } }
    acl.mirrors = acl.mirrors || {};
    if (acl.mirrors[oldId] !== undefined) { acl.mirrors[newId] = acl.mirrors[oldId]; delete acl.mirrors[oldId]; touched = true; }
    for (const k of Object.keys(acl.mirrors)) if (acl.mirrors[k] === oldId) { acl.mirrors[k] = newId; touched = true; }
    for (const bag of ['panels', 'mcv']) if (acl[bag] && acl[bag][oldId] !== undefined) { acl[bag][newId] = acl[bag][oldId]; delete acl[bag][oldId]; touched = true; }
    if (acl.panels && acl.panels[newId]) { delete acl.panels[newId].oggi; delete acl.panels[newId].terapia; delete acl.panels[newId].pinned; delete acl.panels[newId].day; }  // i vecchi messaggi non sono più modificabili
    acl.migrated = acl.migrated || {}; acl.migrated[oldId] = newId; touched = true;   // i pulsanti dei vecchi messaggi arrivano ancora col vecchio id
    if (touched) { acl.cmdv = 0; await this.saveAcl(acl); console.log('migrato', oldId, '→', newId); }
  }
  async send(chatId, text, markup, extra = {}) {
    const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}), ...extra };
    let r = await tg(this.env, 'sendMessage', body);
    const nid = r && !r.ok && r.parameters && r.parameters.migrate_to_chat_id;
    if (nid) { await this.migrateChat(chatId, nid); r = await tg(this.env, 'sendMessage', { ...body, chat_id: nid }); }
    if (r) r._chat = String(nid || chatId);
    return r;
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
  multi(c) { return new Set(c.meds.map(m => m.person)).size > 1; }
  // "(Mamma)" / " · Mamma" solo se nella chat ci sono farmaci di più persone
  pp(c, id) { return this.multi(c) ? ` (${esc(this.person(c, id))})` : ''; }
  pdot(c, id, raw) { return this.multi(c) ? ` · ${raw ? this.person(c, id) : esc(this.person(c, id))}` : ''; }
  dosesOn(c, date, dow) {
    const out = [];
    for (const m of c.meds) {
      if (m.paused) continue;
      if (m.start && date < m.start) continue;
      if (m.end && date > m.end) continue;
      if (m.days.length && m.days.length < 7 && !m.days.includes(dow)) continue;
      const arch = m.archived && date >= m.archived;
      for (const t of this.timesOn(m, date)) {
        const key = m.id + '@' + t;
        if (arch && !this.getLog(c, date, key)) continue; // archiviato: niente più promemoria
        out.push({ m, time: t, key });
      }
    }
    return out.sort((a, b) => toMin(a.time) - toMin(b.time) || a.m.name.localeCompare(b.m.name));
  }
  // Orari validi in una data: quelli di base, poi l'ultimo cambio programmato già iniziato.
  timesOn(m, date) {
    let t = m.times;
    for (const p of [...(m.plan || [])].sort((a, b) => a.from < b.from ? -1 : 1)) if (p.from <= date) t = p.times;
    return t;
  }
  ended(m, date) { return !!((m.end && date > m.end) || (m.archived && date >= m.archived)); }
  getLog(c, date, key) { return (c.log[date] || {})[key]; }
  perDay(m) { return (m.qty || 1) * this.timesOn(m, romeParts().date).length * ((m.days.length && m.days.length < 7) ? m.days.length / 7 : 1); }
  logDose(c, date, key, m, s, who) {
    c.log[date] = c.log[date] || {};
    const prev = c.log[date][key];
    if (prev && prev.s === 'taken' && m.stock != null) m.stock += (m.qty || 1);
    c.log[date][key] = { s, t: Date.now(), by: who || '' };
    c.snooze = c.snooze.filter(x => !(x.key === key && x.date === date));
    if (s === 'taken' && m.stock != null) {
      m.stock = Math.max(0, m.stock - (m.qty || 1));
      return this.stockAlert(c, m);
    }
    return null;
  }
  // Avviso scorte: a 7 giorni e poi a 2 giorni, una volta per livello.
  packKb(m) {
    const rows = [];
    if (m.pack) rows.push([{ text: `➕ 1 conf. (+${m.pack})`, callback_data: `SA|${m.id}|1` }, { text: `➕ 2 conf. (+${m.pack * 2})`, callback_data: `SA|${m.id}|2` }]);
    rows.push([{ text: m.pack ? '📦 Scorte' : '📦 Aggiorna scorte', callback_data: 'SK|' + m.id }]);
    return { inline_keyboard: rows };
  }
  stockCard(c, m, note) {
    const left = (m.stock != null && m.times.length) ? Math.floor(m.stock / this.perDay(m)) : null;
    let t = `${note ? note + '\n\n' : ''}📦 <b>${esc(m.name)}</b>${m.dose ? ' ' + esc(m.dose) : ''}${this.pp(c, m.person)}\n`;
    t += m.stock == null ? 'Scorte non conteggiate.' : `Scorte: <b>${m.stock}</b> compresse${left != null ? `, circa ${left} ${left === 1 ? 'giorno' : 'giorni'}` : ''}.`;
    t += m.pack ? `\nConfezione da ${m.pack}.` : '\nNon so ancora quante compresse ci sono in una confezione.';
    const kb = [];
    if (m.pack) kb.push([{ text: `➕ 1 conf. (+${m.pack})`, callback_data: `SA|${m.id}|1` }, { text: `➕ 2 conf. (+${m.pack * 2})`, callback_data: `SA|${m.id}|2` }]);
    else kb.push([{ text: '⚙️ Imposta compresse per confezione', callback_data: 'PK|' + m.id }]);
    kb.push([{ text: '✏️ Giacenza', callback_data: 'MS|' + m.id }].concat(m.pack ? [{ text: '⚙️ Confezione', callback_data: 'PK|' + m.id }] : []));
    kb.push([{ text: '⬅️ Farmaco', callback_data: 'MM|' + m.id }]);
    return { text: t, kb: { inline_keyboard: kb } };
  }
  stockAlert(c, m) {
    if (m.stock == null || m.paused || !m.times.length || this.ended(m, romeParts().date)) return null;
    const left = m.stock / this.perDay(m);
    const level = left <= LAST_STOCK_DAYS ? LAST_STOCK_DAYS : left <= LOW_STOCK_DAYS ? LOW_STOCK_DAYS : null;
    if (level == null || (m.lowLevel != null && m.lowLevel <= level)) return null;
    m.lowLevel = level;
    const days = Math.floor(left);
    const until = addDays(romeParts().date, days).date;
    const howLong = m.stock === 0 ? '<b>sono finite</b>' : `bastano per ${days < 1 ? 'meno di un giorno' : 'circa ' + days + (days === 1 ? ' giorno' : ' giorni')}${days >= 1 ? ` (fino a ${fmtDate(until)})` : ''}`;
    const text = `${level === LAST_STOCK_DAYS ? '⚠️ <b>Ultimo avviso scorte</b>' : '📦 <b>Scorte in esaurimento</b>'}\n<b>${esc(m.name)}</b>${m.dose ? ' ' + esc(m.dose) : ''}${this.pp(c, m.person)}: restano ${m.stock} compresse, ${howLong}.\nRicordati ricetta e farmacia. Quando lo ricomprate, toccate qui sotto.`;
    return { text, kb: this.packKb(m) };
  }
  unlog(c, date, key, m) {
    const e = this.getLog(c, date, key);
    if (!e) return;
    if (e.s === 'taken' && m.stock != null) m.stock += (m.qty || 1);
    delete c.log[date][key];
    if (!Object.keys(c.log[date]).length) delete c.log[date];
  }
  doseText(c, m, date, time, today) {
    return `💊 ${this.multi(c) ? '<b>' + esc(this.person(c, m.person)) + '</b> · ' + esc(m.name) : '<b>' + esc(m.name) + '</b>'}${m.dose ? ' ' + esc(m.dose) : ''}\n🕐 Ore ${time}${today && date !== today ? ' di ' + fmtDate(date) : ''}`;
  }
  doseKb(date, id, time) {
    const d = `${date}|${id}|${time}`;
    return { inline_keyboard: [[{ text: '✅ Preso', callback_data: 'T|' + d }], [{ text: `⏰ ${SNOOZE_MIN} min`, callback_data: 'Z|' + d }, { text: '⏭ Salta', callback_data: 'S|' + d }]] };
  }

  // Menu dei comandi: completo in chat privata e nei gruppi principali, nessuno nei gruppi semplici.
  async syncCommands(acl) {
    await tg(this.env, 'deleteMyCommands', {});
    await tg(this.env, 'setMyCommands', { commands: COMMANDS, scope: { type: 'all_private_chats' } });
    for (const id of Object.keys(acl.chats)) if (id.startsWith('-')) await tg(this.env, 'setMyCommands', { commands: COMMANDS, scope: { type: 'chat', chat_id: Number(id) } });
    for (const id of Object.keys(acl.mirrors || {})) await tg(this.env, 'deleteMyCommands', { scope: { type: 'chat', chat_id: Number(id) } });
    acl.cmdv = 5; await this.saveAcl(acl);
  }
  mirrorsOf(acl, src) { return Object.keys(acl.mirrors || {}).filter(k => acl.mirrors[k] === src); }
  // aggiorna tutte le copie del promemoria (gruppo principale e gruppo semplice), tranne quella già modificata
  async syncCopies(c, srcId, date, key, exceptChat, exceptMid, text, kb, skip) {
    const S = (c.sent[date] || {})[key];
    if (!S) return;
    const msgs = S.msgs || (S.m ? [[srcId, S.m]] : []);
    for (const [ch, id] of msgs) {
      if (skip && skip.has(String(ch))) continue;
      if (!(String(ch) === String(exceptChat) && id === exceptMid)) await this.edit(ch, id, text, kb);
    }
  }
  del(chatId, mid) { return tg(this.env, 'deleteMessage', { chat_id: chatId, message_id: mid }); }
  async delMirrorCopies(c, date, key, mset) {
    const S = (c.sent[date] || {})[key];
    if (!S || !S.msgs) return;
    for (const [ch, id] of S.msgs) if (mset.has(String(ch))) await this.del(ch, id);
    S.msgs = S.msgs.filter(([ch]) => !mset.has(String(ch)));
  }
  // Pannello "Oggi" fissato in alto nel gruppo semplice: un solo messaggio, sempre aggiornato
  async updatePanel(acl, mc, c, force) {
    acl.panels = acl.panels || {}; const P = acl.panels[mc] = acl.panels[mc] || {};
    const v = this.todayView(c, true);
    if (P.oggi) {
      const r = await this.edit(mc, P.oggi, v.text, v.kb);
      if (r.ok || /not modified/i.test(r.description || '')) {
        let dirty = false;
        if (P.day !== romeParts().date) { P.day = romeParts().date; dirty = true; }
        if (!P.pinned) { const pr = await tg(this.env, 'pinChatMessage', { chat_id: mc, message_id: P.oggi, disable_notification: true }); if (pr.ok) { P.pinned = true; dirty = true; } }
        if (dirty) await this.saveAcl(acl);
        return;
      }
    }
    const r = await this.send(mc, v.text, v.kb);
    if (r.ok) {
      P.oggi = r.result.message_id; P.day = romeParts().date;
      const pr = await tg(this.env, 'pinChatMessage', { chat_id: r._chat || mc, message_id: P.oggi, disable_notification: true });
      if (pr.ok) await this.del(r._chat || mc, P.oggi + 1);   // l'avviso "ha fissato un messaggio" è il messaggio subito dopo
      P.pinned = !!pr.ok; await this.saveAcl(acl);
    }
  }
  async refreshPanels(acl, srcId, c) { for (const mc of this.mirrorsOf(acl, srcId)) { await this.updatePanel(acl, mc, c); await this.updateOrders(acl, mc, c); } }
  // fresh = cancella il vecchio messaggio e lo rimanda in fondo, così si vede subito
  async mirrorTherapy(acl, mc, c, title, fresh) {
    acl.panels = acl.panels || {}; const P = acl.panels[mc] = acl.panels[mc] || {};
    const { text, kb } = this.therapyMsg(c, title);
    if (P.terapia && !fresh) { const r = await this.edit(mc, P.terapia, text, kb); if (r.ok || /not modified/i.test(r.description || '')) return; }
    if (P.terapia && fresh) await this.del(mc, P.terapia);
    let r = await this.send(mc, text, kb);
    if (!r.ok) {
      const err = r.description || JSON.stringify(r).slice(0, 200);
      r = await this.send(mc, text);   // senza pulsante, così l'elenco si vede comunque
      if (acl.admin) await this.send(acl.admin, `⚠️ Non riesco a mandare la terapia con il pulsante WhatsApp nel gruppo semplice.\nErrore di Telegram: <code>${esc(err)}</code>${r.ok ? '\n(L\'ho mandata senza pulsante.)' : '\nAnche senza pulsante: <code>' + esc(r.description || '') + '</code>'}`);
    }
    if (r.ok) { P.terapia = r.result.message_id; await this.saveAcl(acl); }
  }

  /* ---------- promemoria (cron) ---------- */
  async tick(nowTs) {
    const n = romeParts(nowTs);
    const acl = await this.acl();
    if (acl.admin && acl.cmdv !== 5) await this.syncCommands(acl);
    for (const chatId of Object.keys(acl.chats)) {
      const c = await this.chat(chatId);
      let changed = false;
      const targets = [chatId, ...this.mirrorsOf(acl, chatId)];
      const sendAll = async (text, kb) => { const out = []; for (const t of targets) { const r = await this.send(t, text, kb); if (r.result) out.push([t, r.result.message_id]); } return out; };
      c.sent[n.date] = c.sent[n.date] || {};
      const sent = c.sent[n.date];
      for (const d of this.dosesOn(c, n.date, n.dow)) {
        if (this.getLog(c, n.date, d.key)) continue;
        const late = n.min - toMin(d.time);
        const S = sent[d.key];
        if (!S && late >= 0 && late <= 20) {
          const msgs = await sendAll(this.doseText(c, d.m, n.date, d.time), this.doseKb(n.date, d.m.id, d.time));
          sent[d.key] = { m: msgs.length && msgs[0][1], f: 0, msgs };
          changed = true;
        } else if (S && !S.f && late >= FOLLOW_UP_MIN && late <= 240) {
          await this.delMirrorCopies(c, n.date, d.key, new Set(targets.slice(1)));
          const msgs = await sendAll(`⏰ <b>Non ancora segnato</b>\n` + this.doseText(c, d.m, n.date, d.time), this.doseKb(n.date, d.m.id, d.time));
          S.msgs = [...(S.msgs || (S.m ? [[chatId, S.m]] : [])), ...msgs];
          S.f = 1; changed = true;
        }
      }
      const due = c.snooze.filter(s => s.at <= nowTs);
      if (due.length) {
        c.snooze = c.snooze.filter(s => s.at > nowTs);
        for (const s of due) {
          const m = c.meds.find(x => x.id === s.medId);
          if (!m || this.getLog(c, s.date, s.key)) continue;
          await this.delMirrorCopies(c, s.date, s.key, new Set(targets.slice(1)));
          const msgs = await sendAll(`⏰ <b>Te lo ricordo</b>\n` + this.doseText(c, m, s.date, s.time, n.date), this.doseKb(s.date, m.id, s.time));
          const S2 = (c.sent[s.date] || {})[s.key];
          if (S2) S2.msgs = [...(S2.msgs || (S2.m ? [[chatId, S2.m]] : [])), ...msgs];
        }
        changed = true;
      }
      // controllo scorte del mattino
      if (n.min >= toMin(STOCK_CHECK_HM) && n.min - toMin(STOCK_CHECK_HM) <= 20 && c.stockCheck !== n.date) {
        c.stockCheck = n.date; changed = true;
        for (const m of c.meds) { const a = this.stockAlert(c, m); if (a) await this.send(chatId, a.text, a.kb); }
        for (const m of c.meds) if (this.ended(m, n.date) && !m.endNotified) {
          m.endNotified = true;
          await this.send(chatId, `🏁 <b>Terapia conclusa</b>\n${esc(m.name)}${m.dose ? ' ' + esc(m.dose) : ''}${this.pp(c, m.person)}: l'ultimo giorno era ${fmtDate(m.end)}. Non mando più promemoria; la trovi in /storico tra le terapie concluse.`,
            { inline_keyboard: [[{ text: '📆 Prolunga', callback_data: 'MT|' + m.id }]] });
        }
        // le terapie concluse restano per sempre nello storico (si possono eliminare a mano)
      }
      // pulizia
      const keepSent = addDays(n.date, -1).date, keepLog = addDays(n.date, -90).date;
      for (const k of Object.keys(c.sent)) if (k < keepSent) { delete c.sent[k]; changed = true; }
      for (const k of Object.keys(c.log)) if (k < keepLog) { delete c.log[k]; changed = true; }
      if (!Object.keys(c.sent[n.date]).length) delete c.sent[n.date];
      if (changed) await this.saveChat(chatId, c);
      // pannelli dei gruppi semplici: aggiornati se è successo qualcosa o se è cambiato il giorno
      for (const mc of targets.slice(1)) { const P = (acl.panels || {})[mc] || {}; if (changed || P.day !== n.date || !P.oggi) { await this.updatePanel(acl, mc, c); await this.updateOrders(acl, mc, c); } }
    }
  }

  /* ---------- messaggi ---------- */
  async onUpdate(up) {
    if (up.callback_query) return this.onCallback(up.callback_query);
    const msg = up.message;
    if (msg && msg.migrate_to_chat_id) return this.migrateChat(msg.chat.id, msg.migrate_to_chat_id);
    if (msg && msg.migrate_from_chat_id) return this.migrateChat(msg.migrate_from_chat_id, msg.chat.id);
    // Gruppo semplice: via i messaggi di servizio (nome cambiato, messaggio fissato, ingressi, foto…)
    const SERVICE = ['new_chat_title', 'new_chat_photo', 'delete_chat_photo', 'pinned_message', 'new_chat_members', 'left_chat_member', 'message_auto_delete_timer_changed', 'video_chat_scheduled', 'video_chat_started', 'video_chat_ended', 'boost_added', 'chat_background_set'];
    if (msg && SERVICE.some(k => msg[k] !== undefined)) {
      const a0 = await this.acl();
      if ((a0.mirrors || {})[String(msg.chat.id)]) await this.del(msg.chat.id, msg.message_id);
      return;
    }
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
      return this.send(chatId, `Ciao ${esc(name)}! Questo bot ora è tuo: nessun altro potrà usarlo, tranne i gruppi in cui lo aggiungi tu.\n\n${HELP}`);
    }
    // Gruppo "solo promemoria": risponde solo a /oggi e /terapia (e a /scollega dell'amministratore)
    acl.mirrors = acl.mirrors || {};
    if (acl.mirrors[chatId]) {
      const src = acl.mirrors[chatId];
      if (cmd) await this.del(chatId, msg.message_id);   // pagina pulita: via i comandi scritti
      if ((cmd === '/oggi' || cmd === '/terapia') && ((acl.mcv || {})[chatId] || 0) < 4) {
        acl.mcv = acl.mcv || {}; acl.mcv[chatId] = 4; await this.saveAcl(acl);
        const rk = await this.send(chatId, '…', { remove_keyboard: true });   // toglie i vecchi pulsanti fissi
        if (rk.ok) await this.del(chatId, rk.result.message_id);
        await tg(this.env, 'deleteMyCommands', { scope: { type: 'chat', chat_id: Number(chatId) } });
      }
      if (cmd === '/oggi') { const sc = await this.chat(src); await this.updatePanel(acl, chatId, sc, true); return this.updateOrders(acl, chatId, sc); }
      if (cmd === '/terapia') return this.mirrorTherapy(acl, chatId, await this.chat(src), acl.chats[src], true);
      if (cmd === '/scollega' && uid === acl.admin) {
        delete acl.mirrors[chatId]; await this.saveAcl(acl);
        await tg(this.env, 'deleteMyCommands', { scope: { type: 'chat', chat_id: Number(chatId) } });
        return this.send(chatId, 'Gruppo scollegato: qui non arriveranno più promemoria.', { remove_keyboard: true });
      }
      return;
    }
    if (cmd === '/collega' && !priv && uid === acl.admin) {
      await this.del(chatId, msg.message_id);
      if (acl.chats[chatId] && (await this.chat(chatId)).meds.length) return this.send(chatId, 'Questo gruppo ha già dei farmaci suoi: crea un gruppo nuovo per i soli promemoria.');
      const srcs = Object.keys(acl.chats).filter(id => id !== chatId);
      if (!srcs.length) return this.send(chatId, 'Non ci sono gruppi da collegare.');
      return this.send(chatId, 'Di quale gruppo vuoi ricevere qui i promemoria?\nIn questo gruppo arriveranno solo i messaggi delle dosi, con i pulsanti ✅ Preso, ⏰ e ⏭.',
        { inline_keyboard: srcs.map(id => [{ text: id === acl.admin ? 'La mia chat privata' : acl.chats[id], callback_data: 'LK|' + id }]) });
    }
    // Accesso: la tua chat privata, e i gruppi che hai collegato tu (lì può usarlo chiunque del gruppo).
    if (!acl.chats[chatId]) {
      if (priv || uid !== acl.admin || !cmd) { if (priv) await this.send(chatId, 'Questo è un bot privato.'); return; }
      acl.chats[chatId] = msg.chat.title || 'Gruppo'; await this.saveAcl(acl);
      await tg(this.env, 'setMyCommands', { commands: COMMANDS, scope: { type: 'chat', chat_id: Number(chatId) } });
      await this.send(chatId, `👋 Gruppo <b>${esc(msg.chat.title || '')}</b> collegato!\n\nQui chiunque del gruppo può aggiungere farmaci, segnare le dosi e vedere lo storico. I promemoria dei farmaci inseriti qui arriveranno nel gruppo.\n\nPer spostare qui farmaci già inseriti nella tua chat privata: /trasferisci`);
      if (cmd === '/start') return;
    }

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
        case '/scorte': {
          const has = c.meds.some(m => !this.ended(m, romeParts().date));
          if (!has) return this.send(chatId, this.stockView(c));
          const td = romeParts().date;
          const dl = m => (m.stock == null || !m.times.length) ? Infinity : m.stock / this.perDay(m);
          const ms = c.meds.filter(m => !this.ended(m, td)).sort((a, b) => dl(a) - dl(b) || a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
          const seen = new Set(); const uniq = ms.filter(m => { const k2 = (m.name + '|' + m.dose).toLowerCase(); if (seen.has(k2)) return false; seen.add(k2); return true; });
          const rows = [];
          for (let i = 0; i < uniq.length; i += 2) rows.push(uniq.slice(i, i + 2).map(m => ({ text: `📦 ${shortName(m.name)}`.slice(0, 32), callback_data: 'SK|' + m.id })));
          rows.push([{ text: '📤 Richiedi ricette', callback_data: 'RQ' }]);
          return this.send(chatId, this.stockView(c) + '\n\nTocca un farmaco per aggiungere una confezione.', { inline_keyboard: rows });
        }
        case '/storico': return this.send(chatId, this.historyView(c));
        case '/esporta': return this.send(chatId, this.exportView(c, msg.chat.title));
        case '/terapia': return this.sendTherapy(chatId, c, msg.chat.title);
        case '/trasferisci': {
          if (priv) return this.send(chatId, 'Questo comando si usa dentro un gruppo: sposta lì i farmaci di una persona dalla tua chat privata.');
          if (uid !== acl.admin) return this.send(chatId, 'Solo chi ha creato il bot può trasferire i farmaci.');
          const pc = await this.chat(acl.admin);
          if (!pc.persons.length) return this.send(chatId, 'Nella tua chat privata non ci sono farmaci da trasferire.');
          return this.send(chatId, 'Di chi vuoi spostare i farmaci in questo gruppo?\nVerranno tolti dalla tua chat privata, con il loro storico.',
            { inline_keyboard: [...pc.persons.map(p => [{ text: `${p.name} (${pc.meds.filter(m => m.person === p.id).length})`, callback_data: 'TR|' + p.id }]), [{ text: 'Annulla', callback_data: 'X' }]] });
        }
        default: return priv ? this.send(chatId, 'Comando non riconosciuto. Scrivi /aiuto.') : null;
      }
    }
    const fl = c.flows[uid];
    if (fl && text) return this.flowInput(chatId, c, uid, fl, text, msg.message_id);
    if (priv) return this.send(chatId, 'Usa /oggi per le dosi di oggi o /aggiungi per un nuovo farmaco. Tutti i comandi: /aiuto');
  }

  /* ---------- aggiunta guidata ---------- */
  async startAdd(chatId, c, uid) {
    // Una sola persona nella chat: niente domanda, il farmaco è per lei.
    if (c.persons.length === 1) {
      const p = c.persons[0];
      c.flows[uid] = { step: 'name', d: { person: p.id } };
      await this.saveChat(chatId, c);
      await this.send(chatId, `💊 <b>Nuovo farmaco</b> per ${esc(p.name)}`, { inline_keyboard: [[{ text: '👤 È per un\'altra persona', callback_data: 'PC' }]] });
      return this.ask(chatId, 'Come si chiama il farmaco?', null, 'Es. Ramipril');
    }
    return this.personPicker(chatId, c, uid);
  }
  async personPicker(chatId, c, uid, editMid) {
    c.flows[uid] = { step: 'person', d: {} };
    await this.saveChat(chatId, c);
    const kb = c.persons.map(p => [{ text: p.name, callback_data: 'P|' + p.id }]);
    kb.push([{ text: '➕ Nuova persona', callback_data: 'PN' }], [{ text: 'Annulla', callback_data: 'X' }]);
    if (editMid) return this.edit(chatId, editMid, '💊 <b>Nuovo farmaco</b>\nPer chi è?', { inline_keyboard: kb });
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
        return this.ask(chatId, 'Dosaggio? Ad esempio <i>5 mg</i> o <i>1 compressa</i>.\nOppure scrivi <b>salta</b>.', mid, 'Es. 5 mg');
      case 'dose':
        d.dose = isSkip(text) ? '' : text.slice(0, 40); fl.step = 'times'; await save();
        return this.ask(chatId, 'A che ore va preso? Scrivi uno o più orari, ad esempio:\n<code>8 20</code> oppure <code>08:00 13:30 21:00</code>', mid, 'Es. 8 13 20');
      case 'times': {
        const t = parseTimes(text);
        if (!t) return this.ask(chatId, 'Non ho capito gli orari 🤔 Riprova, ad esempio <code>8 20</code> oppure <code>07:30 19:30</code>.', mid, 'Es. 8 20');
        d.times = t; fl.step = 'days'; await save();
        return this.send(chatId, `Orari: <b>${t.join(', ')}</b>\nVa preso tutti i giorni?\n<i>(Il periodo dal… al… te lo chiedo subito dopo.)</i>`, {
          inline_keyboard: [[{ text: '✅ Sì, tutti i giorni', callback_data: 'D|all' }], [{ text: '📅 Solo certi giorni della settimana (es. il lunedì)', callback_data: 'D|some' }]]
        });
      }
      case 'days': {
        const today = romeParts().date;
        if (/^(tutti|tutti i giorni|ogni giorno|sempre|si|sì)$/i.test(text.trim())) {
          d.days = []; fl.step = 'dur'; await save(); return this.askDur(chatId, mid);
        }
        if (/\d/.test(text)) { // ha scritto delle date: è il periodo, e il farmaco va preso tutti i giorni
          const pr = parsePeriod(text, today);
          if (pr) {
            d.days = []; d.start = pr.start; d.end = pr.end; fl.step = 'stock'; await save();
            await this.send(chatId, `Ho capito: <b>tutti i giorni</b>, dal <b>${fmtDate(pr.start)}</b> al <b>${fmtDate(pr.end)}</b>.`);
            return this.askStock(chatId, mid);
          }
        }
        const ds = parseDays(text);
        if (!ds) return this.ask(chatId, 'Qui servono i giorni della settimana, ad esempio <code>lun mer ven</code>, oppure <b>tutti</b>.\nIl periodo dal… al… te lo chiedo alla domanda successiva.', mid, 'Es. lun mer ven');
        d.days = ds.length === 7 ? [] : ds; fl.step = 'dur'; await save();
        return this.askDur(chatId, mid);
      }
      case 'dur': {
        const today = romeParts().date;
        if (isForever(text) || isSkip(text)) { d.end = ''; d.start = ''; }
        else {
          const pr = parsePeriod(text, today);
          if (!pr) return this.ask(chatId, 'Non ho capito il periodo 🤔 Scrivi ad esempio <code>dal 3/11 al 7/11</code>, oppure il numero di giorni (<code>7</code>), oppure <b>-</b> se è cronica.', mid, 'Es. dal 3/11 al 7/11');
          d.start = pr.start; d.end = pr.end;
        }
        fl.step = 'stock'; await save();
        if (d.end) await this.send(chatId, `📆 Periodo: dal <b>${fmtDate(d.start)}</b> al <b>${fmtDate(d.end)}</b>`);
        return this.askStock(chatId, mid);
      }
      case 'stock': {
        let st = null;
        if (!isSkip(text)) { st = firstNum(text); if (isNaN(st) || st < 0) return this.ask(chatId, 'Scrivi solo il numero di compresse che hai, ad esempio <code>28</code>. Per saltare, scrivi <b>-</b> oppure <b>salta</b>.', mid, 'Es. 28'); }
        const today = romeParts().date;
        const m = { id: rid(), person: d.person, name: d.name, dose: d.dose || '', times: d.times, days: d.days || [], qty: 1, stock: st, since: d.start || '', start: d.start && d.start > today ? d.start : today, end: d.end || '', paused: false, lowLevel: null };
        c.meds.push(m);
        if (st != null) {   // chiediamo subito quante compresse ci sono in una confezione
          c.flows[uid] = { step: 'pack', d: { med: m.id, fromAdd: true } }; await save();
          await this.send(chatId, `✅ Salvato!\n\n${this.medText(c, m)}\n\nTi avviserò a ogni orario.`, { remove_keyboard: true, selective: true });
          return this.ask(chatId, 'Ultima domanda: quante compresse ci sono in <b>una confezione</b>? Così quando lo ricomprate basta toccare "➕ 1 confezione".\nScrivi <b>-</b> per saltare.', mid, 'Es. 30');
        }
        delete c.flows[uid]; await save();
        return this.send(chatId, `✅ Salvato!\n\n${this.medText(c, m)}\n\nTi avviserò a ogni orario.`, { remove_keyboard: true, selective: true });
      }
      case 'pack': {
        const m = c.meds.find(x => x.id === d.med);
        if (!m) { delete c.flows[uid]; await save(); return this.send(chatId, 'Il farmaco non esiste più.'); }
        if (isSkip(text)) m.pack = null;
        else { const v = firstNum(text); if (isNaN(v) || v <= 0) return this.ask(chatId, 'Scrivi solo il numero, ad esempio <code>30</code>.', mid, 'Es. 30'); m.pack = v; }
        delete c.flows[uid]; await save();
        await this.refreshPanels(await this.acl(), chatId, c);
        const v = this.stockCard(c, m, d.fromAdd ? '✅ Salvato!' : '✅ Fatto.');
        return this.send(chatId, v.text, v.kb);
      }
      case 'mpname': {
        const m = c.meds.find(x => x.id === d.med);
        if (!m) { delete c.flows[uid]; await save(); return this.send(chatId, 'Il farmaco non esiste più.'); }
        const nm = text.slice(0, 30);
        let p = c.persons.find(x => x.name.toLowerCase() === nm.toLowerCase());
        if (!p) { p = { id: rid(), name: nm }; c.persons.push(p); }
        m.person = p.id;
        c.persons = c.persons.filter(x => c.meds.some(y => y.person === x.id));
        delete c.flows[uid]; await save();
        const v = this.medDetail(c, m);
        return this.send(chatId, `✅ Ora è di ${esc(p.name)}.\n\n` + v.text, v.kb);
      }
      case 'pfrom': {
        const m = c.meds.find(x => x.id === d.med); const today = romeParts().date;
        if (!m) { delete c.flows[uid]; await save(); return this.send(chatId, 'Il farmaco non esiste più.'); }
        const f = parseDate(text, today);
        if (!f || f <= today) return this.ask(chatId, 'Scrivi un giorno futuro: una data (es. <code>8/11</code>) oppure <code>tra 4 giorni</code>.', mid, 'Es. 8/11');
        d.from = f; fl.step = 'ptimes'; await save();
        return this.ask(chatId, `Dal <b>${fmtDate(f)}</b>, a che ore? Scrivi tutti i nuovi orari, es. <code>8 14 20</code>.`, mid, 'Es. 8 14 20');
      }
      case 'ptimes': {
        const m = c.meds.find(x => x.id === d.med);
        if (!m) { delete c.flows[uid]; await save(); return this.send(chatId, 'Il farmaco non esiste più.'); }
        const t = parseTimes(text);
        if (!t) return this.ask(chatId, 'Non ho capito gli orari 🤔 Riprova, ad esempio <code>8 14 20</code>.', mid, 'Es. 8 14 20');
        m.plan = (m.plan || []).filter(p => p.from !== d.from); m.plan.push({ from: d.from, times: t });
        m.plan.sort((a, b) => a.from < b.from ? -1 : 1);
        delete c.flows[uid]; await save();
        const v = this.planView(c, m);
        return this.send(chatId, '✅ Cambio programmato.\n\n' + v.text, v.kb);
      }
      case 'pinfo_name': case 'pinfo_birth': case 'pinfo_cf': {
        const p = c.persons.find(x => x.id === d.pid);
        if (!p) { delete c.flows[uid]; await save(); return this.send(chatId, 'Persona non trovata.'); }
        p.info = p.info || {};
        if (fl.step === 'pinfo_name') {
          p.info.full = text.slice(0, 60); fl.step = 'pinfo_birth'; await save();
          return this.ask(chatId, 'Data di nascita? (es. <code>12/03/1940</code>)\nScrivi <b>-</b> per saltare.', mid, 'Es. 12/03/1940');
        }
        if (fl.step === 'pinfo_birth') {
          p.info.birth = isSkip(text) ? '' : text.slice(0, 20); fl.step = 'pinfo_cf'; await save();
          return this.ask(chatId, 'Codice fiscale?\nScrivi <b>-</b> per saltare.', mid, 'Es. RSSMRA40C52H501X');
        }
        if (isSkip(text)) p.info.cf = '';
        else {
          const cf = text.toUpperCase().replace(/\s+/g, '');
          if (!/^[A-Z0-9]{16}$/.test(cf)) return this.ask(chatId, 'Il codice fiscale ha 16 caratteri (lettere e numeri). Riprova, oppure scrivi <b>-</b> per saltare.', mid, 'Codice fiscale');
          p.info.cf = cf;
        }
        fl.step = 'pinfo_to'; await save();
        return this.askTo(chatId, mid);
      }
      case 'pinfo_to': {
        const p = c.persons.find(x => x.id === d.pid);
        if (!p) { delete c.flows[uid]; await save(); return this.send(chatId, 'Persona non trovata.'); }
        p.info = p.info || {};
        p.info.to = isSkip(text) ? '' : text.slice(0, 40);
        this.startReq(c, uid, p.id); await save();
        const v = this.reqView(c, uid, d.who);
        return this.send(chatId, '✅ Dati salvati.\n\n' + v.text, v.kb);
      }
      case 'psince': {
        const m = c.meds.find(x => x.id === d.med); const today = romeParts().date;
        if (!m) { delete c.flows[uid]; await save(); return this.send(chatId, 'Il farmaco non esiste più.'); }
        let f = parseDate(text, today);
        if (f && f > today && !/\d{4}/.test(text)) { const y = +f.slice(0, 4) - 1; f = `${y}${f.slice(4)}`; }
        if (!f || f > today) return this.ask(chatId, 'Scrivi la data di inizio, ad esempio <code>3/11</code>.', mid, 'Es. 3/11');
        m.since = f;
        delete c.flows[uid]; await save();
        const v = this.planView(c, m);
        return this.send(chatId, '✅ Fatto.\n\n' + v.text, v.kb);
      }
      case 'pend': {
        const m = c.meds.find(x => x.id === d.med); const today = romeParts().date;
        if (!m) { delete c.flows[uid]; await save(); return this.send(chatId, 'Il farmaco non esiste più.'); }
        if (isForever(text) || isSkip(text)) m.end = '';
        else {
          const e = parseDate(text.replace(/^(?:fino\s+al?|al)\s+/i, ''), today);
          if (!e || e < today) return this.ask(chatId, 'Scrivi l\'ultimo giorno di terapia (es. <code>11/11</code>), oppure <b>-</b> per toglierlo (terapia cronica).', mid, 'Es. 11/11');
          m.end = e;
        }
        delete m.endNotified; delete m.archived;
        delete c.flows[uid]; await save();
        const v = this.planView(c, m);
        return this.send(chatId, '✅ Fatto.\n\n' + v.text, v.kb);
      }
      case 'edit': {
        const m = c.meds.find(x => x.id === d.med);
        if (!m) { delete c.flows[uid]; await save(); return this.send(chatId, 'Il farmaco non esiste più.'); }
        if (d.field === 'name') m.name = text.slice(0, 60);
        else if (d.field === 'dose') m.dose = isSkip(text) ? '' : text.slice(0, 40);
        else if (d.field === 'times') {
          const t = parseTimes(text);
          if (!t) return this.ask(chatId, 'Non ho capito gli orari 🤔 Riprova, ad esempio <code>8 20</code> oppure <code>07:30 19:30</code>.', mid, 'Es. 8 20');
          m.times = t;
        }
        delete c.flows[uid]; await save();
        const v = this.medDetail(c, m);
        return this.send(chatId, '✅ Modificato!\n\n' + v.text, v.kb);
      }
      case 'restock': {
        const st = firstNum(text);
        const m = c.meds.find(x => x.id === d.med);
        if (!m) { delete c.flows[uid]; await save(); return this.send(chatId, 'Il farmaco non esiste più.'); }
        if (isSkip(text)) { m.stock = null; }
        else if (isNaN(st) || st < 0) return this.ask(chatId, 'Scrivi un numero, ad esempio <code>30</code> (oppure <b>-</b> per non contare le scorte).', mid, 'Es. 30');
        else m.stock = st;
        m.lowLevel = null; delete m.lowWarned;
        const alert = this.stockAlert(c, m);
        delete c.flows[uid]; await save();
        await this.refreshPanels(await this.acl(), chatId, c);
        await this.send(chatId, m.stock == null ? `Scorte di <b>${esc(m.name)}</b> non più conteggiate.` : `📦 Giacenza di <b>${esc(m.name)}</b>: ${m.stock} compresse.`);
        if (alert) await this.send(chatId, alert.text, alert.kb);
        return;
      }
    }
  }
  askDur(chatId, mid) {
    return this.ask(chatId, 'Periodo di terapia?\nScrivi <code>dal 3/11 al 7/11</code>, oppure il numero di giorni (es. <code>7</code>).\nSe è una terapia <b>cronica</b>, scrivi <b>-</b>', mid, 'Es. dal 3/11 al 7/11 oppure -');
  }
  askStock(chatId, mid) {
    return this.ask(chatId, 'Quante compresse (o unità) hai adesso? Le scalo a ogni dose e ti avviso quando stanno per finire.\nScrivi solo il numero (es. <code>50</code>), oppure <b>salta</b>.', mid, 'Es. 28');
  }

  /* ---------- viste ---------- */
  medText(c, m) {
    const today = romeParts().date, next = (m.plan || []).filter(p => p.from > today).sort((a, b) => a.from < b.from ? -1 : 1)[0];
    const extra = (next ? `\n🔁 dal ${fmtDate(next.from)}: ${next.times.join(', ')}` : '') + (m.end ? `\n🏁 ${this.ended(m, today) ? 'terminata il' : 'fino al'} ${fmtDate(m.end)}` : '');
    return `<b>${esc(m.name)}</b>${m.dose ? ' ' + esc(m.dose) : ''}${m.paused ? ' ⏸ <i>in pausa</i>' : ''}${this.multi(c) ? '\n👤 ' + esc(this.person(c, m.person)) : ''}\n🕐 ${m.times.join(', ')} · ${daysText(m.days)}${m.stock != null ? `\n📦 ${m.stock} compresse` : ''}` + extra;
  }
  therapyMsg(c, title) {
    const text = this.therapyView(c, title);
    const plain = text.replace(/<b>(.*?)<\/b>/g, '*$1*').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const url = 'https://wa.me/?text=' + encodeURIComponent(plain);
    return { text, kb: c.meds.length && url.length <= 4000 ? { inline_keyboard: [[{ text: '📤 Invia su WhatsApp', url }]] } : undefined };
  }
  async sendTherapy(chatId, c, title) {
    const t = this.therapyView(c, title);
    // versione per WhatsApp: *grassetto* al posto dei tag HTML
    const plain = t.replace(/<b>(.*?)<\/b>/g, '*$1*').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const url = 'https://wa.me/?text=' + encodeURIComponent(plain);
    const ok = c.meds.length && url.length <= 4000;
    await this.send(chatId, t, ok ? { inline_keyboard: [[{ text: '📤 Invia su WhatsApp', url }]] } : undefined);
    if (c.meds.length && !ok) await this.send(chatId, "L'elenco è troppo lungo per il pulsante WhatsApp: tieni premuto il messaggio, tocca Copia e incollalo in WhatsApp.");
  }
  // Copia completa di sicurezza: tutto quello che serve per reinserire i farmaci.
  exportView(c, title) {
    if (!c.meds.length) return 'Non ci sono farmaci da esportare.';
    const n = romeParts();
    let t = `📋 <b>Promemoria farmaci — copia di sicurezza</b>\n${title ? esc(title) + ' · ' : ''}${fmtDate(n.date)} ore ${n.hm}\n`;
    for (const p of c.persons) {
      const ms = c.meds.filter(m => m.person === p.id);
      if (!ms.length) continue;
      t += `\n👤 <b>${esc(p.name)}</b>\n`;
      for (const m of ms) {
        t += `• ${esc(m.name)}${m.dose ? ' ' + esc(m.dose) : ''} — ${m.times.join(', ')}, ${daysText(m.days)}${m.stock != null ? `, scorte ${m.stock}` : ''}${m.paused ? ' (in pausa)' : ''}${this.ended(m, n.date) ? ' (terminato)' : ''}\n`;
        for (const q of [...(m.plan || [])].sort((a, b) => a.from < b.from ? -1 : 1)) t += `   🔁 dal ${fmtDate(q.from)}: ${q.times.join(', ')}\n`;
        if (m.end) t += `   📆 dal ${fmtDate(m.since || m.start)} al ${fmtDate(m.end)}\n`;
        if (m.notes) t += `   📝 ${esc(m.notes)}\n`;
      }
    }
    return t + '\nInoltra questo messaggio ai tuoi Messaggi salvati: se un giorno dovessi reinserire i farmaci, qui trovi tutto.';
  }
  // Elenco della terapia in corso, da mostrare al medico: niente scorte, niente farmaci in pausa o terminati.
  therapyView(c, title) {
    const n = romeParts();
    const active = c.meds.filter(m => !m.paused && !this.ended(m, n.date));
    if (!active.length) return 'Non ci sono terapie in corso.';
    const freq = k => k === 1 ? '1 volta al giorno' : `${k} volte al giorno`;
    const hh = ts => ts.map(t => t.endsWith(':00') ? String(+t.slice(0, 2)) : t.replace(/^0/, '')).join(', ');
    const [y, mo, d] = n.date.split('-').map(Number);
    const dateLong = new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const persons = [...new Set(active.map(m => m.person))];
    let t = `🩺 <b>Terapia in corso</b>${persons.length === 1 ? ' — ' + esc(this.person(c, persons[0])) : ''}\nAggiornata al ${dateLong}\n`;
    for (const pid of persons) {
      if (persons.length > 1) t += `\n<b>${esc(this.person(c, pid))}</b>`;
      const ms = active.filter(m => m.person === pid).sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }) || ((a.since || a.start || '') < (b.since || b.start || '') ? -1 : (a.since || a.start || '') > (b.since || b.start || '') ? 1 : 0));
      const short = dt => { const [, mm, dd] = dt.split('-').map(Number); return `${dd}/${mm}`; };
      const dal = dt => (/^(8|11)\//.test(short(dt)) ? "dall'" : 'dal ') + short(dt);
      const al = dt => (/^(8|11)\//.test(short(dt)) ? "all'" : 'al ') + short(dt);
      // Settimanale solo se il farmaco è in un solo giorno della settimana; altrimenti "N volte al giorno (lun, mer, ven)".
      const freq2 = (m, k) => {
        if (!(m.days.length && m.days.length < 7)) return freq(k);
        if (m.days.length === 1) return k === 1 ? '1 volta a settimana' : `${k} volte al giorno, 1 giorno a settimana`;
        return `${freq(k)} (${daysText(m.days)})`;
      };
      for (const m of ms) {
        const phases = [{ from: m.since || m.start || n.date, times: m.times }, ...[...(m.plan || [])].sort((a, b) => a.from < b.from ? -1 : 1)];
        let line;
        if (phases.length === 1 && !m.end) line = freq2(m, m.times.length);
        else line = phases.map((p, idx) => {
          const to = idx < phases.length - 1 ? addDays(phases[idx + 1].from, -1).date : m.end;
          return `${freq2(m, p.times.length)} ${dal(p.from)}${to ? ' ' + al(to) : ' in poi'}`;
        }).join(', ');
        t += `\n• <b>${esc(m.name)}</b>${m.dose ? ' ' + esc(m.dose) : ''} ${line}`;
        if (m.notes) t += ` (${esc(m.notes)})`;
      }
      t += '\n';
    }
    return t;
  }
  todayView(c, panel) {
    const n = romeParts();
    const pkb = panel ? { inline_keyboard: [[{ text: '🔄 Aggiorna', callback_data: 'OR' }, { text: '🩺 Terapia', callback_data: 'TP' }]] } : undefined;
    if (!c.meds.length) return { text: 'Non ci sono ancora farmaci. Usa /aggiungi per inserirne uno.', kb: pkb };
    const ds = this.dosesOn(c, n.date, n.dow);
    if (!ds.length) return { text: `📅 <b>Oggi, ${fmtDate(n.date)}</b>\nNessuna dose prevista.`, kb: pkb };
    let taken = 0;
    const kb = [];
    const lines = ds.map(d => {
      const e = this.getLog(c, n.date, d.key);
      let ic;
      if (e) { ic = e.s === 'taken' ? '✅' : '⏭'; if (e.s === 'taken') taken++; }
      else if (toMin(d.time) > n.min) ic = '⏳';
      else { ic = n.min - toMin(d.time) > 60 ? '❗' : '🔔'; kb.push([{ text: `✅ ${d.time} ${shortName(d.m.name)}${this.pdot(c, d.m.person, true)}`.slice(0, 60), callback_data: `O|${n.date}|${d.m.id}|${d.time}` }]); }
      return `${ic} ${d.time}  ${this.multi(c) ? '<b>' + esc(this.person(c, d.m.person)) + '</b> · ' : ''}${esc(d.m.name)}${d.m.dose ? ' ' + esc(d.m.dose) : ''}${panel && e && e.by ? ' · <i>' + esc(e.by) + '</i>' : ''}`;
    });
    const text = `📅 <b>Oggi, ${fmtDate(n.date)}</b>\n${taken} di ${ds.length} dosi prese\n\n${lines.join('\n')}${kb.length ? '\n\nTocca per segnare come prese:' : ''}`;
    kb.push(panel ? [{ text: '🔄 Aggiorna', callback_data: 'OR' }, { text: '🩺 Terapia', callback_data: 'TP' }] : [{ text: '🔄 Aggiorna', callback_data: 'OR' }]);
    return { text: panel ? text + `\n\n<i>Quando arriva un promemoria tocca ✅ Preso (⏰ per rimandare, ⏭ per saltare). Aggiornato alle ${n.hm}.</i>` : text, kb: { inline_keyboard: kb } };
  }
  medsView(c) {
    const today = romeParts().date;
    const done = c.meds.filter(m => this.ended(m, today));
    const doneBtn = done.length ? [[{ text: `🗂 Terapie concluse (${done.length})`, callback_data: 'MC' }]] : [];
    const act = c.meds.filter(m => !this.ended(m, today));
    if (!act.length) return { text: 'Non ci sono farmaci in corso. Usa /aggiungi per inserirne uno.', kb: doneBtn.length ? { inline_keyboard: doneBtn } : undefined };
    const order = id => c.persons.findIndex(p => p.id === id);
    const ms = [...act].sort((a, b) => order(a.person) - order(b.person) || a.name.localeCompare(b.name));
    let text = '💊 <b>Farmaci</b>\n', last = null;
    for (const m of ms) {
      if (m.person !== last) { text += this.multi(c) ? `\n👤 <b>${esc(this.person(c, m.person))}</b>\n` : '\n'; last = m.person; }
      text += `• ${esc(m.name)}${m.dose ? ' ' + esc(m.dose) : ''} — ${m.times.join(', ')}${m.paused ? ' ⏸' : ''}\n`;
    }
    text += '\nTocca un farmaco per modificarlo:';
    return { text, kb: { inline_keyboard: [...ms.map(m => [{ text: `${m.paused ? '⏸ ' : ''}${m.name}${this.pdot(c, m.person, true)}`.slice(0, 60), callback_data: 'MM|' + m.id }]), ...doneBtn] } };
  }
  doneView(c) {
    const today = romeParts().date;
    const done = c.meds.filter(m => this.ended(m, today)).sort((a, b) => a.end < b.end ? 1 : -1);
    if (!done.length) return { text: 'Nessuna terapia conclusa.', kb: { inline_keyboard: [[{ text: '⬅️ Elenco', callback_data: 'ML' }]] } };
    return {
      text: '🗂 <b>Terapie concluse</b>\nRestano sempre nello storico. Toccane una per prolungarla o eliminarla.',
      kb: { inline_keyboard: [...done.map(m => [{ text: `${m.name}${m.dose ? ' ' + m.dose : ''} · ${m.archived ? 'archiviato il' : 'fino al'} ${fmtDate(m.archived || m.end)}`.slice(0, 60), callback_data: 'MM|' + m.id }]), [{ text: '⬅️ Elenco', callback_data: 'ML' }]] }
    };
  }
  // dosi previste e prese per un farmaco tra due date (incluse)
  countDoses(c, m, from, to) {
    let n = 0, t = 0;
    for (let d = from, i = 0; d <= to && i < 400; i++) {
      const day = addDays(d, 0);
      if (!(m.days.length && m.days.length < 7 && !m.days.includes(day.dow))) for (const tm of this.timesOn(m, d)) {
        const e = this.getLog(c, d, m.id + '@' + tm);
        if (m.archived && d >= m.archived && !e) continue;
        n++; if (e && e.s === 'taken') t++;
      }
      d = addDays(d, 1).date;
    }
    return { n, t };
  }
  planView(c, m) {
    const today = romeParts().date;
    const rows = [{ from: m.since || m.start || today, times: m.times }, ...[...(m.plan || [])].sort((a, b) => a.from < b.from ? -1 : 1)];
    let t = `📆 <b>Programma di ${esc(m.name)}</b>\n`;
    for (const p of rows) t += `\n• dal ${fmtDate(p.from)}: ${p.times.join(', ')} (${p.times.length} al giorno)`;
    t += `\n\n🏁 ${m.end ? 'Ultimo giorno: <b>' + fmtDate(m.end) + '</b>' + (this.ended(m, today) ? ' (terminata)' : '') : 'Nessuna data di fine'}`;
    const kb = [
      [{ text: '➕ Cambio orari da una data', callback_data: 'MTC|' + m.id }],
      [{ text: '▶️ Inizio terapia', callback_data: 'MTS|' + m.id }, { text: '🏁 Fine terapia', callback_data: 'MTE|' + m.id }]
    ];
    if ((m.plan || []).length || m.end) kb.push([{ text: '🧹 Togli cambi e fine', callback_data: 'MTX|' + m.id }]);
    kb.push([{ text: '⬅️ Farmaco', callback_data: 'MM|' + m.id }]);
    return { text: t, kb: { inline_keyboard: kb } };
  }
  medDetail(c, m) {
    return {
      text: this.medText(c, m), kb: {
        inline_keyboard: [
          [{ text: '✏️ Nome', callback_data: 'ME|' + m.id + '|name' }, { text: '✏️ Dose', callback_data: 'ME|' + m.id + '|dose' }, { text: '🕐 Orari', callback_data: 'ME|' + m.id + '|times' }],
          [...(c.persons.length > 1 ? [{ text: '👤 Chi', callback_data: 'MW|' + m.id }] : []), { text: m.paused ? '▶️ Riprendi' : '⏸ Pausa', callback_data: 'MP|' + m.id }, { text: '📦 Scorte', callback_data: 'SK|' + m.id }],
          [{ text: '📆 Programma', callback_data: 'MT|' + m.id }, this.ended(m, romeParts().date) ? { text: '♻️ Riattiva', callback_data: 'MR|' + m.id } : { text: '🗂 Archivia', callback_data: 'MA|' + m.id }],
          [{ text: '🗑 Elimina', callback_data: 'MD|' + m.id }, { text: '⬅️ Elenco', callback_data: 'ML' }]
        ]
      }
    };
  }
  // Richiesta ricette al medico: selezione dei farmaci e messaggio pronto per WhatsApp
  waRequest(p, meds, who) {
    const info = p.info || {};
    let wa = `Buongiorno${info.to ? ' ' + info.to : ''}, vorrei richiedere ${meds.length === 1 ? 'la ricetta' : 'le ricette'} per:\n*${info.full || p.name}*`;
    if (info.birth) wa += `\nData di nascita: ${info.birth}`;
    if (info.cf) wa += `\nC.F. ${info.cf}`;
    return wa + '\n\n' + meds.map(m => `• ${m.name}${m.dose ? ' ' + m.dose : ''}`).join('\n') + `\n\nGrazie${who ? ',\n' + who : ''}`;
  }
  // Farmaci con scorte per 7 giorni o meno (uno per nome+dosaggio), dal più urgente
  lowMeds(c) {
    const today = romeParts().date;
    const left = m => m.stock / this.perDay(m);
    const ms = c.meds.filter(m => !m.paused && !this.ended(m, today) && m.stock != null && m.times.length && left(m) <= LOW_STOCK_DAYS)
      .sort((a, b) => left(a) - left(b) || a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
    const seen = new Set();
    return ms.filter(m => { const k = (m.name + '|' + m.dose).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  // Messaggio "Da ordinare" nel gruppo semplice: compare (con notifica) quando un farmaco entra nella lista, sparisce quando è vuota
  async updateOrders(acl, mc, c) {
    acl.panels = acl.panels || {}; const P = acl.panels[mc] = acl.panels[mc] || {};
    const low = this.lowMeds(c);
    const keys = low.map(m => m.id).sort().join(',');
    if (!low.length) {
      if (P.orders) { await this.del(mc, P.orders); delete P.orders; delete P.orderKeys; await this.saveAcl(acl); }
      return;
    }
    const days = m => Math.floor(m.stock / this.perDay(m));
    let t = `📦 <b>Da ordinare</b> — scorte per ${LOW_STOCK_DAYS} giorni o meno\n`;
    t += '\n' + low.map(m => `${days(m) <= LAST_STOCK_DAYS ? '🔴' : '🟠'} <b>${esc(m.name)}</b>${m.dose ? ' ' + esc(m.dose) : ''}${this.pp(c, m.person)}: ${m.stock} ${m.stock === 1 ? 'compressa' : 'compresse'}, ${days(m) < 1 ? 'meno di un giorno' : 'circa ' + days(m) + (days(m) === 1 ? ' giorno' : ' giorni')}`).join('\n');
    const kb = [];
    const pids = [...new Set(low.map(m => m.person))];
    let missing = false;
    for (const pid of pids) {
      const p = c.persons.find(x => x.id === pid) || { name: '—' };
      const info = p.info || {};
      if (!info.full) missing = true;
      const url = 'https://wa.me/?text=' + encodeURIComponent(this.waRequest(p, low.filter(m => m.person === pid)));
      kb.push([{ text: `📤 Invia richiesta${info.to ? ' a ' + info.to : ''}${pids.length > 1 ? ' · ' + p.name : ''}`.slice(0, 60), url }]);
    }
    for (const m of low) if (m.pack) kb.push([
      { text: `☑️ ${shortName(m.name)} · 2 conf. (+${m.pack * 2})`.slice(0, 60), callback_data: `SA|${m.id}|2` },
      { text: `1 conf. (+${m.pack})`, callback_data: `SA|${m.id}|1` }
    ]);
    const noPack = low.filter(m => !m.pack);
    t += `\n\n👉 Tocca <b>Invia richiesta</b> per mandare la richiesta delle ricette su WhatsApp.`;
    if (low.some(m => m.pack)) t += `\n👉 Quando un farmaco è stato ritirato in farmacia, tocca il suo pulsante <b>☑️</b> qui sotto (2 confezioni, oppure "1 conf."): la scorta si aggiorna e il farmaco esce dalla lista.`;
    if (noPack.length) t += `\n\n<i>Per avere il pulsante ☑️ anche per ${noPack.map(m => esc(m.name)).join(', ')}, nel gruppo principale imposta le compresse per confezione (/scorte → farmaco → ⚙️).</i>`;
    if (missing) t += `\n\n<i>Mancano i dati dell'assistita: impostali nel gruppo principale da /scorte → Richiedi ricette.</i>`;
    const markup = { inline_keyboard: kb };
    const isNew = P.orderKeys !== undefined && low.some(m => !P.orderKeys.split(',').includes(m.id));
    if (P.orders && !isNew) {
      const r = await this.edit(mc, P.orders, t, markup);
      if (r.ok || /not modified/i.test(r.description || '')) { if (P.orderKeys !== keys) { P.orderKeys = keys; await this.saveAcl(acl); } return; }
    }
    if (P.orders) await this.del(mc, P.orders);   // farmaco nuovo in lista: lo rimandiamo, così suona la notifica
    const r = await this.send(mc, t, markup);
    if (r.ok) { P.orders = r.result.message_id; P.orderKeys = keys; await this.saveAcl(acl); }
  }
  reqView(c, uid, who) {
    const fl = c.flows[uid]; const rq = fl && fl.req;
    if (!rq) return { text: 'Ricomincia da /scorte.' };
    const p = c.persons.find(x => x.id === rq.pid);
    const today = romeParts().date;
    const left = m => (m.stock == null || !m.times.length) ? null : Math.floor(m.stock / this.perDay(m));
    // prima quelli che finiscono prima (come /scorte), in fondo quelli senza conteggio
    const ms = c.meds.filter(m => m.person === rq.pid && !this.ended(m, today))
      .sort((a, b) => (left(a) ?? Infinity) - (left(b) ?? Infinity) || a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
    const seen = new Set(); const uniq = ms.filter(m => { const k = (m.name + '|' + m.dose).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    const info = p.info || {};
    const chosen = uniq.filter(m => rq.sel.includes(m.id));
    const wa = this.waRequest(p, chosen, who);
    const text = `📤 <b>Richiesta ricette</b> — ${esc(info.full || p.name)}${info.to ? '\nDestinatario: ' + esc(info.to) : ''}${info.birth ? '\nData di nascita: ' + esc(info.birth) : ''}${info.cf ? '\nC.F. ' + esc(info.cf) : ''}\n\nTocca i farmaci per sceglierli (✅ = da richiedere). Sono già selezionati quelli con ${YELLOW_DAYS} giorni o meno.`;
    const kb = uniq.map(m => { const d = left(m); return [{ text: `${rq.sel.includes(m.id) ? '✅' : '⬜'} ${shortName(m.name)}${m.dose ? ' ' + m.dose : ''}${d != null ? ` · ${d} gg` : ''}`.slice(0, 60), callback_data: 'RT|' + m.id }]; });
    if (chosen.length) kb.push([{ text: `📤 Invia su WhatsApp (${chosen.length})`, url: 'https://wa.me/?text=' + encodeURIComponent(wa) }]);
    kb.push([{ text: '✏️ Dati assistita', callback_data: 'RI|' + p.id }, { text: 'Chiudi', callback_data: 'RX' }]);
    return { text, kb: { inline_keyboard: kb } };
  }
  askTo(chatId, mid) {
    return this.ask(chatId, 'A chi mandi la richiesta? Scrivi il nome per il saluto (es. <code>Vincenzo</code>), così il messaggio inizia con "Buongiorno Vincenzo".\nScrivi <b>-</b> per un semplice "Buongiorno".', mid, 'Es. Vincenzo');
  }
  startReq(c, uid, pid) {
    const today = romeParts().date;
    const sel = c.meds.filter(m => m.person === pid && !this.ended(m, today) && m.stock != null && m.times.length && m.stock / this.perDay(m) <= YELLOW_DAYS).map(m => m.id);
    c.flows[uid] = { step: 'req', d: {}, req: { pid, sel } };
  }
  stockView(c) {
    if (!c.meds.length) return 'Non ci sono ancora farmaci.';
    const daysLeft = m => (m.stock == null || !m.times.length || this.ended(m, romeParts().date)) ? Infinity : m.stock / this.perDay(m);
    const sorted = c.meds.filter(m => !this.ended(m, romeParts().date)).sort((a, b) => daysLeft(a) - daysLeft(b) || a.name.localeCompare(b.name));
    const lines = sorted.map(m => {
      if (m.stock == null) return `⚪ ${esc(m.name)}${this.pp(c, m.person)}: non conteggiate`;
      const left = m.stock / this.perDay(m), d = Math.floor(left);
      const dot = left <= LOW_STOCK_DAYS ? '🔴' : left <= YELLOW_DAYS ? '🟡' : '🟢';
      const txt = `${esc(m.name)}${this.pp(c, m.person)}: ${m.stock} compresse, ${d < 1 ? 'meno di un giorno' : 'circa ' + d + (d === 1 ? ' giorno' : ' giorni')}`;
      return `${dot} ${dot === '🔴' ? '<b>' + txt + '</b>' : txt}`;
    });
    return `📦 <b>Scorte</b>\n\n${lines.join('\n')}\n\n🟢 più di ${YELLOW_DAYS} giorni · 🟡 ${YELLOW_DAYS} giorni o meno · 🔴 ${LOW_STOCK_DAYS} giorni o meno · ⚪ non conteggiate`;
  }
  // "4 volte al giorno dal 3/11 al 9/11, 3 volte al giorno dal 10/11 al 16/11"
  periodLine(m) {
    const freq = k => k === 1 ? '1 volta al giorno' : `${k} volte al giorno`;
    const freq2 = k => (m.days.length && m.days.length < 7) ? (m.days.length === 1 && k === 1 ? '1 volta a settimana' : `${freq(k)} (${daysText(m.days)})`) : freq(k);
    const short = dt => { const [, mm, dd] = dt.split('-').map(Number); return `${dd}/${mm}`; };
    const dal = dt => (/^(8|11)\//.test(short(dt)) ? "dall'" : 'dal ') + short(dt);
    const al = dt => (/^(8|11)\//.test(short(dt)) ? "all'" : 'al ') + short(dt);
    const start = m.since || m.start;
    const phases = [{ from: start, times: m.times }, ...[...(m.plan || [])].filter(p => !m.end || p.from <= m.end).sort((a, b) => a.from < b.from ? -1 : 1)];
    return phases.map((p, idx) => {
      const to = idx < phases.length - 1 ? addDays(phases[idx + 1].from, -1).date : m.end;
      return `${freq2(p.times.length)} ${dal(p.from)}${to ? ' ' + al(to) : ''}`;
    }).join(', ');
  }
  // Storico delle sole terapie a tempo (con una data di fine): le croniche non compaiono.
  historyView(c) {
    const n = romeParts();
    const timed = c.meds.filter(m => m.end);
    if (!timed.length) return '📋 <b>Storico terapie</b>\n\nNessuna terapia a tempo. Le terapie croniche non compaiono qui: le trovi in /terapia.';
    const byStart = (a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }) || ((a.since || a.start) < (b.since || b.start) ? -1 : 1);
    const line = m => `• <b>${esc(m.name)}</b>${m.dose ? ' ' + esc(m.dose) : ''}${this.pp(c, m.person)}: ${this.periodLine(m)}${m.archived ? ' (sospesa)' : ''}`;
    const now = timed.filter(m => !this.ended(m, n.date)).sort(byStart);
    const done = timed.filter(m => this.ended(m, n.date)).sort((a, b) => a.end < b.end ? 1 : a.end > b.end ? -1 : byStart(a, b));
    let t = '📋 <b>Storico terapie</b>';
    if (now.length) t += '\n\n<b>In corso</b>\n' + now.map(line).join('\n');
    if (done.length) t += '\n\n<b>Concluse</b>\n' + done.map(line).join('\n');
    return t;
  }


  /* ---------- pulsanti ---------- */
  async onCallback(q) {
    const data = q.data || '';
    const ans = t => tg(this.env, 'answerCallbackQuery', { callback_query_id: q.id, ...(t ? { text: t } : {}) });
    if (!q.message) return ans();
    const chatId = String(q.message.chat.id), mid = q.message.message_id, uid = String(q.from.id), who = q.from.first_name || '';
    const acl = await this.acl();

    if (data.startsWith('LK|')) {
      if (uid !== acl.admin) return ans('Solo chi ha creato il bot può farlo');
      const src = data.slice(3);
      if (!acl.chats[src] || src === chatId) return ans();
      acl.mirrors = acl.mirrors || {}; acl.mirrors[chatId] = src; delete acl.chats[chatId];
      await this.saveAcl(acl);
      acl.mcv = acl.mcv || {}; acl.mcv[chatId] = 4; await this.saveAcl(acl);
      await tg(this.env, 'deleteMyCommands', { scope: { type: 'chat', chat_id: Number(chatId) } });
      await this.del(chatId, mid);
      const sc = await this.chat(src);
      await this.mirrorTherapy(acl, chatId, sc, acl.chats[src]);
      await this.updatePanel(acl, chatId, sc, true);
      const st = await tg(this.env, 'getChatMember', { chat_id: chatId, user_id: Number(this.env.TELEGRAM_BOT_TOKEN.split(':')[0]) });
      const adm = st.ok && st.result && st.result.status === 'administrator' && st.result.can_delete_messages && st.result.can_pin_messages;
      if (!adm) await this.send(acl.admin, '⚠️ Per tenere pulito il gruppo semplice (cancellare i promemoria già segnati e fissare il pannello), nomina il bot <b>amministratore</b> del gruppo con i permessi <b>Elimina messaggi</b> e <b>Fissa messaggi</b>.');
      return ans('Collegato');
    }
    const realId = (acl.migrated || {})[chatId] || chatId;    // messaggi rimasti nel gruppo prima del passaggio a supergruppo
    const dataId = (acl.mirrors || {})[realId] || (acl.chats[realId] !== undefined ? realId : chatId);   // nei gruppi semplici i dati sono quelli del gruppo principale
    const isMirror = !!(acl.mirrors || {})[realId];
    if (!acl.chats[dataId]) return ans('Chat non autorizzata');
    const c = await this.chat(dataId);
    const [k, ...r] = data.split('|');
    const today = romeParts().date;
    if (isMirror && !['T', 'S', 'Z', 'U', 'O', 'OR', 'TP', 'SA'].includes(k)) return ans();

    if (['T', 'S', 'Z', 'U', 'O'].includes(k)) {
      const [date, medId, time] = r;
      const m = c.meds.find(x => x.id === medId);
      if (!m) { if (isMirror) await this.del(chatId, mid); else await this.edit(chatId, mid, 'Questo farmaco non è più in elenco.'); return ans(); }
      const key = medId + '@' + time;
      const mset = new Set(this.mirrorsOf(acl, dataId));
      const pressedReminder = !(k === 'O');            // O arriva dal pannello / da /oggi
      let low = null, answer = '', txt, kb;
      if (k === 'O' || k === 'T' || k === 'S') {
        const s0 = k === 'S' ? 'skipped' : 'taken';
        if (!(k === 'O' && this.getLog(c, date, key))) low = this.logDose(c, date, key, m, s0, who);
        txt = this.doseText(c, m, date, time, today) + `\n\n${s0 === 'taken' ? '✅ Preso' : '⏭ Saltato'} alle ${hmOf(Date.now())}${who ? ' · ' + esc(who) : ''}`;
        kb = { inline_keyboard: [[{ text: '↩️ Annulla', callback_data: `U|${date}|${medId}|${time}` }]] };
        answer = s0 === 'taken' ? 'Segnato come preso' : 'Segnato come saltato';
      } else if (k === 'U') {
        this.unlog(c, date, key, m);
        txt = this.doseText(c, m, date, time, today); kb = this.doseKb(date, medId, time); answer = 'Annullato';
      } else { // Z
        if (this.getLog(c, date, key)) return ans('Già segnato');
        const at = Date.now() + SNOOZE_MIN * 60e3;
        c.snooze = c.snooze.filter(x => !(x.key === key && x.date === date));
        c.snooze.push({ date, key, medId, time, at });
        const S = (c.sent[date] || {})[key]; if (S) S.f = 1;
        txt = this.doseText(c, m, date, time, today) + `\n\n⏰ Rimandato alle ${hmOf(at)}${who ? ' · ' + esc(who) : ''}`; kb = undefined;
        answer = `Rimandato di ${SNOOZE_MIN} minuti`;
      }
      // nel gruppo semplice i promemoria si cancellano: lo stato si vede nel pannello
      if (k !== 'U') await this.delMirrorCopies(c, date, key, mset);
      if (isMirror && pressedReminder) await this.del(chatId, mid);
      await this.saveChat(dataId, c);
      if (!isMirror) {
        if (k === 'O') { const v = this.todayView(c); await this.edit(chatId, mid, v.text, v.kb); }
        else await this.edit(chatId, mid, txt, kb);
      }
      await this.syncCopies(c, dataId, date, key, isMirror ? null : chatId, isMirror ? null : mid, txt, kb, mset);
      await this.refreshPanels(acl, dataId, c);
      if (low) await this.send(dataId, low.text, low.kb);
      return ans(answer);
    }
    if (k === 'TP' && isMirror) { await this.mirrorTherapy(acl, realId, c, acl.chats[dataId], true); return ans('Terapia qui sotto 👇'); }
    if (k === 'OR' && isMirror) {
      if (realId !== chatId) await this.del(chatId, mid);   // pannello vecchio: lo togliamo
      await this.updatePanel(acl, realId, c, true); await this.updateOrders(acl, realId, c); return ans('Aggiornato');
    }
    if (k === 'RQ' || k === 'RP' || k === 'RI') {
      const pids = [...new Set(c.meds.filter(m => !this.ended(m, today)).map(m => m.person))];
      let pid = r[0];
      if (k === 'RQ') {
        if (!pids.length) return ans('Nessun farmaco in corso');
        if (pids.length > 1) {
          await this.send(chatId, 'Per chi sono le ricette?', { inline_keyboard: pids.map(id => [{ text: this.person(c, id), callback_data: 'RP|' + id }]) });
          return ans();
        }
        pid = pids[0];
      }
      const p = c.persons.find(x => x.id === pid);
      if (!p) return ans();
      if (k !== 'RI' && p.info && p.info.full && p.info.to === undefined) {
        c.flows[uid] = { step: 'pinfo_to', d: { pid: p.id, who } }; await this.saveChat(dataId, c);
        await this.askTo(chatId, null);
        return ans();
      }
      if (k === 'RI' || !(p.info && p.info.full)) {
        c.flows[uid] = { step: 'pinfo_name', d: { pid: p.id, who } }; await this.saveChat(dataId, c);
        await this.ask(chatId, `Per la richiesta al medico mi servono i dati dell'assistita (li ricordo per le prossime volte).\n\nNome e cognome di <b>${esc(p.name)}</b>?`, null, 'Es. Maria Rossi');
        return ans();
      }
      this.startReq(c, uid, p.id); await this.saveChat(dataId, c);
      const v = this.reqView(c, uid, who); await this.send(chatId, v.text, v.kb);
      return ans();
    }
    if (k === 'RT') {
      const fl2 = c.flows[uid];
      if (!fl2 || !fl2.req) return ans('Ricomincia da /scorte');
      const id = r[0]; const sel = fl2.req.sel;
      fl2.req.sel = sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id];
      await this.saveChat(dataId, c);
      const v = this.reqView(c, uid, who); await this.edit(chatId, mid, v.text, v.kb);
      return ans();
    }
    if (k === 'RX') { delete c.flows[uid]; await this.saveChat(dataId, c); await this.edit(chatId, mid, 'Richiesta chiusa.'); return ans(); }
    if (k === 'OR') { const v = this.todayView(c); await this.edit(chatId, mid, v.text, v.kb); return ans('Aggiornato'); }

    if (k === 'TR') {
      if (uid !== acl.admin) return ans('Solo chi ha creato il bot può farlo');
      if (chatId === acl.admin) return ans();
      const pc = await this.chat(acl.admin);
      const p = pc.persons.find(x => x.id === r[0]);
      if (!p) { await this.edit(chatId, mid, 'Niente da trasferire.'); return ans(); }
      const moving = pc.meds.filter(m => m.person === p.id), ids = new Set(moving.map(m => m.id));
      let gp = c.persons.find(x => x.name.toLowerCase() === p.name.toLowerCase());
      if (!gp) { gp = { id: p.id, name: p.name }; c.persons.push(gp); }
      for (const m of moving) c.meds.push({ ...m, person: gp.id });
      for (const dk of Object.keys(pc.log)) for (const key of Object.keys(pc.log[dk])) if (ids.has(key.split('@')[0])) {
        c.log[dk] = c.log[dk] || {}; c.log[dk][key] = pc.log[dk][key]; delete pc.log[dk][key];
        if (!Object.keys(pc.log[dk]).length) delete pc.log[dk];
      }
      for (const dk of Object.keys(pc.sent)) for (const key of Object.keys(pc.sent[dk])) if (ids.has(key.split('@')[0])) { c.sent[dk] = c.sent[dk] || {}; c.sent[dk][key] = pc.sent[dk][key]; delete pc.sent[dk][key]; }
      pc.meds = pc.meds.filter(m => !ids.has(m.id));
      pc.snooze = pc.snooze.filter(s => !ids.has(s.medId));
      pc.persons = pc.persons.filter(x => x.id !== p.id);
      await this.saveChat(dataId, c); await this.saveChat(acl.admin, pc);
      await this.edit(chatId, mid, `✅ Spostati qui ${moving.length} ${moving.length === 1 ? 'farmaco' : 'farmaci'} di <b>${esc(p.name)}</b>. Da ora i loro promemoria arrivano in questo gruppo.`);
      return ans('Trasferiti');
    }

    // aggiunta guidata
    const fl = c.flows[uid];
    if (k === 'X') { delete c.flows[uid]; await this.saveChat(dataId, c); await this.edit(chatId, mid, 'Operazione annullata.'); return ans(); }
    if (k === 'PC') {
      if (!fl) return ans('Ricomincia con /aggiungi');
      await this.personPicker(chatId, c, uid, mid);
      return ans();
    }
    if (k === 'P' || k === 'PN' || k === 'D') {
      if (!fl) return ans('Ricomincia con /aggiungi');
      if (k === 'PN') {
        fl.step = 'pname'; await this.saveChat(dataId, c);
        await this.edit(chatId, mid, '💊 <b>Nuovo farmaco</b>');
        await this.ask(chatId, 'Come si chiama la persona? (es. Nonno, Mamma, Marco)', null, 'Nome');
        return ans();
      }
      if (k === 'P') {
        const p = c.persons.find(x => x.id === r[0]);
        if (!p || fl.step !== 'person') return ans();
        fl.d.person = p.id; fl.step = 'name'; await this.saveChat(dataId, c);
        await this.edit(chatId, mid, `💊 <b>Nuovo farmaco</b> per ${esc(p.name)}`);
        await this.ask(chatId, 'Come si chiama il farmaco?', null, 'Es. Ramipril');
        return ans();
      }
      if (k === 'D') {
        if (fl.step !== 'days') return ans();
        if (r[0] === 'all') { fl.d.days = []; fl.step = 'dur'; await this.saveChat(dataId, c); await this.edit(chatId, mid, `Orari: <b>${fl.d.times.join(', ')}</b>, tutti i giorni.`); await this.askDur(chatId, null); }
        else { await this.edit(chatId, mid, `Orari: <b>${fl.d.times.join(', ')}</b>`); await this.ask(chatId, 'In quali giorni della settimana? Ad esempio <code>lun</code> oppure <code>lun mer ven</code>.\nSe va preso tutti i giorni scrivi <b>tutti</b>.', null, 'Es. lun mer ven'); }
        return ans();
      }
    }

    // gestione farmaci
    if (k === 'MC') { const v = this.doneView(c); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
    if (k === 'ML') { const v = this.medsView(c); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
    const m = c.meds.find(x => x.id === r[0]);
    if (['MM', 'MP', 'MS', 'MD', 'MDY', 'ME', 'MW', 'MWP', 'MWN', 'MT', 'MTC', 'MTE', 'MTX', 'MTS', 'MA', 'MAY', 'MR', 'SK', 'SA', 'SU', 'PK'].includes(k) && !m) { const v = this.medsView(c); await this.edit(chatId, mid, v.text, v.kb); return ans('Farmaco non trovato'); }
    if (k === 'MM') { const v = this.medDetail(c, m); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
    if (k === 'MP') { m.paused = !m.paused; await this.saveChat(dataId, c); const v = this.medDetail(c, m); await this.edit(chatId, mid, v.text, v.kb); return ans(m.paused ? 'In pausa: niente promemoria' : 'Promemoria riattivati'); }
    if (k === 'MT') { const v = this.planView(c, m); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
    if (k === 'MTC') {
      c.flows[uid] = { step: 'pfrom', d: { med: m.id } }; await this.saveChat(dataId, c);
      await this.ask(chatId, `Da quale giorno cambiano gli orari di <b>${esc(m.name)}</b>?\nScrivi una data (es. <code>8/11</code>) oppure <code>tra 4 giorni</code>.`, null, 'Es. 8/11');
      return ans();
    }
    if (k === 'MTE') {
      c.flows[uid] = { step: 'pend', d: { med: m.id } }; await this.saveChat(dataId, c);
      await this.ask(chatId, `Qual è l'ultimo giorno di terapia di <b>${esc(m.name)}</b>?${m.end ? ` (ora: ${fmtDate(m.end)})` : ''}\nScrivi una data (es. <code>11/11</code>), oppure <b>-</b> se è cronica.`, null, 'Es. 11/11');
      return ans();
    }
    if (k === 'MA') {
      await this.edit(chatId, mid, `Archiviare <b>${esc(m.name)}</b>${m.dose ? ' ' + esc(m.dose) : ''}?\nNon riceverai più promemoria; resterà nello storico tra le terapie concluse.`,
        { inline_keyboard: [[{ text: '🗂 Sì, archivia', callback_data: 'MAY|' + m.id }, { text: 'No', callback_data: 'MM|' + m.id }]] });
      return ans();
    }
    if (k === 'MAY') {
      const today = romeParts().date;
      m.archived = today; m.end = (m.end && m.end < today) ? m.end : today; m.endNotified = true;
      c.snooze = c.snooze.filter(x => x.medId !== m.id);
      await this.saveChat(dataId, c);
      const v = this.medsView(c);
      await this.edit(chatId, mid, `🗂 ${esc(m.name)} archiviato: lo trovi in /storico e in /farmaci → Terapie concluse.\n\n` + v.text, v.kb);
      return ans('Archiviato');
    }
    if (k === 'MR') {
      delete m.archived; m.end = ''; delete m.endNotified;
      await this.saveChat(dataId, c);
      const v = this.medDetail(c, m);
      await this.edit(chatId, mid, '♻️ Riattivato: i promemoria ripartono.\n\n' + v.text, v.kb);
      return ans('Riattivato');
    }
    if (k === 'MTS') {
      c.flows[uid] = { step: 'psince', d: { med: m.id } }; await this.saveChat(dataId, c);
      await this.ask(chatId, `Quando è iniziata la terapia con <b>${esc(m.name)}</b>?\nScrivi la data, ad esempio <code>3/11</code>.`, null, 'Es. 3/11');
      return ans();
    }
    if (k === 'MTX') {
      m.plan = []; m.end = ''; delete m.endNotified; delete m.archived; await this.saveChat(dataId, c);
      const v = this.planView(c, m); await this.edit(chatId, mid, '🧹 Cambi e fine tolti.\n\n' + v.text, v.kb);
      return ans();
    }
    if (k === 'MW') {
      await this.edit(chatId, mid, `Di chi è <b>${esc(m.name)}</b>?`, { inline_keyboard: [
        ...c.persons.filter(p => p.id !== m.person).map(p => [{ text: p.name, callback_data: `MWP|${m.id}|${p.id}` }]),
        [{ text: '➕ Nuova persona', callback_data: 'MWN|' + m.id }], [{ text: '⬅️ Indietro', callback_data: 'MM|' + m.id }]] });
      return ans();
    }
    if (k === 'MWP') {
      const p = c.persons.find(x => x.id === r[1]);
      if (!p) return ans();
      m.person = p.id;
      c.persons = c.persons.filter(x => c.meds.some(y => y.person === x.id));
      await this.saveChat(dataId, c);
      const v = this.medDetail(c, m); await this.edit(chatId, mid, `✅ Ora è di ${esc(p.name)}.\n\n` + v.text, v.kb);
      return ans('Spostato');
    }
    if (k === 'MWN') {
      c.flows[uid] = { step: 'mpname', d: { med: m.id } }; await this.saveChat(dataId, c);
      await this.ask(chatId, `Come si chiama la persona che prende <b>${esc(m.name)}</b>? (es. Mamma)`, null, 'Nome');
      return ans();
    }
    if (k === 'ME') {
      const field = r[1];
      if (!['name', 'dose', 'times'].includes(field)) return ans();
      c.flows[uid] = { step: 'edit', d: { med: m.id, field } }; await this.saveChat(dataId, c);
      const q = {
        name: [`Nuovo nome per <b>${esc(m.name)}</b>?`, 'Nome del farmaco'],
        dose: [`Nuovo dosaggio per <b>${esc(m.name)}</b>?${m.dose ? ` (ora: ${esc(m.dose)})` : ''}\nScrivi <b>salta</b> per toglierlo.`, 'Es. 400 mg'],
        times: [`Nuovi orari per <b>${esc(m.name)}</b>? (ora: ${m.times.join(', ')})\nScrivili tutti, ad esempio <code>8 13 18 23</code>.`, 'Es. 8 20']
      }[field];
      await this.ask(chatId, q[0], null, q[1]);
      return ans();
    }
    if (k === 'SK') { const v = this.stockCard(c, m); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
    if (k === 'SA' || k === 'SU') {
      const q = k === 'SA' ? (m.pack || 0) * (parseInt(r[1], 10) || 1) : (parseInt(r[1], 10) || 0);
      if (!q) return ans();
      m.stock = Math.max(0, (m.stock || 0) + (k === 'SA' ? q : -q));
      if (k === 'SA') { m.lowLevel = null; delete m.lowWarned; }
      await this.saveChat(dataId, c);
      await this.refreshPanels(acl, dataId, c);
      if (isMirror) {   // dal messaggio "Da ordinare": avvisiamo anche il gruppo principale
        await this.send(dataId, `☑️ <b>${esc(m.name)}</b> ritirato${who ? ' da ' + esc(who) : ''}: +${q} compresse (ora ${m.stock}).`, { inline_keyboard: [[{ text: `↩️ Annulla (−${q})`, callback_data: `SU|${m.id}|${q}` }]] });
        return ans(`+${q} compresse`);
      }
      const v = this.stockCard(c, m, k === 'SA' ? `✅ Aggiunte ${q} compresse${who ? ' · ' + esc(who) : ''}.` : `↩️ Tolte ${q} compresse.`);
      if (k === 'SA') v.kb.inline_keyboard.unshift([{ text: `↩️ Annulla (−${q})`, callback_data: `SU|${m.id}|${q}` }]);
      await this.edit(chatId, mid, v.text, v.kb);
      return ans(k === 'SA' ? `+${q} compresse` : 'Annullato');
    }
    if (k === 'PK') {
      c.flows[uid] = { step: 'pack', d: { med: m.id } }; await this.saveChat(dataId, c);
      await this.ask(chatId, `Quante compresse (o unità) ci sono in una confezione di <b>${esc(m.name)}</b>?${m.pack ? ` (ora: ${m.pack})` : ''}`, null, 'Es. 30');
      return ans();
    }
    if (k === 'MS') {
      c.flows[uid] = { step: 'restock', d: { med: m.id } }; await this.saveChat(dataId, c);
      await this.ask(chatId, `Giacenza di <b>${esc(m.name)}</b>: quante compresse avete adesso?${m.stock != null ? ` (ora: ${m.stock})` : ''}\nScrivi <b>-</b> per non contarle.`, null, 'Es. 30');
      return ans();
    }
    if (k === 'MD') {
      await this.edit(chatId, mid, `Eliminare <b>${esc(m.name)}</b>${this.multi(c) ? ' di ' + esc(this.person(c, m.person)) : ''}? Si perde anche il suo storico.`,
        { inline_keyboard: [[{ text: '🗑 Sì, elimina', callback_data: 'MDY|' + m.id }, { text: 'No', callback_data: 'MM|' + m.id }]] });
      return ans();
    }
    if (k === 'MDY') {
      c.meds = c.meds.filter(x => x.id !== m.id);
      for (const dk of Object.keys(c.log)) { for (const key of Object.keys(c.log[dk])) if (key.startsWith(m.id + '@')) delete c.log[dk][key]; if (!Object.keys(c.log[dk]).length) delete c.log[dk]; }
      c.snooze = c.snooze.filter(s => s.medId !== m.id);
      c.persons = c.persons.filter(p => c.meds.some(x => x.person === p.id));
      await this.saveChat(dataId, c);
      const v = this.medsView(c); await this.edit(chatId, mid, `🗑 ${esc(m.name)} eliminato.\n\n` + v.text, v.kb);
      return ans('Eliminato');
    }
    return ans();
  }
}
