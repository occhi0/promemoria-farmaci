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
// Orari dello studio del medico (0 = domenica). Festività e ferie non sono comprese.
const STUDIO = {
  0: [], 1: [['16:30', '19:00']], 2: [['08:30', '10:30'], ['16:30', '18:30']], 3: [['08:30', '11:30']],
  4: [['16:30', '19:00']], 5: [['08:30', '11:30']], 6: []
};
const ORARI_BTN = '/orari 🕐 Orari studio';   // inizia con "/": arriva al bot anche con la privacy dei gruppi attiva
const DOW_FULL = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const hmShort = t => t.replace(/^0/, '');
function studioLine(ts = Date.now()) {
  const n = romeParts(ts);
  for (const [a, b] of STUDIO[n.dow]) if (n.min >= toMin(a) && n.min < toMin(b)) return `🟢 Studio aperto ora, fino alle ${hmShort(b)}`;
  for (let i = 0; i < 8; i++) {
    const d = addDays(n.date, i);
    for (const [a] of STUDIO[d.dow]) {
      if (i === 0 && toMin(a) <= n.min) continue;
      const when = i === 0 ? 'oggi' : i === 1 ? 'domani' : DOW_FULL[d.dow];
      return `🔴 Studio chiuso, riapre ${when} alle ${hmShort(a)}`;
    }
  }
  return '🔴 Studio chiuso';
}
function romeToTs(date, hm) {   // ora locale di Roma -> timestamp (gestisce ora legale/solare)
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = hm.split(':').map(Number);
  let ts = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = romeParts(ts), [py, pm, pd] = p.date.split('-').map(Number);
    const asUtc = Date.UTC(py, pm - 1, pd, Math.floor(p.min / 60), p.min % 60);
    ts -= (asUtc - Date.UTC(y, mo - 1, d, h, mi));
  }
  return ts;
}
function studioOpen(ts = Date.now()) { const n = romeParts(ts); return STUDIO[n.dow].some(([a, b]) => n.min >= toMin(a) && n.min < toMin(b)); }
function nextOpening(ts = Date.now()) {   // { ts, label: "martedì alle 8:30", until: "10:30" }
  const n = romeParts(ts);
  for (let i = 0; i < 8; i++) {
    const d = addDays(n.date, i);
    for (const [a, b] of STUDIO[d.dow]) {
      if (i === 0 && toMin(a) <= n.min) continue;
      return { ts: romeToTs(d.date, a), label: `${i === 0 ? 'oggi' : i === 1 ? 'domani' : DOW_FULL[d.dow]} alle ${hmShort(a)}`, until: hmShort(b) };
    }
  }
  return null;
}
function studioTable(ct) {
  const fmt = sl => sl ? `${hmShort(sl[0])}–${hmShort(sl[1])}` : '—';
  const row = (lbl, d) => {
    const am = STUDIO[d].find(x => toMin(x[0]) < 13 * 60), pm = STUDIO[d].find(x => toMin(x[0]) >= 13 * 60);
    return `${lbl.padEnd(4)}${fmt(am).padEnd(12)}${fmt(pm)}`;
  };
  return `🕐 <b>Orari dello studio medico</b>\n${studioLine()}\n\n<pre>    Mattina     Pomeriggio\n${[['Lun', 1], ['Mar', 2], ['Mer', 3], ['Gio', 4], ['Ven', 5]].map(([l, d]) => row(l, d)).join('\n')}\nSab e Dom: chiuso</pre>\n<i>Questo messaggio si cancella da solo tra 5 minuti.</i>`;
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

const HELP = `💊 <b>Promemoria farmaci — come funziona</b>

<b>Promemoria</b>
All'orario di ogni dose arriva un messaggio con ✅ Preso, ⏰ ${SNOOZE_MIN} min e ⏭ Salta. Se nessuno risponde, lo ricordo dopo ${FOLLOW_UP_MIN} minuti. Se si salta, chiedo il motivo.

<b>Uso quotidiano</b>
/oggi – dosi di oggi, con i farmaci al bisogno dati
/terapia – terapia in corso, da mostrare al medico o inviare su WhatsApp
/scorte – scorte rimaste e 📤 richiesta ricette a Vincenzo

<b>Gestione farmaci</b>
/farmaci – modifica nome, dose, orari, pausa, programma (cambi e fine), tipo di ricetta (📄 SSN · 💶 bianca · 🛒 da banco), archivio
/aggiungi – nuovo farmaco; agli orari scrivi <i>al bisogno</i> se si prende solo quando serve
In /scorte → farmaco: giacenza, confezione e 🔢 unità (compresse, applicazioni, erogazioni…)

<b>Al bisogno</b>
Pulsante 💊 Al bisogno sotto il pannello Oggi: tocchi il farmaco e segno ora, chi l'ha dato e il motivo (anche un'altra ora o un altro giorno).

<b>Controlli</b>
/storico – terapie a tempo, in corso e concluse
/saltate – dosi saltate negli ultimi 90 giorni, con il motivo
/bisogno – farmaci al bisogno dati negli ultimi 90 giorni

<b>Analisi</b>
/analisi – elenco delle analisi di routine e occasionali, con codici e 📤 richiesta a Vincenzo (meglio nel topic 🩸 Analisi)

<b>Avvisi automatici</b>
• Scorte a 7 e a 2 giorni; nel gruppo semplice il messaggio 📦 Da ordinare
• Studio chiuso? ⏰ Ricordamelo all'apertura: la richiesta arriva pronta quando apre

<b>Servizio</b>
/pulisci – cancella i messaggi vecchi · /annulla – interrompe l'operazione in corso · /esporta – copia di sicurezza · /trasferisci – sposta farmaci tra gruppi`;

const COMMANDS = [   // ordinati per uso: giorno per giorno, farmaci, controlli, analisi, servizio
  { command: 'oggi', description: '📅 Dosi di oggi' },
  { command: 'terapia', description: '🩺 Terapia in corso, da mostrare al medico' },
  { command: 'scorte', description: '📦 Compresse rimaste e ricette' },
  { command: 'farmaci', description: '💊 Elenco farmaci: modifica, pausa, archivio' },
  { command: 'aggiungi', description: '➕ Nuovo farmaco (anche al bisogno)' },
  { command: 'storico', description: '🗂 Terapie a tempo, in corso e concluse' },
  { command: 'saltate', description: '⏭ Dosi saltate e motivo' },
  { command: 'bisogno', description: '💊 Farmaci al bisogno dati' },
  { command: 'analisi', description: '🩸 Analisi del sangue' },
  { command: 'pulisci', description: '🧹 Cancella i messaggi vecchi' },
  { command: 'annulla', description: "✖️ Interrompi l'operazione in corso" },
  { command: 'aiuto', description: '❓ Come funziona' },
  { command: 'esporta', description: '💾 Copia di sicurezza completa' },
  { command: 'trasferisci', description: '↪️ Sposta farmaci da un gruppo a un altro' }
];

const MIRROR_COMMANDS = [   // menu del gruppo semplice: solo cose da guardare
  { command: 'terapia', description: '🩺 Terapia in corso, anche da inviare su WhatsApp' },
  { command: 'ricette', description: '📤 Richiedi le ricette al medico' },
  { command: 'orari', description: '🕐 Orari dello studio medico' },
  { command: 'pulisci', description: '🧹 Cancella i messaggi vecchi' },
  { command: 'oggi', description: '📅 Rimetti il pannello di oggi, se è sparito' }
];

const RX_LABEL = { ssn: '📄 Ricetta SSN', bianca: '💶 Ricetta bianca', banco: '🛒 Da banco' };
const rxOf = m => (m && m.rx) || 'ssn';
// unità di conteggio delle scorte: [singolare, plurale]
const UNITS = { cp: ['compressa', 'compresse'], cps: ['capsula', 'capsule'], app: ['applicazione', 'applicazioni'], ero: ['erogazione', 'erogazioni'], bus: ['bustina', 'bustine'], fl: ['flacone', 'flaconi'], fia: ['fiala', 'fiale'], gtt: ['goccia', 'gocce'], dos: ['dose', 'dosi'] };
const unitOf = m => UNITS[(m && m.unit) || 'cp'] || UNITS.cp;
const un = (m, n) => `${n} ${unitOf(m)[n === 1 ? 0 : 1]}`;   // es. "20 applicazioni", "1 compressa"

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
    // Nei gruppi con i topic: si risponde nel topic da cui arriva il comando; altrimenti nel topic "casa" dei farmaci (se impostato)
    const acl = this._acl || await this.acl();
    const home = acl.home && acl.home[String(chatId)];
    const thread = this._thread && String(this._thread.chat) === String(chatId) ? { message_thread_id: this._thread.id } : home ? { message_thread_id: home } : {};
    const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...thread, ...(markup ? { reply_markup: markup } : {}), ...extra };
    let r = await tg(this.env, 'sendMessage', body);
    if (r && !r.ok && body.message_thread_id && home === body.message_thread_id && /thread not found|topic/i.test(r.description || '')) {   // topic dei farmaci cancellato: torna in General
      delete acl.home[String(chatId)]; await this.saveAcl(acl);
      delete body.message_thread_id; r = await tg(this.env, 'sendMessage', body);
    }
    const nid = r && !r.ok && r.parameters && r.parameters.migrate_to_chat_id;
    if (nid) { await this.migrateChat(chatId, nid); r = await tg(this.env, 'sendMessage', { ...body, chat_id: nid }); }
    if (r) r._chat = String(nid || chatId);
    return r;
  }
  edit(chatId, mid, text, markup) {
    return tg(this.env, 'editMessageText', { chat_id: chatId, message_id: mid, text, parse_mode: 'HTML', reply_markup: markup || { inline_keyboard: [] } });
  }
  async ask(chatId, text, replyTo, placeholder) {
    const markup = { force_reply: true, input_field_placeholder: placeholder || '' };
    const extra = {};
    if (replyTo) { markup.selective = true; extra.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true }; }
    return this.fsend(chatId, text, markup, extra);
  }
  // messaggio intermedio di un'operazione: nei gruppi principali si cancella quando l'operazione finisce
  async fsend(chatId, text, markup, extra) {
    const r = await this.send(chatId, text, markup, extra);
    if (r && r.ok && this._sentLog) this._sentLog.push([r._chat, r.result.message_id]);
    return r;
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
    t += m.stock == null ? 'Scorte non conteggiate.' : `Scorte: <b>${m.stock}</b> ${unitOf(m)[m.stock === 1 ? 0 : 1]}${left != null ? `, circa ${left} ${left === 1 ? 'giorno' : 'giorni'}` : ''}.`;
    t += m.pack ? `\nConfezione da ${m.pack}.` : `\nNon so ancora quante ${unitOf(m)[1]} ci sono in una confezione.`;
    const kb = [];
    if (m.pack) kb.push([{ text: `➕ 1 conf. (+${m.pack})`, callback_data: `SA|${m.id}|1` }, { text: `➕ 2 conf. (+${m.pack * 2})`, callback_data: `SA|${m.id}|2` }]);
    else kb.push([{ text: `⚙️ Imposta ${unitOf(m)[1]} per confezione`.slice(0, 60), callback_data: 'PK|' + m.id }]);
    kb.push([{ text: '✏️ Giacenza', callback_data: 'MS|' + m.id }].concat(m.pack ? [{ text: '⚙️ Confezione', callback_data: 'PK|' + m.id }] : []));
    kb.push([{ text: `🔢 Unità: ${unitOf(m)[1]}`, callback_data: 'MU|' + m.id }]);
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
    const text = `${level === LAST_STOCK_DAYS ? '⚠️ <b>Ultimo avviso scorte</b>' : '📦 <b>Scorte in esaurimento</b>'}\n<b>${esc(m.name)}</b>${m.dose ? ' ' + esc(m.dose) : ''}${this.pp(c, m.person)}: restano ${un(m, m.stock)}, ${howLong}.\n${rxOf(m) === 'banco' ? '🛒 Da comprare in farmacia, senza ricetta.' : rxOf(m) === 'bianca' ? 'Ricordati la ricetta bianca e la farmacia.' : 'Ricordati ricetta e farmacia.'} Quando lo ricomprate, toccate qui sotto.`;
    const kb = this.packKb(m);
    return { text, kb };
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
    for (const id of Object.keys(acl.mirrors || {})) await tg(this.env, 'setMyCommands', { commands: MIRROR_COMMANDS, scope: { type: 'chat', chat_id: Number(id) } });
    acl.cmdv = 13; await this.saveAcl(acl);
  }
  // Pulsante fisso in basso (tastiera del bot). Senza "/" funziona solo se la privacy del bot nei gruppi è disattivata.
  async setBottomKb(acl, mc, force) {
    acl.mcv = acl.mcv || {};
    if (!force && (acl.mcv[mc] || 0) >= 8) return;
    const r = await this.send(mc, '🕐 Pulsante degli orari dello studio attivato qui sotto.', { keyboard: [[{ text: ORARI_BTN }]], resize_keyboard: true, is_persistent: true });
    if (r.ok) { acl.mcv[r._chat || mc] = 8; acl.temp = acl.temp || []; acl.temp.push({ chat: r._chat || String(mc), mid: r.result.message_id, at: Date.now() + 60e3 }); await this.saveAcl(acl); }
  }
  async sendTemp(acl, mc, text, minutes) {
    const r = await this.send(mc, text);
    if (r.ok) { acl.temp = acl.temp || []; acl.temp.push({ chat: r._chat || String(mc), mid: r.result.message_id, at: Date.now() + minutes * 60e3 }); await this.saveAcl(acl); }
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
    if (acl.admin && acl.cmdv !== 13) await this.syncCommands(acl);
    if ((acl.wakes || []).some(w => w.at <= nowTs)) {
      for (const w of acl.wakes.filter(w => w.at <= nowTs)) {
        const txt = `🟢 <b>Lo studio è aperto</b> (fino alle ${w.until}).\nEcco la richiesta ${w.kind === 'lab' ? 'analisi' : 'ricette'} preparata${w.who ? ' da ' + esc(w.who) : ''}:\n\n${w.names.map(n => '• ' + esc(n)).join('\n')}\n\n👉 Tocca il pulsante qui sotto per inviarla${w.to ? ' a ' + esc(w.to) : ''} su WhatsApp.`;
        const kb = { inline_keyboard: [[{ text: `📤 Invia${w.to ? ' a ' + w.to : ''} su WhatsApp`.slice(0, 60), url: w.url }]] };
        const r = w.thread ? await this.inThread(w.chat, w.thread, () => this.send(w.chat, txt, kb)) : await this.send(w.chat, txt, kb);
        if (r.ok && w.mirror) { acl.temp = acl.temp || []; acl.temp.push({ chat: r._chat, mid: r.result.message_id, at: nowTs + 3 * 3600e3 }); }
      }
      acl.wakes = acl.wakes.filter(w => w.at > nowTs); await this.saveAcl(acl);
    }
    if ((acl.temp || []).some(t => t.at <= nowTs)) {
      for (const t of acl.temp.filter(t => t.at <= nowTs)) await this.del(t.chat, t.mid);
      acl.temp = acl.temp.filter(t => t.at > nowTs); await this.saveAcl(acl);
    }
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
      if ((c.prn || []).some(x => x.date < keepLog)) { c.prn = c.prn.filter(x => x.date >= keepLog); changed = true; }
      if (!Object.keys(c.sent[n.date]).length) delete c.sent[n.date];
      if (changed) await this.saveChat(chatId, c);
      // pannelli dei gruppi semplici: aggiornati se è successo qualcosa o se è cambiato il giorno
      for (const mc of targets.slice(1)) {
        const P = (acl.panels || {})[mc] || {};
        if (changed || P.day !== n.date || !P.oggi) { await this.updatePanel(acl, mc, c); await this.updateOrders(acl, mc, c); }
        else if (P.orders && P.studio !== studioLine(nowTs)) await this.updateOrders(acl, mc, c);   // lo studio ha aperto/chiuso
      }
    }
  }

  /* ---------- messaggi ---------- */
  // Pulizia nei gruppi principali: le domande e risposte di un'operazione spariscono quando l'operazione finisce.
  async onUpdate(up) {
    this._sentLog = [];
    const m0 = up.message || (up.callback_query && up.callback_query.message);
    this._thread = m0 && m0.is_topic_message && m0.message_thread_id ? { chat: String(m0.chat.id), id: m0.message_thread_id } : null;
    if (up.message && m0.chat && m0.chat.type === 'supergroup' && m0.chat.is_forum === undefined) {   // gruppo semplice con i topic spenti: dimentichiamo i topic salvati
      const a0 = await this.acl(), id0 = String(m0.chat.id);
      if (a0.mirrors && a0.mirrors[id0] && ((a0.labThread || {})[id0] || (a0.home || {})[id0])) {
        const P = (a0.panels || {})[id0];
        if ((a0.labThread || {})[id0] && a0.mirrors && a0.mirrors[id0] && P && P.labs) { await this.del(id0, P.labs); delete P.labs; }
        if (a0.labThread) delete a0.labThread[id0];
        if (a0.home) delete a0.home[id0];
        await this.saveAcl(a0);
      }
    }
    const res = await this.onUpdateInner(up);
    try { await this.tidyFlow(up); } catch (e) { console.log('tidy', e && e.stack || e); }
    return res;
  }
  async tidyFlow(up) {
    const msg = up.message, q = up.callback_query;
    const chatId = String(msg ? msg.chat.id : q && q.message ? q.message.chat.id : '');
    const uid = String(msg ? (msg.from || {}).id : ((q && q.from) || {}).id);
    if (!chatId.startsWith('-')) return;
    const acl = await this.acl();
    const id = (acl.migrated || {})[chatId] || chatId;
    if (!acl.chats[id] || (acl.mirrors || {})[id]) return;   // solo gruppi principali
    const c = await this.chat(id);
    acl.fm = acl.fm || {}; const key = id + ':' + uid;
    const mine = (this._sentLog || []).filter(([ch]) => ch === id).map(([, m]) => m);
    const answer = msg && msg.text && !msg.text.startsWith('/') ? [msg.message_id] : [];
    const list = acl.fm[key] || [];
    if (c.flows[uid]) {
      if (!mine.length && !answer.length) return;
      acl.fm[key] = [...list, ...answer, ...mine].slice(-60);
    } else {
      if (!list.length && !answer.length) return;
      for (const m of [...list, ...answer]) await this.del(id, m);
      delete acl.fm[key];
    }
    await this.saveAcl(acl);
  }
  // /pulisci: cancella gli ultimi messaggi del gruppo (Telegram permette solo quelli delle ultime 48 ore),
  // tenendo i promemoria non ancora segnati e, nei gruppi semplici, pannello, terapia e "Da ordinare".
  async purge(chatId, fromMid, c, keepExtra = []) {
    const keep = new Set(keepExtra.filter(Boolean));
    const a = await this.acl();   // nei gruppi con i topic non tocchiamo il messaggio iniziale dei topic (cancellarlo può eliminare il topic)
    for (const bag of ['home', 'labThread']) if (a[bag] && a[bag][chatId]) keep.add(a[bag][chatId]);
    const P0 = (a.panels || {})[chatId]; if (P0 && P0.labs) keep.add(P0.labs);
    const S0 = (a.scr || {})[chatId]; if (S0 && S0.analisi) keep.add(S0.analisi);
    const known = [];   // promemoria già segnati: il bot conosce i loro id
    for (const [date, byKey] of Object.entries(c.sent || {}))
      for (const [key, S] of Object.entries(byKey)) {
        const mine = (S.msgs || (S.m ? [[chatId, S.m]] : [])).filter(([ch]) => String(ch) === String(chatId)).map(([, m]) => m);
        if (!this.getLog(c, date, key)) mine.forEach(m => keep.add(m)); else known.push(...mine);
      }
    // 1) quelli noti più vecchi del blocco qui sotto, uno alla volta (pochi: Cloudflare gratuito permette ~50 chiamate per volta)
    let single = 0;
    for (const m of known.filter(m => m <= fromMid - 1000).slice(-5)) { const r = await this.del(chatId, m); if (r.ok) single++; }
    // 2) il resto in blocco
    const ids = [];
    for (let m = fromMid; m > fromMid - 1000 && m > 0; m--) if (!keep.has(m)) ids.push(m);
    // se un blocco contiene un messaggio non cancellabile (es. l'inizio di un topic) Telegram rifiuta tutto il blocco:
    // lo dividiamo a metà finché non isoliamo quel messaggio (con un tetto di chiamate, per i limiti di Cloudflare)
    let bulkOk = 0, err = '', budget = 25;   // Cloudflare gratuito: ~50 chiamate per volta in tutto
    const bulk = async part => {
      if (!part.length || budget <= 0) return;
      budget--;
      const r = await tg(this.env, 'deleteMessages', { chat_id: chatId, message_ids: part });
      if (r.ok) { bulkOk++; return; }
      if (!err) err = r.description || 'errore sconosciuto';
      if (part.length === 1) return;
      const h = Math.ceil(part.length / 2);
      await bulk(part.slice(0, h)); await bulk(part.slice(h));
    };
    for (let i = 0; i < ids.length; i += 100) await bulk(ids.slice(i, i + 100));
    return { single, bulkOk, err };
  }
  schedDel(acl, chat, mid, minutes) { acl.temp = acl.temp || []; if (!acl.temp.some(t => t.chat === String(chat) && t.mid === mid)) acl.temp.push({ chat: String(chat), mid, at: Date.now() + minutes * 60e3 }); }
  unschedDel(acl, pairs) { acl.temp = (acl.temp || []).filter(t => !pairs.some(([ch, m]) => String(ch) === t.chat && m === t.mid)); }
  // Schermate dei comandi nei gruppi: resta solo l'ultima di ogni tipo
  async screen(chatId, type, text, kb) {
    const acl = await this.acl();
    const isGroup = String(chatId).startsWith('-');
    const r = await this.send(chatId, text, kb);
    if (isGroup && r.ok) {
      acl.scr = acl.scr || {}; const S = acl.scr[r._chat] = acl.scr[r._chat] || {};
      if (S[type]) await this.del(r._chat, S[type]);
      S[type] = r.result.message_id; await this.saveAcl(acl);
    }
    return r;
  }
  async onUpdateInner(up) {
    if (up.callback_query) return this.onCallback(up.callback_query);
    const msg = up.message;
    if (msg && msg.migrate_to_chat_id) return this.migrateChat(msg.chat.id, msg.migrate_to_chat_id);
    if (msg && msg.migrate_from_chat_id) return this.migrateChat(msg.migrate_from_chat_id, msg.chat.id);
    // Gruppo semplice: via i messaggi di servizio (nome cambiato, messaggio fissato, ingressi, foto…)
    const SERVICE = ['new_chat_title', 'new_chat_photo', 'delete_chat_photo', 'pinned_message', 'new_chat_members', 'left_chat_member', 'message_auto_delete_timer_changed', 'video_chat_scheduled', 'video_chat_started', 'video_chat_ended', 'boost_added', 'chat_background_set', 'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened', 'general_forum_topic_hidden', 'general_forum_topic_unhidden'];
    if (msg && SERVICE.some(k => msg[k] !== undefined)) {
      const a0 = await this.acl();
      const cid = String(msg.chat.id);
      if ((a0.mirrors || {})[cid] || (cid.startsWith('-') && a0.chats[cid] !== undefined)) await this.del(msg.chat.id, msg.message_id);
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
      if (!cmd && text) {
        const sc0 = await this.chat(src); const fl0 = sc0.flows[uid];
        if (fl0 && fl0.step === 'occ_name') return this.occName(src, sc0, uid, fl0, text, msg.message_id);
        if (fl0 && fl0.step === 'skip_reason') return this.skipReason(src, sc0, uid, fl0, text, msg.message_id, chatId);
        if (fl0 && ['prn_new', 'prn_dose', 'prn_reason', 'prn_time'].includes(fl0.step)) return this.flowInput(src, sc0, uid, fl0, text, msg.message_id);
      }
      if (!cmd && text === ORARI_BTN) { await this.del(chatId, msg.message_id); return this.sendTemp(acl, chatId, studioTable(this.contact(await this.chat(acl.mirrors[chatId]))), 5); }
      if (cmd) await this.del(chatId, msg.message_id);   // pagina pulita: via i comandi scritti
      if (cmd === '/oggi') {   // /oggi scritto in un topic lo rende il topic dei promemoria (in General: si torna in General)
        const cur = (acl.home || {})[chatId] || null, want = this._thread && this._thread.id !== (acl.labThread || {})[chatId] ? this._thread.id : (this._thread ? cur : null);
        if (want !== cur) {
          acl.home = acl.home || {}; if (want) acl.home[chatId] = want; else delete acl.home[chatId];
          const P = (acl.panels || {})[chatId];
          if (P) { for (const k of ['oggi', 'terapia', 'orders']) if (P[k]) await this.del(chatId, P[k]); for (const k of ['oggi', 'terapia', 'orders', 'orderKeys', 'pinned', 'day']) delete P[k]; }
          await this.saveAcl(acl); await this.setBottomKb(acl, chatId, true);
        }
      }
      if (cmd) await this.setBottomKb(acl, chatId);
      if ((cmd === '/oggi' || cmd === '/terapia') && ((acl.mcv || {})[chatId] || 0) < 4) {
        acl.mcv = acl.mcv || {}; acl.mcv[chatId] = 4; await this.saveAcl(acl);
        const rk = await this.send(chatId, '…', { remove_keyboard: true });   // toglie i vecchi pulsanti fissi
        if (rk.ok) await this.del(chatId, rk.result.message_id);
        await tg(this.env, 'setMyCommands', { commands: MIRROR_COMMANDS, scope: { type: 'chat', chat_id: Number(chatId) } });
      }
      if (cmd === '/oggi') { const sc = await this.chat(src); await this.updatePanel(acl, chatId, sc, true); return this.updateOrders(acl, chatId, sc); }
      if (cmd === '/terapia') return this.mirrorTherapy(acl, chatId, await this.chat(src), acl.chats[src], true);
      if (cmd === '/analisi' && this._thread) {   // scritto nel topic Analisi del gruppo semplice: lì compare l'elenco
        acl.labThread = acl.labThread || {}; acl.labThread[chatId] = this._thread.id; await this.saveAcl(acl);
        return this.refreshLabs(acl, src, await this.chat(src), true);
      }
      if (cmd === '/orari') return this.sendTemp(acl, chatId, studioTable(this.contact(await this.chat(src))), 5);
      if (cmd === '/ricette') return this.onCallback({ id: '', from: msg.from, data: 'RQ', message: { message_id: 0, chat: msg.chat } });   // come il pulsante 📤 Ricette
      if (cmd === '/pulisci') {
        const sc = await this.chat(src); const P = (acl.panels || {})[chatId] || {};
        const pr = await this.purge(chatId, msg.message_id, sc, [P.oggi, P.orders]);   // la Terapia si cancella: si riapre col pulsante 🩺
        if (P.terapia) { await this.del(chatId, P.terapia); delete P.terapia; }
        acl.temp = (acl.temp || []).filter(t => t.chat !== chatId); await this.saveAcl(acl);
        await this.updatePanel(acl, chatId, sc, true); await this.updateOrders(acl, chatId, sc); await this.refreshLabs(acl, src, sc);
        if (!pr.bulkOk && !pr.single && pr.err) return this.sendTemp(acl, chatId, '⚠️ Non sono riuscito a cancellare i messaggi: ' + esc(pr.err), 3);
        return;
      }
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
    if (cmd && !priv) await this.del(chatId, msg.message_id);   // gruppo principale: via il comando scritto
    if (cmd) {
      switch (cmd) {
        case '/start': case '/aiuto': case '/help': return this.send(chatId, HELP);
        case '/aggiungi': return this.startAdd(chatId, c, uid);
        case '/annulla':
          delete c.flows[uid]; await this.saveChat(chatId, c);
          return this.send(chatId, 'Operazione annullata.', { remove_keyboard: true, selective: true });
        case '/oggi': {
          // /oggi scritto in un topic (non quello delle analisi) lo rende il topic dei farmaci: promemoria e pannelli arriveranno lì
          const a3 = await this.acl(), cur = (a3.home || {})[chatId] || null, lab = (a3.labThread || {})[chatId];
          const want = this._thread && this._thread.id !== lab ? this._thread.id : (!this._thread ? null : cur);
          if (chatId.startsWith('-') && want !== cur) { a3.home = a3.home || {}; if (want) a3.home[chatId] = want; else delete a3.home[chatId]; await this.saveAcl(a3); }
          const v = this.todayView(c); return this.screen(chatId, 'oggi', v.text, v.kb);
        }
        case '/farmaci': { const v = this.medsView(c); return this.screen(chatId, 'farmaci', v.text, v.kb); }
        case '/scorte': {
          const has = c.meds.some(m => !this.ended(m, romeParts().date));
          if (!has) return this.screen(chatId, 'scorte', this.stockView(c));
          const td = romeParts().date;
          const dl = m => (m.stock == null || !m.times.length) ? Infinity : m.stock / this.perDay(m);
          const ms = c.meds.filter(m => !this.ended(m, td)).sort((a, b) => dl(a) - dl(b) || a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
          const seen = new Set(); const uniq = ms.filter(m => { const k2 = (m.name + '|' + m.dose).toLowerCase(); if (seen.has(k2)) return false; seen.add(k2); return true; });
          const rows = [];
          for (let i = 0; i < uniq.length; i += 2) rows.push(uniq.slice(i, i + 2).map(m => ({ text: `📦 ${shortName(m.name)}`.slice(0, 32), callback_data: 'SK|' + m.id })));
          rows.push([{ text: '📤 Richiedi ricette', callback_data: 'RQ' }]);
          return this.screen(chatId, 'scorte', this.stockView(c) + '\n\nTocca un farmaco per aggiungere una confezione.', { inline_keyboard: rows });
        }
        case '/storico': return this.screen(chatId, 'storico', this.historyView(c));
        case '/saltate': return this.screen(chatId, 'saltate', this.skippedView(c));
        case '/bisogno': return this.screen(chatId, 'bisogno', this.prnHistory(c));
        case '/analisi': {
          if (this._thread) { const a2 = await this.acl(); a2.labThread = a2.labThread || {}; a2.labThread[chatId] = this._thread.id; await this.saveAcl(a2); }
          return this.showLabs(chatId, c);
        }
        case '/pulisci': {
          if (priv) return this.send(chatId, 'Questo comando si usa nei gruppi.');
          const pr = await this.purge(chatId, msg.message_id, c);
          const a1 = await this.acl();
          const keepA = ((a1.scr || {})[chatId] || {}).analisi;
          for (const [t, m] of Object.entries((a1.scr || {})[chatId] || {})) if (t !== 'analisi') await this.del(chatId, m);   // via anche le schermate precedenti (l'elenco analisi resta)
          if (a1.scr) a1.scr[chatId] = keepA ? { analisi: keepA } : {};
          if (a1.fm) for (const k of Object.keys(a1.fm)) if (k.startsWith(chatId + ':')) delete a1.fm[k];
          await this.saveAcl(a1);
          const v = this.todayView(c);
          return this.screen(chatId, 'oggi', '🧹 Pulito!\n\n' + v.text, v.kb);
        }
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
      await this.fsend(chatId, `💊 <b>Nuovo farmaco</b> per ${esc(p.name)}`, { inline_keyboard: [[{ text: '👤 È per un\'altra persona', callback_data: 'PC' }]] });
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
    return this.fsend(chatId, '💊 <b>Nuovo farmaco</b>\nPer chi è?', { inline_keyboard: kb });
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
        return this.ask(chatId, 'A che ore va preso? Scrivi uno o più orari, ad esempio:\n<code>8 20</code> oppure <code>08:00 13:30 21:00</code>\nSe si prende solo quando serve, scrivi <b>al bisogno</b>.', mid, 'Es. 8 13 20');
      case 'times': {
        if (/^\s*(al\s+)?bisogno\s*$/i.test(text)) {   // farmaco al bisogno: niente orari né promemoria
          c.occ = c.occ || [];
          if (!c.occ.some(o => o.name.toLowerCase() === d.name.toLowerCase())) c.occ.push({ id: rid(), person: d.person, name: d.name, dose: d.dose || '' });
          delete c.flows[uid]; await save();
          return this.send(chatId, `💊 <b>${esc(d.name)}${d.dose ? ' ' + esc(d.dose) : ''}</b> salvato tra i farmaci <b>al bisogno</b>.\nNiente promemoria: quando lo dai, tocca <b>💊 Al bisogno</b> sotto il pannello Oggi. Compare anche in /terapia e nella richiesta ricette.`);
        }
        const t = parseTimes(text);
        if (!t) return this.ask(chatId, 'Non ho capito gli orari 🤔 Riprova, ad esempio <code>8 20</code> oppure <code>07:30 19:30</code>.', mid, 'Es. 8 20');
        d.times = t; fl.step = 'days'; await save();
        return this.fsend(chatId, `Orari: <b>${t.join(', ')}</b>\nVa preso tutti i giorni?\n<i>(Il periodo dal… al… te lo chiedo subito dopo.)</i>`, {
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
            await this.fsend(chatId, `Ho capito: <b>tutti i giorni</b>, dal <b>${fmtDate(pr.start)}</b> al <b>${fmtDate(pr.end)}</b>.`);
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
        if (d.end) await this.fsend(chatId, `📆 Periodo: dal <b>${fmtDate(d.start)}</b> al <b>${fmtDate(d.end)}</b>`);
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
          await this.fsend(chatId, `✅ Salvato!\n\n${this.medText(c, m)}\n\nTi avviserò a ogni orario.`, { remove_keyboard: true, selective: true });
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
      case 'occ_name': return this.occName(chatId, c, uid, fl, text, mid);
      case 'skip_reason': return this.skipReason(chatId, c, uid, fl, text, mid, chatId);
      case 'prn_new': {   // nuovo farmaco al bisogno: nome, poi dosaggio
        const nm = text.trim().slice(0, 60);
        c.occ = c.occ || [];
        const o = c.occ.find(x => x.name.toLowerCase() === nm.toLowerCase());
        if (o) { delete c.flows[uid]; return this.prnGive(await this.acl(), chatId, c, d.view, o, d.who); }   // c'era già
        d.name = nm; fl.step = 'prn_dose'; await save();
        return this.ask(d.view, `Dosaggio di <b>${esc(nm)}</b>? Ad esempio <i>2 mg</i>.\nOppure scrivi <b>salta</b>.`, mid, 'Es. 2 mg');
      }
      case 'prn_dose': {   // salvo il farmaco e segno subito la somministrazione
        c.occ = c.occ || [];
        const o = { id: rid(), person: (c.persons[0] || {}).id, name: d.name, dose: isSkip(text) ? '' : text.trim().slice(0, 40) };
        c.occ.push(o); delete c.flows[uid];
        return this.prnGive(await this.acl(), chatId, c, d.view, o, d.who);
      }
      case 'prn_time': {   // "14:30", "ieri 21:00", "4/11 21:00", "4/11/2026 21:00"
        const today = romeParts().date;
        let txt = text.trim().toLowerCase(), date = today;
        if (/^ieri\b/.test(txt)) { date = addDays(today, -1).date; txt = txt.replace(/^ieri\b/, ''); }
        else if (/^l'altro ieri\b|^altroieri\b/.test(txt)) { date = addDays(today, -2).date; txt = txt.replace(/^(l'altro ieri|altroieri)\b/, ''); }
        else if (/^oggi\b/.test(txt)) txt = txt.replace(/^oggi\b/, '');
        else {
          const dm = txt.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\s+/);
          if (dm) {
            const y = dm[3] ? (dm[3].length === 2 ? 2000 + +dm[3] : +dm[3]) : +today.slice(0, 4);
            date = `${y}-${String(dm[2]).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`;
            if (date > today) date = `${y - 1}${date.slice(4)}`;   // es. a gennaio "30/12" = dicembre scorso
            txt = txt.slice(dm[0].length);
          }
        }
        const t = parseTimes(txt.trim());
        const okDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(date)) && date >= addDays(today, -89).date;
        if (!t || !okDate || (date === today && toMin(t[0]) > romeParts().min + 5)) return this.ask(d.view, 'Non ho capito 🤔 Scrivi ad esempio <code>14:30</code>, <code>ieri 21:00</code> oppure <code>4/11 21:00</code> (non nel futuro).', mid, 'Es. ieri 21:00');
        const e = (c.prn || []).find(x => x.id === d.id); if (e) { e.hm = t[0]; e.date = date; }
        delete c.flows[uid]; await save();
        const a = await this.acl(); await this.refreshPanels(a, chatId, c); await this.refreshMainToday(a, chatId, c);
        return this.sendTemp(a, d.view, `🕐 Corretto: <b>${esc(e ? e.name : '')}</b> ${date === today ? 'oggi' : fmtDate(date)} alle ${t[0]}.`, 1);
      }
      case 'prn_reason': {
        const e = (c.prn || []).find(x => x.id === d.id); if (e) e.r = text.trim().slice(0, 60);
        delete c.flows[uid]; await save();
        const a = await this.acl(); await this.refreshPanels(a, chatId, c); await this.refreshMainToday(a, chatId, c);
        if (d.q) await this.del(d.view, d.q);
        return;
      }
      case 'lab_add': {
        c.labs = c.labs || { routine: [], occ: [] };
        const today = romeParts().date;
        const names = text.split(/[,;\n]+/).map(x => x.trim()).filter(Boolean).slice(0, 30);
        const list = d.kind === 'r' ? c.labs.routine : c.labs.occ;
        for (const raw of names) {
          // codice in fondo: solo cifre con punti/trattini/barre, almeno 3 caratteri (es. 90.62.2)
          const mm = raw.match(/^(.*?)[\s:=–-]+(\d+\.[\dA-Za-z.]+(?:\s*\(\d+\))?|\d{3,})$/);   // es. 90.62.2, 91.35.G, 90.62.2 (75201)
          const nm = (mm && mm[1].trim() ? mm[1].trim() : raw).slice(0, 60), code = mm && mm[1].trim() ? mm[2] : '';
          const ex = list.find(x => x.name.toLowerCase() === nm.toLowerCase());
          if (ex) { if (code) ex.code = code; } else list.push({ id: rid(), name: nm, code, added: today });
        }
        delete c.flows[uid]; await save(); await this.refreshLabs(await this.acl(), chatId, c);
        return this.showLabs(chatId, c, d.mid);
      }
      case 'lab_code': {
        c.labs = c.labs || { routine: [], occ: [] };
        const x = [...c.labs.routine, ...c.labs.occ].find(y => y.id === d.id);
        if (x) x.code = isSkip(text) || text.trim() === '-' ? '' : text.trim().slice(0, 30);
        delete c.flows[uid]; await save(); await this.refreshLabs(await this.acl(), chatId, c);
        const v = this.labsView(c, 'cod');
        const e = await this.edit(chatId, d.mid, v.text, v.kb); if (!e.ok && !/not modified/i.test(e.description || '')) return this.showLabs(chatId, c);
        return;
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
        fl.step = 'pinfo_tel'; await save();
        return this.askTel(chatId, mid, p.info.to);
      }
      case 'pinfo_tel': {
        const p = c.persons.find(x => x.id === d.pid);
        if (!p) { delete c.flows[uid]; await save(); return this.send(chatId, 'Persona non trovata.'); }
        p.info = p.info || {};
        if (isSkip(text)) p.info.tel = '';
        else { const t = text.replace(/[^\d+ ]/g, '').trim(); if (t.replace(/\D/g, '').length < 6) return this.ask(chatId, 'Scrivi il numero di telefono, ad esempio <code>+39 333 123 4567</code>, oppure <b>-</b> per saltare.', mid, 'Telefono'); p.info.tel = t; }
        await this.refreshPanels(await this.acl(), chatId, c);
        this.startReq(c, uid, p.id); await save();
        await this.del(chatId, mid);   // via dalla chat il messaggio con il numero
        const v = this.reqView(c, uid, d.who);
        const r1 = await this.screen(chatId, 'ricette', '✅ Dati salvati.\n\n' + v.text, v.kb);
        if (r1.ok && c.flows[uid] && c.flows[uid].req) { c.flows[uid].req.mid = r1.result.message_id; await save(); }
        return r1;
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
        await this.send(chatId, m.stock == null ? `Scorte di <b>${esc(m.name)}</b> non più conteggiate.` : `📦 Giacenza di <b>${esc(m.name)}</b>: ${un(m, m.stock)}.`);
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
    return `<b>${esc(m.name)}</b>${m.dose ? ' ' + esc(m.dose) : ''}${m.paused ? ' ⏸ <i>in pausa</i>' : ''}${this.multi(c) ? '\n👤 ' + esc(this.person(c, m.person)) : ''}\n🕐 ${m.times.join(', ')} · ${daysText(m.days)}${m.stock != null ? `\n📦 ${un(m, m.stock)}` : ''}\n${RX_LABEL[rxOf(m)]}` + extra;
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
    await this.screen(chatId, 'terapia', t, ok ? { inline_keyboard: [[{ text: '📤 Invia su WhatsApp', url }]] } : undefined);
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
    if (!active.length && !(c.occ || []).length) return 'Non ci sono terapie in corso.';
    const freq = k => k === 1 ? '1 volta al giorno' : `${k} volte al giorno`;
    const hh = ts => ts.map(t => t.endsWith(':00') ? String(+t.slice(0, 2)) : t.replace(/^0/, '')).join(', ');
    const [y, mo, d] = n.date.split('-').map(Number);
    const dateLong = new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const persons = [...new Set([...active.map(m => m.person), ...(c.occ || []).map(o => o.person)])];
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
      const occ = (c.occ || []).filter(o => o.person === pid);
      if (occ.length) t += `\n\n<b>Al bisogno</b>` + occ.map(o => `\n• <b>${esc(o.name)}</b>${o.dose ? ' ' + esc(o.dose) : ''}${o.unit ? ' (' + unitOf(o)[1] + ')' : ''}`).join('');
      t += '\n';
    }
    return t;
  }
  // gruppo per funzione, dedotto dal nome dell'analisi
  labGroup(name) {
    const n = ' ' + name.toLowerCase() + ' ';
    const G = [
      ['🫘 Reni', /creatinin|\burea\b|azotemia|acido urico|\burat|uricemia|egfr|filtrato|clearance|microalbumin|esame urine|urinocoltura/],
      ['🧂 Sali minerali', /\bsodio\b|potassio|\bclor|magnesio|calcio|fosforo|fosfat(?!asi)|paratorm|\bpth\b/],
      ['❤️ Cuore', /\bbnp\b|probnp|troponin|\bcpk\b|\bck\b/],
      ['🟤 Fegato', /\bast\b|\bgot\b|\balt\b|\bgpt\b|gamma|\bggt\b|bilirubin|fosfatasi alcalina|albumin(?!uria)|protidogramma|proteine totali/],
      ['🩸 Sangue', /emocromo|ferritin|sideremia|transferrin|\binr\b|\bpt\b|\bptt\b|b12|folat|\bves\b|\bpcr\b/],
      ['⚖️ Metabolismo', /glicemia|glucosio|glicata|colesterol|\bhdl\b|\bldl\b|triglicerid|\btsh\b|\bft3\b|\bft4\b|tiroid/],
    ];
    for (const [g, re] of G) if (re.test(n)) return g;
    return /prelievo/.test(n) ? '' : '📋 Altre';
  }
  // 🩸 Analisi: elenco di routine e occasionali (nel topic del gruppo principale)
  labsView(c, mode) {
    const L = c.labs = c.labs || { routine: [], occ: [] };
    let t = '🩸 <b>Analisi</b>\n';
    const cod = x => x.code ? ` — <code>${esc(x.code)}</code>` : '';
    t += '\n<b>Di routine</b>';
    if (!L.routine.length) t += '\n<i>nessuna</i>';
    else {
      const order = ['🫘 Reni', '🧂 Sali minerali', '❤️ Cuore', '🟤 Fegato', '🩸 Sangue', '⚖️ Metabolismo', '📋 Altre', ''];
      const by = {}; for (const x of L.routine) (by[this.labGroup(x.name)] = by[this.labGroup(x.name)] || []).push(x);
      for (const g of order) if (by[g]) t += (g ? `\n<i>${g}</i>` : '\n<i>🩹 Prelievo</i>') + by[g].map(x => `\n• ${esc(x.name)}${cod(x)}`).join('');
    }
    t += '\n\n<b>Occasionali</b>' + (L.occ.length ? L.occ.map(x => `\n• ${esc(x.name)}${cod(x)} <i>(dal ${fmtDate(x.added)})</i>`).join('') : '\n<i>nessuna</i>');
    const kb = [];
    if (mode === 'del') {
      t += '\n\nTocca un\'analisi per toglierla:';
      for (const x of L.routine) kb.push([{ text: `🗑 ${x.name}`.slice(0, 60), callback_data: 'LD|' + x.id }]);
      for (const x of L.occ) kb.push([{ text: `🗑 ${x.name}`.slice(0, 60), callback_data: 'LD|' + x.id }]);
      kb.push([{ text: '⬅️ Fine', callback_data: 'LB' }]);
    } else if (mode === 'mirror') {
      if (L.routine.length || L.occ.length) kb.push([{ text: '📤 Richiedi analisi', callback_data: 'LQ' }]);
    } else if (mode === 'cod') {
      t += '\n\nTocca un\'analisi per scrivere o cambiare il suo codice:';
      for (const x of [...L.routine, ...L.occ]) kb.push([{ text: `🔢 ${x.name}${x.code ? ' · ' + x.code : ''}`.slice(0, 60), callback_data: 'LC|' + x.id }]);
      kb.push([{ text: '⬅️ Fine', callback_data: 'LB' }]);
    } else {
      for (const x of L.occ) kb.push([{ text: `✅ Fatta: ${x.name}`.slice(0, 60), callback_data: 'LD|' + x.id }]);
      kb.push([{ text: '➕ Routine', callback_data: 'LA|r' }, { text: '➕ Occasionale', callback_data: 'LA|o' }]);
      if (L.routine.length || L.occ.length) kb.push([{ text: '🔢 Codici', callback_data: 'LK' }, { text: '🗑 Togli', callback_data: 'LX' }], [{ text: '📤 Richiedi analisi', callback_data: 'LQ' }]);
    }
    return { text: t, kb: { inline_keyboard: kb } };
  }
  async showLabs(chatId, c, mid) {
    const v = this.labsView(c);
    if (mid) { const r = await this.edit(chatId, mid, v.text, v.kb); if (r.ok || /not modified/i.test(r.description || '')) return; }
    return this.screen(chatId, 'analisi', v.text, v.kb);
  }
  // ── farmaci al bisogno: somministrazioni (c.prn = [{id, med, name, t, date, hm, by, r}]) ──
  prnToday(c, date) {
    const L = (c.prn || []).filter(x => x.date === date);
    L.sort((a, b) => a.hm < b.hm ? -1 : 1);
    return L.length ? '\n\n<b>Al bisogno</b>\n' + L.map(x => `💊 ${x.hm}  ${esc(x.name)}${x.r ? ' (' + esc(x.r) + ')' : ''}${x.by ? ' · <i>' + esc(x.by) + '</i>' : ''}`).join('\n') : '';
  }
  prnPick(c) {
    const occ = c.occ || [];
    const kb = occ.map(o => [{ text: `💊 ${o.name}${o.dose ? ' ' + o.dose : ''}`.slice(0, 60), callback_data: 'PG|' + o.id }]);
    kb.push([{ text: '➕ Nuovo farmaco', callback_data: 'PW' }, { text: 'Chiudi', callback_data: 'PX' }]);
    const today = romeParts().date, given = (c.prn || []).filter(x => x.date === today).sort((a, b) => a.hm < b.hm ? -1 : 1);
    for (const x of given) kb.push([{ text: `🕐 ${x.hm} ${x.name}`.slice(0, 50), callback_data: 'PT|' + x.id }, { text: '🗑', callback_data: 'PD|' + x.id }]);
    return { text: '💊 <b>Al bisogno</b>\n' + (occ.length ? 'Tocca il farmaco che hai dato: segno l\'ora e chi l\'ha dato.' : 'Nessun farmaco al bisogno salvato: tocca ➕ Nuovo farmaco.') + (given.length ? '\n\nGià dati oggi: tocca 🕐 per correggere l\'ora, 🗑 per cancellare.' : ''), kb: { inline_keyboard: kb } };
  }
  async prnGive(acl, dataId, c, view, o, who) {
    const n = romeParts();
    c.prn = c.prn || [];
    const e = { id: rid(), med: o.id, name: o.name + (o.dose ? ' ' + o.dose : ''), t: Date.now(), date: n.date, hm: n.hm, by: who || '' };
    c.prn.push(e); await this.saveChat(dataId, c);
    await this.refreshPanels(acl, dataId, c); await this.refreshMainToday(acl, dataId, c);
    const R = [['🤕 Dolore', 'd'], ['🌡 Febbre', 'f'], ['😖 Prurito', 'p'], ['😟 Agitazione', 'a'], ['🤢 Nausea', 'n'], ['✏️ Altro', 'o']];
    const base = 'PR|' + e.id + '|';
    const qk = { inline_keyboard: [R.slice(0, 3).map(([t, x]) => ({ text: t, callback_data: base + x })), R.slice(3).map(([t, x]) => ({ text: t, callback_data: base + x })), [{ text: 'Nessun motivo', callback_data: base + '-' }], [{ text: '🕐 Dato a un\'altra ora o giorno', callback_data: 'PT|' + e.id }]] };
    const qm = await this.send(view, `💊 Segnato: <b>${esc(e.name)}</b> alle ${e.hm}${who ? ' · ' + esc(who) : ''}.\nPer cosa?`, qk);
    if (qm.ok) { this.schedDel(acl, view, qm.result.message_id, 30); await this.saveAcl(acl); }
  }
  async refreshMainToday(acl, dataId, c) {   // aggiorna la schermata Oggi del gruppo principale, se c'è
    const S = (acl.scr || {})[dataId]; if (!S || !S.oggi) return;
    const v = this.todayView(c); await this.edit(dataId, S.oggi, v.text, v.kb);
  }
  prnHistory(c) {
    const by = {};
    for (const x of (c.prn || [])) (by[x.date] = by[x.date] || []).push(x);
    const days = Object.keys(by).sort().reverse();
    if (!days.length) return '💊 <b>Al bisogno</b> (ultimi 90 giorni)\n\n<i>Nessuna somministrazione segnata.</i>';
    return '💊 <b>Al bisogno</b> (ultimi 90 giorni)\n' + days.map(d => `\n<b>${fmtDate(d)}</b>\n` + by[d].sort((a, b) => a.hm < b.hm ? -1 : 1).map(x => `• ${x.hm} ${esc(x.name)}${x.r ? ' — <i>' + esc(x.r) + '</i>' : ''}${x.by ? ' · ' + esc(x.by) : ''}`).join('\n')).join('\n');
  }
  // motivo di una dose saltata (scritto a mano)
  async skipReason(dataId, c, uid, fl, text, mid, view) {
    const d = fl.d, e = (c.log[d.date] || {})[d.key];
    if (e && e.s === 'skipped') e.r = text.trim().slice(0, 80);
    delete c.flows[uid]; await this.saveChat(dataId, c);
    if (d.q) await this.del(d.view || view, d.q);
    const a = await this.acl(); return this.sendTemp(a, d.view || view, `📝 Motivo segnato: <i>${esc(text.trim().slice(0, 80))}</i>`, 1);
  }
  skippedView(c) {
    const rows = [];
    for (const date of Object.keys(c.log).sort().reverse()) {
      const day = [];
      for (const [key, e] of Object.entries(c.log[date])) {
        if (e.s !== 'skipped') continue;
        const [medId, time] = key.split('@'); const m = c.meds.find(x => x.id === medId) || (c.archive || []).find(x => x.id === medId);
        day.push([time, `• ${time} ${esc(m ? m.name + (m.dose ? ' ' + m.dose : '') : 'farmaco eliminato')}${e.r ? ' — <i>' + esc(e.r) + '</i>' : ''}${e.by ? ' · ' + esc(e.by) : ''}`]);
      }
      if (day.length) rows.push(`\n<b>${fmtDate(date)}</b>\n` + day.sort((a, b) => a[0] < b[0] ? -1 : 1).map(x => x[1]).join('\n'));
    }
    return '⏭ <b>Dosi saltate</b> (ultimi 90 giorni)\n' + (rows.length ? rows.join('\n') : '\n<i>Nessuna dose saltata.</i> 👍');
  }
  // invia/modifica dentro un topic preciso (es. Analisi del gruppo semplice)
  async inThread(chat, thread, fn) {
    const old = this._thread; this._thread = thread ? { chat: String(chat), id: thread } : null;
    try { return await fn(); } finally { this._thread = old; }
  }
  // elenco analisi (senza pulsanti di modifica) nel topic Analisi dei gruppi semplici
  async refreshLabs(acl, srcId, c, force) {
    for (const mc of this.mirrorsOf(acl, srcId)) {
      const th = (acl.labThread || {})[mc]; if (!th) continue;
      acl.panels = acl.panels || {}; const P = acl.panels[mc] = acl.panels[mc] || {};
      const v = this.labsView(c, 'mirror');
      if (P.labs && !force) { const e = await this.edit(mc, P.labs, v.text, v.kb); if (e.ok || /not modified/i.test(e.description || '')) continue; }
      if (P.labs) await this.del(mc, P.labs);
      const r = await this.inThread(mc, th, () => this.send(mc, v.text, v.kb));
      if (r.ok) { P.labs = r.result.message_id; await this.saveAcl(acl); }
      else if (/thread not found|topic/i.test(r.description || '')) { delete acl.labThread[mc]; delete P.labs; await this.saveAcl(acl); }   // topic Analisi eliminato: non lo usiamo più
    }
  }
  labPerson(c) { return c.persons.find(x => x.info && x.info.full) || c.persons[0] || { name: 'Mamma' }; }
  labWa(p, items, who) {
    const info = p.info || {};
    let wa = `Buongiorno${info.to ? ' ' + info.to : ''}, vorrei richiedere la prescrizione per ${items.length === 1 ? 'questa analisi' : 'queste analisi'} per:\n*${info.full || p.name}*`;
    if (info.birth) wa += `\nData di nascita: ${info.birth}`;
    if (info.cf) wa += `\nC.F. ${info.cf}`;
    return wa + '\n\n' + items.map(x => `• ${x.name}${x.code ? ' – cod. ' + x.code : ''}`).join('\n') + `\n\nGrazie${who ? ',\n' + who : ''}`;
  }
  labReqView(c, uid, who) {
    const L = c.labs = c.labs || { routine: [], occ: [] };
    const rq = (c.lreq || {})[uid]; if (!rq) return { text: 'Ricomincia da 📤 Richiedi analisi.', kb: { inline_keyboard: [] } };
    const p = this.labPerson(c), info = p.info || {};
    const all = [...L.routine, ...L.occ];
    const chosen = all.filter(x => rq.sel.includes(x.id));
    const text = `${studioLine()}\n\n📤 <b>Richiesta analisi</b> — ${esc(info.full || p.name)}${info.to ? '\nDestinatario: ' + esc(info.to) : ''}\n\nTocca le analisi per sceglierle (✅ = da richiedere).`;
    const kb = all.map(x => [{ text: `${rq.sel.includes(x.id) ? '✅' : '⬜'} ${x.name}${x.code ? ' · ' + x.code : ''}`.slice(0, 60), callback_data: 'LT|' + x.id }]);
    if (chosen.length) {
      const url = this.waUrl(p, this.labWa(p, chosen, who));
      if (!studioOpen()) kb.push([{ text: '⏰ Ricordamelo all\'apertura', callback_data: 'LW' }, { text: '📤 Invia comunque', url }]);
      else kb.push([{ text: `📤 Invia${info.to ? ' a ' + info.to : ''} su WhatsApp (${chosen.length})`.slice(0, 60), url }]);
    }
    kb.push([{ text: 'Chiudi', callback_data: 'LQX' }]);
    return { text, kb: { inline_keyboard: kb } };
  }
  todayView(c, panel) {
    const n = romeParts();
    const PRN = [{ text: '💊 Al bisogno', callback_data: 'PB' }];
    const pkb = panel ? { inline_keyboard: [[{ text: '🔄 Aggiorna', callback_data: 'OR' }, PRN[0]]] } : { inline_keyboard: [PRN] };
    const prnTxt = this.prnToday(c, n.date);
    if (!c.meds.length) return { text: 'Non ci sono ancora farmaci. Usa /aggiungi per inserirne uno.' + prnTxt, kb: pkb };
    const ds = this.dosesOn(c, n.date, n.dow);
    if (!ds.length) return { text: `📅 <b>Oggi, ${fmtDate(n.date)}</b>\nNessuna dose prevista.` + prnTxt, kb: pkb };
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
    const text = `📅 <b>Oggi, ${fmtDate(n.date)}</b>\n${taken} di ${ds.length} dosi prese\n\n${lines.join('\n')}${prnTxt}${kb.length ? '\n\nTocca per segnare come prese:' : ''}`;
    if (panel) kb.push([{ text: '🔄 Aggiorna', callback_data: 'OR' }, PRN[0]]);
    else kb.push([{ text: '🔄 Aggiorna', callback_data: 'OR' }], PRN);
    return { text: panel ? text + `\n\n<i>Quando arriva un promemoria tocca ✅ Preso (⏰ per rimandare, ⏭ per saltare). Aggiornato alle ${n.hm}.</i>` : text, kb: { inline_keyboard: kb } };
  }
  medsView(c) {
    const today = romeParts().date;
    const done = c.meds.filter(m => this.ended(m, today));
    const doneBtn = [...(done.length ? [[{ text: `🗂 Terapie concluse (${done.length})`, callback_data: 'MC' }]] : []), ...((c.occ || []).length ? [[{ text: `💊 Al bisogno (${c.occ.length})`, callback_data: 'OL' }]] : [])];
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
          [{ text: RX_LABEL[rxOf(m)] + ' ↻', callback_data: 'MRX|' + m.id }],
          [{ text: '🗑 Elimina', callback_data: 'MD|' + m.id }, { text: '⬅️ Elenco', callback_data: 'ML' }]
        ]
      }
    };
  }
  // Richiesta ricette al medico: selezione dei farmaci e messaggio pronto per WhatsApp
  waUrl(p, text) {
    const tel = ((p.info || {}).tel || '').replace(/\D/g, '');
    const num = tel.startsWith('00') ? tel.slice(2) : (tel.length === 10 && tel.startsWith('3') ? '39' + tel : tel);   // wa.me vuole il prefisso senza "+"
    return 'https://wa.me/' + (num ? num : '') + '?text=' + encodeURIComponent(text);
  }
  waRequest(p, meds, who) {
    const info = p.info || {};
    let wa = `Buongiorno${info.to ? ' ' + info.to : ''}, vorrei richiedere ${meds.length === 1 ? 'la ricetta' : 'le ricette'} per:\n*${info.full || p.name}*`;
    if (info.birth) wa += `\nData di nascita: ${info.birth}`;
    if (info.cf) wa += `\nC.F. ${info.cf}`;
    return wa + '\n\n' + meds.map(m => `• ${m.name}${m.dose ? ' ' + m.dose : ''}${rxOf(m) === 'bianca' ? ' (ricetta bianca)' : ''}`).join('\n') + `\n\nGrazie${who ? ',\n' + who : ''}`;
  }
  // lista per la farmacia (farmaci da banco): si sceglie a chi mandarla su WhatsApp
  waShop(c, meds) {
    const pn = [...new Set(meds.map(m => this.person(c, m.person)))].join(', ');
    return `🛒 Da comprare in farmacia${pn ? ' (' + pn + ')' : ''}:\n` + meds.map(m => `• ${m.name}${m.dose ? ' ' + m.dose : ''}${m.pack ? ' – 1 conf.' : ''}`).join('\n');
  }
  // Farmaci con scorte per 7 giorni o meno (uno per nome+dosaggio), dal più urgente
  contact(c) {   // telefono della segreteria, dai dati dell'assistita
    const p = c.persons.find(x => x.info && x.info.tel);
    return p ? { tel: p.info.tel, to: p.info.to || '' } : null;
  }
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
    t += '\n' + low.map(m => `${days(m) <= LAST_STOCK_DAYS ? '🔴' : '🟠'} <b>${esc(m.name)}</b>${m.dose ? ' ' + esc(m.dose) : ''}${this.pp(c, m.person)}: ${un(m, m.stock)}, ${days(m) < 1 ? 'meno di un giorno' : 'circa ' + days(m) + (days(m) === 1 ? ' giorno' : ' giorni')}`).join('\n');
    const kb = [];
    const rxLow = low.filter(m => rxOf(m) !== 'banco'), shop = low.filter(m => rxOf(m) === 'banco');
    if (shop.length) t += `\n\n🛒 <b>Da comprare in farmacia</b> (senza ricetta): ${shop.map(m => esc(m.name)).join(', ')}`;
    const pids = [...new Set(rxLow.map(m => m.person))];
    let missing = false;
    for (const pid of pids) {
      const p = c.persons.find(x => x.id === pid) || { name: '—' };
      const info = p.info || {};
      if (!info.full) missing = true;
      const url = this.waUrl(p, this.waRequest(p, rxLow.filter(m => m.person === pid)));
      if (!studioOpen()) kb.push([{ text: '⏰ Ricordamelo all\'apertura', callback_data: 'RWo|' + pid }, { text: '📤 Invia comunque', url }]);
      else kb.push([{ text: `📤 Invia richiesta${info.to ? ' a ' + info.to : ''}${pids.length > 1 ? ' · ' + p.name : ''}`.slice(0, 60), url }]);
    }
    for (const m of low) if (m.pack) kb.push([
      { text: `☑️ ${shortName(m.name)} · 2 conf. (+${m.pack * 2})`.slice(0, 60), callback_data: `SA|${m.id}|2` },
      { text: `1 conf. (+${m.pack})`, callback_data: `SA|${m.id}|1` }
    ]);
    const noPack = low.filter(m => !m.pack);
    const sl = studioLine();
    if (rxLow.length) {
      t += `\n\n${sl}`;
      t += studioOpen() ? `\n👉 Tocca <b>Invia richiesta</b> per mandare la richiesta delle ricette su WhatsApp.` : `\n👉 Tocca <b>Ricordamelo all'apertura</b>: quando lo studio apre ti arriva la richiesta pronta da inviare (oppure <b>Invia comunque</b>).`;
    }
    if (shop.length) t += `\n👉 I farmaci 🛒 si comprano direttamente in farmacia, senza ricetta.`;
    if (low.some(m => m.pack)) t += `\n👉 Quando un farmaco è stato ritirato in farmacia, tocca il suo pulsante <b>☑️</b> qui sotto (2 confezioni, oppure "1 conf."): la scorta si aggiorna e il farmaco esce dalla lista.`;
    if (noPack.length) t += `\n\n<i>Per avere il pulsante ☑️ anche per ${noPack.map(m => esc(m.name)).join(', ')}, nel gruppo principale imposta quante unità ci sono in una confezione (/scorte → farmaco → ⚙️).</i>`;
    if (missing) t += `\n\n<i>Mancano i dati dell'assistita: impostali nel gruppo principale da /scorte → Richiedi ricette.</i>`;
    const markup = { inline_keyboard: kb };
    const isNew = P.orderKeys !== undefined && low.some(m => !P.orderKeys.split(',').includes(m.id));
    if (P.orders && !isNew) {
      const r = await this.edit(mc, P.orders, t, markup);
      if (r.ok || /not modified/i.test(r.description || '')) { if (P.orderKeys !== keys || P.studio !== sl) { P.orderKeys = keys; P.studio = sl; await this.saveAcl(acl); } return; }
    }
    if (P.orders) await this.del(mc, P.orders);   // farmaco nuovo in lista: lo rimandiamo, così suona la notifica
    const r = await this.send(mc, t, markup);
    if (r.ok) { P.orders = r.result.message_id; P.orderKeys = keys; P.studio = sl; await this.saveAcl(acl); }
  }
  reqView(c, uid, who, mirror) {
    const fl = c.flows[uid]; const rq = fl && fl.req;
    if (!rq) return { text: 'Ricomincia da /scorte.' };
    const p = c.persons.find(x => x.id === rq.pid);
    const today = romeParts().date;
    const left = m => (m.stock == null || !m.times.length) ? null : Math.floor(m.stock / this.perDay(m));
    // prima quelli che finiscono prima (come /scorte), in fondo quelli senza conteggio
    const ms = c.meds.filter(m => m.person === rq.pid && !this.ended(m, today) && rxOf(m) !== 'banco')
      .sort((a, b) => (left(a) ?? Infinity) - (left(b) ?? Infinity) || a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
    const seen = new Set(); const uniq = ms.filter(m => { const k = (m.name + '|' + m.dose).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    const info = p.info || {};
    const occ = (c.occ || []).filter(o => o.person === rq.pid && rxOf(o) !== 'banco');
    const extra = rq.extra || [];
    const chosen = [...uniq, ...occ, ...extra].filter(m => rq.sel.includes(m.id));
    const wa = this.waRequest(p, chosen, who);
    const text = `${studioLine()}\n\n📤 <b>Richiesta ricette</b> — ${esc(info.full || p.name)}${info.to ? '\nDestinatario: ' + esc(info.to) : ''}${info.birth ? '\nData di nascita: ' + esc(info.birth) : ''}${info.cf ? '\nC.F. ' + esc(info.cf) : ''}\n\nTocca i farmaci per sceglierli (✅ = da richiedere). ${(c.reqDraft || {})[rq.pid] ? 'Le scelte restano salvate anche se chiudi: dopo l\'invio tocca <b>↺ Ricomincia</b>.' : `Sono già selezionati quelli con ${YELLOW_DAYS} giorni o meno.`}`;
    const kb = uniq.map(m => { const d = left(m); return [{ text: `${rq.sel.includes(m.id) ? '✅' : '⬜'} ${shortName(m.name)}${m.dose ? ' ' + m.dose : ''}${d != null ? ` · ${d} gg` : ''}`.slice(0, 60), callback_data: 'RT|' + m.id }]; });
    for (const o of occ) kb.push([{ text: `${rq.sel.includes(o.id) ? '✅' : '⬜'} ${shortName(o.name)} · al bisogno`.slice(0, 60), callback_data: 'RT|' + o.id }]);
    for (const x of extra) kb.push([{ text: `${rq.sel.includes(x.id) ? '✅' : '⬜'} ${shortName(x.name)} · solo ora`.slice(0, 60), callback_data: 'RT|' + x.id }]);
    kb.push([{ text: '➕ Altro farmaco', callback_data: 'RA' }, ...((c.reqDraft || {})[rq.pid] ? [{ text: '↺ Ricomincia', callback_data: 'RZ' }] : [])]);
    if (chosen.length) {
      if (!studioOpen()) kb.push([{ text: '⏰ Ricordamelo all\'apertura', callback_data: 'RW' }, { text: '📤 Invia comunque', url: this.waUrl(p, wa) }]);
      else kb.push([{ text: `📤 Invia${info.to ? ' a ' + info.to : ''} su WhatsApp (${chosen.length})`.slice(0, 60), url: this.waUrl(p, wa) }]);
    }
    if (!mirror && !info.tel) kb.push([{ text: `📞 Numero di ${info.to || 'segreteria'} (per WhatsApp)`.slice(0, 60), callback_data: 'RN|' + p.id }]);
    kb.push(mirror ? [{ text: 'Chiudi', callback_data: 'RX' }] : [{ text: '✏️ Dati assistita', callback_data: 'RI|' + p.id }, { text: 'Chiudi', callback_data: 'RX' }]);
    return { text, kb: { inline_keyboard: kb } };
  }
  // "Altro farmaco" nella richiesta: dopo il nome chiediamo se salvarlo tra i farmaci al bisogno
  async occName(dataId, c, uid, fl, text, answerMid) {
    const view = fl.d.view;
    if (fl.d.q) await this.del(view, fl.d.q);
    if (answerMid) await this.del(view, answerMid);
    fl.d.name = text.slice(0, 60); fl.step = 'occ_save';
    await this.saveChat(dataId, c);
    return this.fsend(view, `<b>${esc(fl.d.name)}</b>: lo salvo tra i farmaci <b>al bisogno</b>? Comparirà in /terapia e nelle prossime richieste, senza promemoria.`,
      { inline_keyboard: [[{ text: '💾 Sì, salvalo', callback_data: 'RS|y' }, { text: 'Solo questa volta', callback_data: 'RS|n' }]] });
  }
  askTel(chatId, mid, to) {
    return this.ask(chatId, `Numero di telefono ${to ? 'di <b>' + esc(to) + '</b>' : 'della segreteria'}? Serve solo per aprire WhatsApp direttamente sulla sua chat: <b>non verrà mostrato</b> nei gruppi.\nScrivi <b>-</b> per saltare.`, mid, 'Es. +39 333 123 4567');
  }
  askTo(chatId, mid) {
    return this.ask(chatId, 'A chi mandi la richiesta? Scrivi il nome per il saluto (es. <code>Vincenzo</code>), così il messaggio inizia con "Buongiorno Vincenzo".\nScrivi <b>-</b> per un semplice "Buongiorno".', mid, 'Es. Vincenzo');
  }
  startReq(c, uid, pid) {
    const today = romeParts().date;
    const auto = c.meds.filter(m => m.person === pid && !this.ended(m, today) && rxOf(m) !== 'banco' && m.stock != null && m.times.length && m.stock / this.perDay(m) <= YELLOW_DAYS).map(m => m.id);
    // bozza salvata (scelte e farmaci "solo questa volta"): resta finché non si tocca ↺ Ricomincia, al massimo 30 giorni
    const dr = (c.reqDraft || {})[pid];
    if (dr && Date.now() - dr.at < 30 * 864e5) {
      const sel = [...dr.sel, ...auto.filter(id => !(dr.auto || []).includes(id) && !dr.sel.includes(id))];   // i farmaci diventati "bassi" dopo si aggiungono
      c.flows[uid] = { step: 'req', d: {}, req: { pid, sel, extra: dr.extra || [], auto } };
    } else c.flows[uid] = { step: 'req', d: {}, req: { pid, sel: auto, auto } };
  }
  saveDraft(c, rq) { c.reqDraft = c.reqDraft || {}; c.reqDraft[rq.pid] = { sel: [...rq.sel], extra: rq.extra || [], auto: rq.auto || [], at: Date.now() }; }
  stockView(c) {
    if (!c.meds.length) return 'Non ci sono ancora farmaci.';
    const daysLeft = m => (m.stock == null || !m.times.length || this.ended(m, romeParts().date)) ? Infinity : m.stock / this.perDay(m);
    const sorted = c.meds.filter(m => !this.ended(m, romeParts().date)).sort((a, b) => daysLeft(a) - daysLeft(b) || a.name.localeCompare(b.name));
    const lines = sorted.map(m => {
      if (m.stock == null) return `⚪ ${esc(m.name)}${this.pp(c, m.person)}: non conteggiate`;
      const left = m.stock / this.perDay(m), d = Math.floor(left);
      const dot = left <= LOW_STOCK_DAYS ? '🔴' : left <= YELLOW_DAYS ? '🟡' : '🟢';
      const txt = `${esc(m.name)}${rxOf(m) === 'banco' ? ' 🛒' : rxOf(m) === 'bianca' ? ' 💶' : ''}${this.pp(c, m.person)}: ${un(m, m.stock)}, ${d < 1 ? 'meno di un giorno' : 'circa ' + d + (d === 1 ? ' giorno' : ' giorni')}`;
      return `${dot} ${dot === '🔴' ? '<b>' + txt + '</b>' : txt}`;
    });
    return `📦 <b>Scorte</b>\n\n${lines.join('\n')}\n\n🟢 più di ${YELLOW_DAYS} giorni · 🟡 ${YELLOW_DAYS} giorni o meno · 🔴 ${LOW_STOCK_DAYS} giorni o meno · ⚪ non conteggiate${c.meds.some(m => rxOf(m) !== 'ssn') ? '\n🛒 da banco, senza ricetta · 💶 ricetta bianca' : ''}`;
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
      await tg(this.env, 'setMyCommands', { commands: MIRROR_COMMANDS, scope: { type: 'chat', chat_id: Number(chatId) } });
      await this.del(chatId, mid);
      const sc = await this.chat(src);
      await this.mirrorTherapy(acl, chatId, sc, acl.chats[src]);
      await this.updatePanel(acl, chatId, sc, true);
      await this.setBottomKb(acl, chatId);
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
    if (isMirror && !['T', 'S', 'Z', 'U', 'O', 'OR', 'TP', 'SA', 'OS', 'RQ', 'RT', 'RA', 'RS', 'RX', 'RW', 'RWo', 'RZ', 'LQ', 'LT', 'LW', 'LQX', 'SR', 'PB', 'PG', 'PW', 'PX', 'PR', 'PT', 'PD'].includes(k)) return ans();

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
      {   // gruppo principale: i promemoria segnati spariscono dopo 2 minuti (c'è tempo per ↩️ Annulla)
        const S = (c.sent[date] || {})[key];
        const copies = (S && S.msgs ? S.msgs : (S && S.m ? [[dataId, S.m]] : [])).filter(([ch]) => !mset.has(String(ch)) && String(ch).startsWith('-'));
        if (!isMirror && pressedReminder && chatId.startsWith('-') && !copies.some(([ch, m]) => String(ch) === chatId && m === mid)) copies.push([chatId, mid]);
        if (k === 'U') this.unschedDel(acl, copies);
        else if (k === 'T' || k === 'S' || k === 'O') for (const [ch, m] of copies) this.schedDel(acl, ch, m, 2);
        if (copies.length) await this.saveAcl(acl);
      }
      await this.refreshPanels(acl, dataId, c);
      if (low) await this.send(dataId, low.text, low.kb);
      if (k === 'S') {   // perché è stata saltata?
        const view = isMirror ? realId : chatId, base = `SR|${date}|${medId}|${time}|`;
        const R = [['😣 Rifiutato', 'r'], ['😴 Dormiva', 'd'], ['🤢 Nausea', 'n'], ['📦 Finito', 'f'], ['🩺 Medico', 'm'], ['✏️ Altro', 'o']];
        const qk = { inline_keyboard: [R.slice(0, 3).map(([t, x]) => ({ text: t, callback_data: base + x })), R.slice(3).map(([t, x]) => ({ text: t, callback_data: base + x })), [{ text: 'Nessun motivo', callback_data: base + '-' }]] };
        const qm = await this.send(view, `⏭ Perché è stata saltata <b>${esc(m.name)}</b> delle ${time}?`, qk);
        if (qm.ok) this.schedDel(acl, view, qm.result.message_id, 30), await this.saveAcl(acl);
      }
      return ans(answer);
    }
    if (k === 'PD') {
      const view = isMirror ? realId : chatId;
      c.prn = (c.prn || []).filter(x => x.id !== r[0]); await this.saveChat(dataId, c);
      const v = this.prnPick(c); await this.edit(view, mid, v.text, v.kb);
      await this.refreshPanels(acl, dataId, c); await this.refreshMainToday(acl, dataId, c);
      return ans('Cancellato');
    }
    if (k === 'PT') {   // somministrazione registrata a un orario diverso da adesso
      const view = isMirror ? realId : chatId, e = (c.prn || []).find(x => x.id === r[0]); if (!e) return ans();
      c.flows[uid] = { step: 'prn_time', d: { id: e.id, view } }; await this.saveChat(dataId, c);
      await this.ask(view, `Quando hai dato <b>${esc(e.name)}</b>?\nSe era oggi scrivi solo l'ora, ad esempio <code>14:30</code>.\nSe era un altro giorno: <code>ieri 21:00</code> oppure <code>4/11 21:00</code>.`, null, 'Es. ieri 21:00'); return ans();
    }
    if (['PB', 'PG', 'PW', 'PX', 'PR'].includes(k)) {
      const view = isMirror ? realId : chatId;
      if (k === 'PX') { await this.del(view, mid); return ans(); }
      if (k === 'PB') { const v = this.prnPick(c); await this.screen(view, 'prn', v.text, v.kb); return ans(); }
      if (k === 'PW') {
        c.flows[uid] = { step: 'prn_new', d: { view, who } }; await this.saveChat(dataId, c); await this.del(view, mid);
        await this.ask(view, 'Quale farmaco al bisogno hai dato? Scrivi solo il nome, il dosaggio te lo chiedo dopo. Lo salvo per le prossime volte.', null, 'Es. Tachipirina'); return ans();
      }
      if (k === 'PG') {
        const o = (c.occ || []).find(x => x.id === r[0]); if (!o) return ans('Farmaco non trovato');
        await this.del(view, mid); await this.prnGive(acl, dataId, c, view, o, who); return ans('Segnato');
      }
      // PR: motivo
      const e = (c.prn || []).find(x => x.id === r[0]); if (!e) { await this.del(view, mid); return ans(); }
      if (r[1] === 'o') {
        c.flows[uid] = { step: 'prn_reason', d: { id: e.id, q: mid, view } }; await this.saveChat(dataId, c);
        await this.ask(view, 'Scrivi il motivo:', null, 'Es. dolore al ginocchio'); return ans();
      }
      const M = { d: 'dolore', f: 'febbre', p: 'prurito', a: 'agitazione', n: 'nausea' };
      if (M[r[1]]) e.r = M[r[1]]; else delete e.r;
      await this.saveChat(dataId, c); await this.del(view, mid); await this.refreshPanels(acl, dataId, c); await this.refreshMainToday(acl, dataId, c);
      return ans(M[r[1]] ? 'Motivo: ' + M[r[1]] : 'Ok');
    }
    if (k === 'SR') {
      const [date, medId, time, x] = r, key = medId + '@' + time, view = isMirror ? realId : chatId;
      const e = (c.log[date] || {})[key];
      if (!e || e.s !== 'skipped') { await this.del(view, mid); return ans('La dose non risulta più saltata'); }
      if (x === 'o') {
        c.flows[uid] = { step: 'skip_reason', d: { date, key, q: mid, view } }; await this.saveChat(dataId, c);
        await this.ask(view, 'Scrivi il motivo:', null, 'Es. aveva la febbre'); return ans();
      }
      const M = { r: 'rifiutato', d: 'dormiva', n: 'nausea/vomito', f: 'farmaco finito', m: 'indicazione del medico' };
      if (M[x]) e.r = M[x]; else delete e.r;
      await this.saveChat(dataId, c); await this.del(view, mid);
      return ans(M[x] ? 'Motivo: ' + M[x] : 'Ok');
    }
    if (k === 'OS' && isMirror) { await this.sendTemp(acl, realId, studioTable(this.contact(c)), 5); return ans('Orari qui sotto 👇'); }
    if (k === 'TP' && isMirror) { await this.setBottomKb(acl, realId); await this.mirrorTherapy(acl, realId, c, acl.chats[dataId], true); return ans('Terapia qui sotto 👇'); }
    if (k === 'OR' && isMirror) {
      if (realId !== chatId) await this.del(chatId, mid);   // pannello vecchio: lo togliamo
      await this.setBottomKb(acl, realId); await this.updatePanel(acl, realId, c, true); await this.updateOrders(acl, realId, c); return ans('Aggiornato');
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
      if (isMirror) {   // gruppo semplice: niente domande sui dati, la richiesta si cancella da sola dopo 15 minuti
        this.startReq(c, uid, p.id);
        const v = this.reqView(c, uid, who, true);
        const r0 = await this.send(realId, v.text + ((p.info && p.info.full) ? '' : '\n\n<i>Dati dell\'assistita non impostati: chiedi ad Antonietta di inserirli.</i>'), v.kb);
        if (r0.ok) { c.flows[uid].req.mid = r0.result.message_id; acl.temp = acl.temp || []; acl.temp.push({ chat: r0._chat, mid: r0.result.message_id, at: Date.now() + 15 * 60e3 }); await this.saveAcl(acl); }
        await this.saveChat(dataId, c);
        return ans();
      }
      if (k !== 'RI' && p.info && p.info.full && p.info.to !== undefined && p.info.tel === undefined) {
        c.flows[uid] = { step: 'pinfo_tel', d: { pid: p.id, who } }; await this.saveChat(dataId, c);
        await this.askTel(chatId, null, p.info.to);
        return ans();
      }
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
      this.startReq(c, uid, p.id);
      const v = this.reqView(c, uid, who); const r1 = await this.screen(chatId, 'ricette', v.text, v.kb);
      if (r1.ok) c.flows[uid].req.mid = r1.result.message_id;
      await this.saveChat(dataId, c);
      return ans();
    }
    if (['LQ', 'LT', 'LW', 'LQX'].includes(k)) {
      const view = isMirror ? realId : chatId;
      c.lreq = c.lreq || {}; c.labs = c.labs || { routine: [], occ: [] };
      if (k === 'LQX') { delete c.lreq[uid]; await this.saveChat(dataId, c); await this.del(view, mid); return ans(); }
      if (k === 'LQ') {
        c.lreq[uid] = { sel: [...c.labs.routine, ...c.labs.occ].map(x => x.id) }; await this.saveChat(dataId, c);
        const v = this.labReqView(c, uid, who); await this.screen(view, 'lreq', v.text, v.kb); return ans();
      }
      const rq = c.lreq[uid]; if (!rq) return ans('Ricomincia da 📤 Richiedi analisi');
      if (k === 'LT') {
        rq.sel = rq.sel.includes(r[0]) ? rq.sel.filter(x => x !== r[0]) : [...rq.sel, r[0]]; await this.saveChat(dataId, c);
        const v = this.labReqView(c, uid, who); await this.edit(view, mid, v.text, v.kb); return ans();
      }
      // LW: richiesta pronta all'apertura dello studio, nello stesso topic
      const no = nextOpening(); if (!no) return ans();
      const p = this.labPerson(c);
      const items = [...c.labs.routine, ...c.labs.occ].filter(x => rq.sel.includes(x.id));
      if (!items.length) return ans('Nessuna analisi selezionata');
      acl.wakes = (acl.wakes || []).filter(w => !(w.chat === view && w.by === uid && w.kind === 'lab'));
      acl.wakes.push({ kind: 'lab', chat: view, thread: q.message.message_thread_id || null, by: uid, who, at: no.ts, until: no.until, to: (p.info || {}).to || '', names: items.map(x => x.name + (x.code ? ' – ' + x.code : '')), url: this.waUrl(p, this.labWa(p, items, who)), mirror: isMirror });
      await this.saveAcl(acl);
      delete c.lreq[uid]; await this.saveChat(dataId, c); await this.del(view, mid);
      return tg(this.env, 'answerCallbackQuery', { callback_query_id: q.id, text: `⏰ Ok! Ti avviso ${no.label}, quando lo studio apre.`, show_alert: true });
    }
    if (['LB', 'LX', 'LA', 'LD', 'LK', 'LC'].includes(k)) {
      c.labs = c.labs || { routine: [], occ: [] };
      if (k === 'LB') { const v = this.labsView(c); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
      if (k === 'LX') { const v = this.labsView(c, 'del'); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
      if (k === 'LK') { const v = this.labsView(c, 'cod'); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
      if (k === 'LC') {
        const x = [...c.labs.routine, ...c.labs.occ].find(y => y.id === r[0]); if (!x) return ans();
        c.flows[uid] = { step: 'lab_code', d: { id: x.id, mid } }; await this.saveChat(dataId, c);
        await this.ask(chatId, `Codice di <b>${esc(x.name)}</b>?` + (x.code ? `\nOra è <code>${esc(x.code)}</code>. Scrivi <b>-</b> per toglierlo.` : ''), null, 'Es. 90.62.2');
        return ans();
      }
      if (k === 'LD') {
        const was = [...c.labs.routine, ...c.labs.occ].find(x => x.id === r[0]);
        const inDel = (q.message.reply_markup ? JSON.stringify(q.message.reply_markup) : '').includes('"LB"');
        c.labs.routine = c.labs.routine.filter(x => x.id !== r[0]); c.labs.occ = c.labs.occ.filter(x => x.id !== r[0]);
        await this.saveChat(dataId, c); await this.refreshLabs(acl, dataId, c);
        const v = this.labsView(c, inDel && (c.labs.routine.length || c.labs.occ.length) ? 'del' : undefined); await this.edit(chatId, mid, v.text, v.kb);
        return ans(was ? `Tolta: ${was.name}` : '');
      }
      // LA: aggiunta
      c.flows[uid] = { step: 'lab_add', d: { kind: r[0], mid } }; await this.saveChat(dataId, c);
      await this.ask(chatId, (r[0] === 'r' ? 'Quali analisi di <b>routine</b>? Puoi scriverne più di una separate da virgola.' : 'Quale analisi <b>occasionale</b>?') + '\nSe vuoi, metti il codice dopo il nome, ad esempio:\n<code>' + (r[0] === 'r' ? 'Emocromo 90.62.2, Creatinina 90.16.3' : 'Urinocoltura 90.94.2') + '</code>', null, 'Es. Emocromo 90.62.2');
      return ans();
    }
    if (k === 'RW' || k === 'RWo') {
      const no = nextOpening();
      if (!no) return ans();
      let p, meds;
      if (k === 'RW') {
        const fl2 = c.flows[uid]; const rq = fl2 && fl2.req;
        if (!rq) return ans('Ricomincia dalla richiesta ricette');
        p = c.persons.find(x => x.id === rq.pid);
        const td = romeParts().date;
        const all = [...c.meds.filter(m => m.person === rq.pid && !this.ended(m, td)), ...(c.occ || []).filter(o => o.person === rq.pid), ...(rq.extra || [])];
        const seen = new Set(); meds = all.filter(m => rq.sel.includes(m.id) && !seen.has(m.id) && seen.add(m.id));
      } else {
        p = c.persons.find(x => x.id === r[0]);
        meds = this.lowMeds(c).filter(m => m.person === r[0]);
      }
      if (!p || !meds.length) return ans('Nessun farmaco selezionato');
      const target = isMirror ? realId : chatId;
      acl.wakes = (acl.wakes || []).filter(w => !(w.chat === target && w.by === uid && w.kind !== 'lab'));   // una sola richiesta in attesa per persona
      acl.wakes.push({ chat: target, by: uid, who, at: no.ts, until: no.until, to: (p.info || {}).to || '', names: meds.map(m => `${m.name}${m.dose ? ' ' + m.dose : ''}`), url: this.waUrl(p, this.waRequest(p, meds, who)), mirror: isMirror });
      await this.saveAcl(acl);
      if (k === 'RW' && c.reqDraft && c.reqDraft[p.id]) { delete c.reqDraft[p.id]; await this.saveChat(dataId, c); }   // la richiesta è pronta per l'apertura: si riparte da zero
      if (k === 'RW' && isMirror) await this.del(chatId, mid);
      return tg(this.env, 'answerCallbackQuery', { callback_query_id: q.id, text: `⏰ Ok! Ti avviso ${no.label}, quando lo studio apre.`, show_alert: true });
    }
    if (k === 'RN') {
      const p = c.persons.find(x => x.id === r[0]);
      if (!p) return ans();
      c.flows[uid] = { step: 'pinfo_tel', d: { pid: p.id, who } }; await this.saveChat(dataId, c);
      await this.askTel(chatId, null, (p.info || {}).to);
      return ans();
    }
    if (k === 'RA') {
      const fl2 = c.flows[uid];
      if (!fl2 || !fl2.req) return ans('Ricomincia dalla richiesta ricette');
      fl2.step = 'occ_name'; fl2.d = { view: isMirror ? realId : chatId };
      const q = await this.ask(isMirror ? realId : chatId, 'Quale farmaco? Scrivi nome e dosaggio, ad esempio <code>Monuril 3 g</code>.', null, 'Es. Monuril 3 g');
      if (q.ok) fl2.d.q = q.result.message_id;
      await this.saveChat(dataId, c);
      return ans();
    }
    if (k === 'RS') {
      const fl2 = c.flows[uid];
      if (!fl2 || !fl2.req || !fl2.d || !fl2.d.name) return ans();
      const id = (r[0] === 'y' ? 'o' : 'x') + rid();
      if (r[0] === 'y') { c.occ = c.occ || []; c.occ.push({ id, person: fl2.req.pid, name: fl2.d.name, dose: '' }); }
      else { fl2.req.extra = fl2.req.extra || []; fl2.req.extra.push({ id, name: fl2.d.name, dose: '' }); }
      fl2.req.sel.push(id); this.saveDraft(c, fl2.req);
      await this.del(chatId, mid);
      fl2.step = 'req'; fl2.d = {};
      await this.saveChat(dataId, c);
      if (fl2.req.mid) { const v = this.reqView(c, uid, who, isMirror); await this.edit(isMirror ? realId : chatId, fl2.req.mid, v.text, v.kb); }
      return ans(r[0] === 'y' ? 'Salvato tra i farmaci al bisogno' : 'Aggiunto a questa richiesta');
    }
    if (k === 'RT') {
      const fl2 = c.flows[uid];
      if (!fl2 || !fl2.req) return ans('Ricomincia da /scorte');
      const id = r[0]; const sel = fl2.req.sel;
      fl2.req.sel = sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]; this.saveDraft(c, fl2.req);
      await this.saveChat(dataId, c);
      const v = this.reqView(c, uid, who, isMirror); await this.edit(chatId, mid, v.text, v.kb);
      return ans();
    }
    if (k === 'RZ') {   // ↺ Ricomincia: via la bozza, si riparte dai farmaci in esaurimento
      const fl2 = c.flows[uid]; if (!fl2 || !fl2.req) return ans();
      if (c.reqDraft) delete c.reqDraft[fl2.req.pid];
      this.startReq(c, uid, fl2.req.pid); c.flows[uid].req.mid = fl2.req.mid;
      await this.saveChat(dataId, c);
      const v = this.reqView(c, uid, who, isMirror); await this.edit(chatId, mid, v.text, v.kb); return ans('Ricominciata');
    }
    if (k === 'RX') { delete c.flows[uid]; await this.saveChat(dataId, c); if (isMirror) await this.del(chatId, mid); else await this.edit(chatId, mid, 'Richiesta chiusa.'); return ans(); }
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
    if (k === 'OL' || k === 'OX') {
      if (k === 'OX') c.occ = (c.occ || []).filter(o => o.id !== r[0]), await this.saveChat(dataId, c);
      const occ = c.occ || [];
      await this.edit(chatId, mid, occ.length ? '💊 <b>Farmaci al bisogno</b>\nCompaiono in /terapia e nella richiesta ricette, senza promemoria. Tocca un farmaco per cambiare forma, tipo di ricetta o toglierlo.' : 'Nessun farmaco al bisogno.',
        { inline_keyboard: [...occ.map(o => [{ text: `💊 ${o.name}${o.dose ? ' ' + o.dose : ''} · ${unitOf(o)[1]}`.slice(0, 60), callback_data: 'OE|' + o.id }]), [{ text: '⬅️ Elenco', callback_data: 'ML' }]] });
      return ans(k === 'OX' ? 'Tolto' : '');
    }
    if (['OE', 'OU', 'OUS', 'ORX'].includes(k)) {   // scheda di un farmaco al bisogno
      const o = (c.occ || []).find(x => x.id === r[0]); if (!o) return ans('Farmaco non trovato');
      if (k === 'OU') {
        const b = Object.entries(UNITS).map(([u, [, pl]]) => ({ text: `${(o.unit || 'cp') === u ? '✅ ' : ''}${pl}`, callback_data: `OUS|${o.id}|${u}` }));
        const rows = []; for (let i = 0; i < b.length; i += 3) rows.push(b.slice(i, i + 3));
        rows.push([{ text: '⬅️ Indietro', callback_data: 'OE|' + o.id }]);
        await this.edit(chatId, mid, `🔢 In che forma è <b>${esc(o.name)}</b>?`, { inline_keyboard: rows }); return ans();
      }
      if (k === 'OUS') { if (r[1] === 'cp') delete o.unit; else if (UNITS[r[1]]) o.unit = r[1]; await this.saveChat(dataId, c); }
      if (k === 'ORX') { const nx = { ssn: 'bianca', bianca: 'banco', banco: 'ssn' }[rxOf(o)]; if (nx === 'ssn') delete o.rx; else o.rx = nx; await this.saveChat(dataId, c); }
      await this.edit(chatId, mid, `💊 <b>${esc(o.name)}</b>${o.dose ? ' ' + esc(o.dose) : ''} · al bisogno\n🔢 ${unitOf(o)[1]}\n${RX_LABEL[rxOf(o)]}`, { inline_keyboard: [
        [{ text: `🔢 Forma: ${unitOf(o)[1]}`, callback_data: 'OU|' + o.id }, { text: RX_LABEL[rxOf(o)] + ' ↻', callback_data: 'ORX|' + o.id }],
        [{ text: '🗑 Togli', callback_data: 'OX|' + o.id }, { text: '⬅️ Al bisogno', callback_data: 'OL' }]] });
      return ans(k === 'OUS' ? 'Forma: ' + unitOf(o)[1] : k === 'ORX' ? RX_LABEL[rxOf(o)] : '');
    }
    if (k === 'MC') { const v = this.doneView(c); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
    if (k === 'ML') { const v = this.medsView(c); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
    const m = c.meds.find(x => x.id === r[0]);
    if (['MM', 'MP', 'MS', 'MD', 'MDY', 'ME', 'MW', 'MWP', 'MWN', 'MT', 'MTC', 'MTE', 'MTX', 'MTS', 'MA', 'MAY', 'MR', 'SK', 'SA', 'SU', 'PK', 'MRX', 'MU', 'MUS'].includes(k) && !m) { const v = this.medsView(c); await this.edit(chatId, mid, v.text, v.kb); return ans('Farmaco non trovato'); }
    if (k === 'MM') { const v = this.medDetail(c, m); await this.edit(chatId, mid, v.text, v.kb); return ans(); }
    if (k === 'MU') {   // scelta dell'unità di conteggio
      const kb = Object.entries(UNITS).map(([u, [, pl]]) => ({ text: `${(m.unit || 'cp') === u ? '✅ ' : ''}${pl}`, callback_data: `MUS|${m.id}|${u}` }));
      const rows = []; for (let i = 0; i < kb.length; i += 3) rows.push(kb.slice(i, i + 3));
      rows.push([{ text: '⬅️ Scorte', callback_data: 'SK|' + m.id }]);
      await this.edit(chatId, mid, `🔢 Come conti le scorte di <b>${esc(m.name)}</b>?\nPer i colliri, ad esempio, <b>applicazioni</b>; per gli inalatori <b>erogazioni</b>.`, { inline_keyboard: rows });
      return ans();
    }
    if (k === 'MUS') {
      if (r[1] === 'cp') delete m.unit; else if (UNITS[r[1]]) m.unit = r[1];
      for (const x of c.meds) if (x !== m && x.name.toLowerCase() === m.name.toLowerCase()) { if (m.unit) x.unit = m.unit; else delete x.unit; }
      await this.saveChat(dataId, c); await this.refreshPanels(acl, dataId, c);
      const v = this.stockCard(c, m); await this.edit(chatId, mid, v.text, v.kb); return ans('Unità: ' + unitOf(m)[1]);
    }
    if (k === 'MRX') {   // tipo di ricetta: SSN → bianca → da banco (vale per tutte le righe con lo stesso nome)
      const nx = { ssn: 'bianca', bianca: 'banco', banco: 'ssn' }[rxOf(m)];
      for (const x of c.meds) if (x.name.toLowerCase() === m.name.toLowerCase()) { if (nx === 'ssn') delete x.rx; else x.rx = nx; }
      await this.saveChat(dataId, c); await this.refreshPanels(acl, dataId, c);
      const v = this.medDetail(c, m); await this.edit(chatId, mid, v.text, v.kb); return ans(RX_LABEL[nx]);
    }
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
        await this.send(dataId, `☑️ <b>${esc(m.name)}</b> ritirato${who ? ' da ' + esc(who) : ''}: +${un(m, q)} (ora ${m.stock}).`, { inline_keyboard: [[{ text: `↩️ Annulla (−${q})`, callback_data: `SU|${m.id}|${q}` }]] });
        return ans(`+${un(m, q)}`);
      }
      const v = this.stockCard(c, m, k === 'SA' ? `✅ Aggiunte ${un(m, q)}${who ? ' · ' + esc(who) : ''}.` : `↩️ Tolte ${un(m, q)}.`);
      if (k === 'SA') v.kb.inline_keyboard.unshift([{ text: `↩️ Annulla (−${q})`, callback_data: `SU|${m.id}|${q}` }]);
      await this.edit(chatId, mid, v.text, v.kb);
      return ans(k === 'SA' ? `+${un(m, q)}` : 'Annullato');
    }
    if (k === 'PK') {
      c.flows[uid] = { step: 'pack', d: { med: m.id } }; await this.saveChat(dataId, c);
      await this.ask(chatId, `Quante ${unitOf(m)[1]} ci sono in una confezione di <b>${esc(m.name)}</b>?${m.pack ? ` (ora: ${m.pack})` : ''}`, null, 'Es. 30');
      return ans();
    }
    if (k === 'MS') {
      c.flows[uid] = { step: 'restock', d: { med: m.id } }; await this.saveChat(dataId, c);
      await this.ask(chatId, `Giacenza di <b>${esc(m.name)}</b>: quante ${unitOf(m)[1]} avete adesso?${m.stock != null ? ` (ora: ${m.stock})` : ''}\nScrivi <b>-</b> per non contarle.`, null, 'Es. 30');
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
