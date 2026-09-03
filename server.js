/* ============================================================================
   BATTLE CITY — сервер комнат + локальная база данных игроков.

   Ничего дополнительно поднимать не нужно: это тот же процесс, что обслуживает
   мультиплеер. База — обычный JSON-файл рядом со скриптом (db.json), внешних
   сервисов и СУБД не требуется.

   Запуск:  npm i ws  &&  node server.js
   В index.html: CFG.MP_SERVER = "ws://АДРЕС:8080"  (в проде — wss://)

   Что хранит база:
     players[id] = { name, token, rev, coins, maxLevel, owned, equipped,
                     upgrades, premium, stats, achievements, records, created, updated }
     scores[]    = { id, name, score, level, ts }
   ============================================================================ */
const fs = require("fs");
const path = require("path");

/* ------------------------------ БАЗА ДАННЫХ ------------------------------ */
const DB = {
  file: process.env.DB_FILE || path.join(__dirname, "db.json"),
  data: { v: 1, players: {}, scores: [] },
  dirty: false, timer: null,

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.data = Object.assign({ v: 1, players: {}, scores: [] }, raw);
        console.log(`[db] загружено: игроков ${Object.keys(this.data.players).length}, рекордов ${this.data.scores.length}`);
      } else {
        // Создаём файл сразу, чтобы база была видна на диске ещё до первого игрока
        this.dirty = true; this.saveNow();
        console.log("[db] создана новая база:", this.file);
      }
    } catch (e) { console.error("[db] не удалось прочитать базу, начинаем с пустой:", e.message); }
  },
  // Запись отложенная и атомарная: сначала во временный файл, потом переименование,
  // чтобы аварийная остановка не оставила обрезанный db.json
  saveSoon() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.saveNow(); }, 2000);
  },
  saveNow() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error("[db] ошибка записи:", e.message); }
  },

  /* --- Санитайзеры: клиенту доверять нельзя --- */
  str(v, max) { return typeof v === "string" ? v.slice(0, max || 32) : ""; },
  num(v, max) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : 0; },
  arr(v, max, len) {
    if (!Array.isArray(v)) return [];
    return v.slice(0, max).filter(x => typeof x === "string").map(x => x.slice(0, len || 24));
  },
  cleanProfile(p) {
    p = p || {};
    const s = p.stats || {}, o = p.owned || {}, e = p.equipped || {}, u = p.upgrades || {};
    const numMap = (src, max) => {
      const out = {};
      for (const k of Object.keys(src || {}).slice(0, 60)) {
        const key = this.str(k, 24);
        if (typeof src[k] === "number") out[key] = this.num(src[k], max);
      }
      return out;
    };
    return {
      name: this.str(p.name, 12).toUpperCase() || "PLAYER",
      avatar: this.num(p.avatar, 7),
      coins: this.num(p.coins, 1e9),
      maxLevel: this.num(p.maxLevel, 35),
      owned: {
        color: this.arr(o.color, 20), skin: this.arr(o.skin, 20), shot: this.arr(o.shot, 20),
        upgrade: this.arr(o.upgrade, 20), effect: this.arr(o.effect, 20)
      },
      equipped: {
        color: this.str(e.color, 16), skin: this.str(e.skin, 16), shot: this.str(e.shot, 16),
        flag: this.str(e.flag, 8), custom: Array.isArray(e.custom) ? this.arr(e.custom, 8, 8) : null
      },
      upgrades: { speed: this.num(u.speed, 2), armor: this.num(u.armor, 2), range: this.num(u.range, 2), reload: this.num(u.reload, 2) },
      premium: { tier: this.str((p.premium || {}).tier, 12) || "none", until: this.num((p.premium || {}).until, 4e12) },
      stats: numMap(s, 1e10),
      achievements: numMap(p.achievements, 4e12),
      records: (Array.isArray(p.records) ? p.records : []).slice(0, 10).map(r => ({
        name: this.str(r && r.name, 12), score: this.num(r && r.score, 1e9),
        level: this.num(r && r.level, 99), ts: this.num(r && r.ts, 4e12)
      })),
      daily: { last: this.str((p.daily || {}).last, 10), streak: this.num((p.daily || {}).streak, 3650) }
    };
  },

  /* --- Вход: заводим игрока или отдаём сохранённый профиль --- */
  auth(id, token, name) {
    id = this.str(id, 40); token = this.str(token, 64);
    if (!id || !token) return { error: "Некорректный идентификатор" };
    let p = this.data.players[id];
    if (!p) {
      p = this.data.players[id] = Object.assign(this.cleanProfile({ name }), {
        token, rev: 0, created: Date.now(), updated: Date.now()
      });
      this.saveSoon();
      console.log(`[db] новый игрок ${p.name} (${id})`);
      return { profile: this.publicProfile(p), rev: 0, isNew: true };
    }
    if (p.token !== token) return { error: "Профиль занят другим устройством" };
    return { profile: this.publicProfile(p), rev: p.rev | 0, isNew: false };
  },
  publicProfile(p) { const c = this.cleanProfile(p); c.rev = p.rev | 0; return c; },

  /* --- Сохранение профиля. Номер ревизии растёт только вперёд:
         так два устройства одного игрока не затирают друг друга задним числом. --- */
  push(id, token, rev, profile) {
    id = this.str(id, 40); token = this.str(token, 64);
    const p = this.data.players[id];
    if (!p) return { error: "Игрок не найден, войдите заново" };
    if (p.token !== token) return { error: "Неверный токен" };
    rev = this.num(rev, 1e9);
    if (rev <= (p.rev | 0)) return { rev: p.rev | 0, stale: true };   // пришло устаревшее — игнорируем
    const clean = this.cleanProfile(profile);
    Object.assign(p, clean, { rev, updated: Date.now() });
    this.saveSoon();
    return { rev };
  },

  addScore(id, name, score, level) {
    score = this.num(score, 1e9);
    if (!score) return;
    this.data.scores.push({ id: this.str(id, 40), name: this.str(name, 12) || "PLAYER", score, level: this.num(level, 99), ts: Date.now() });
    if (this.data.scores.length > 5000) this.data.scores.splice(0, this.data.scores.length - 5000);
    this.saveSoon();
  },
  top(period) {
    const lim = period === "day" ? 864e5 : period === "week" ? 6048e5 : Infinity;
    const t = Date.now();
    return this.data.scores.filter(r => (t - r.ts) <= lim)
      .sort((a, b) => b.score - a.score).slice(0, 20)
      .map(r => ({ name: r.name, score: r.score, level: r.level, ts: r.ts }));
  },
  // Таблица игроков — «статистика разных людей»
  players() {
    return Object.entries(this.data.players).map(([id, p]) => {
      const s = p.stats || {};
      return {
        name: p.name, coins: p.coins | 0, maxLevel: p.maxLevel | 0,
        kills: s.kills | 0, levels: s.levels | 0, games: s.games | 0,
        best: s.bestScore | 0, time: s.playTime | 0,
        ach: Object.keys(p.achievements || {}).length,
        items: ["color", "skin", "shot", "upgrade", "effect"]
          .reduce((n, k) => n + ((p.owned && p.owned[k]) || []).length, 0),
        updated: p.updated | 0
      };
    }).sort((a, b) => b.best - a.best).slice(0, 100);
  },
  global() {
    const all = Object.values(this.data.players);
    const sum = f => all.reduce((n, p) => n + ((p.stats || {})[f] | 0), 0);
    return {
      players: all.length, games: sum("games"), kills: sum("kills"), blocks: sum("blocks"),
      levels: sum("levels"), time: sum("playTime"), coins: all.reduce((n, p) => n + (p.coins | 0), 0),
      scores: this.data.scores.length
    };
  }
};
DB.load();
process.on("SIGINT", () => { DB.saveNow(); process.exit(0); });
process.on("SIGTERM", () => { DB.saveNow(); process.exit(0); });

/* ---------------------- КОМНАТЫ МУЛЬТИПЛЕЕРА ---------------------- */
const rooms = new Map();
const MAX_PLAYERS = 2;
// rematch — просьба гостя перезапустить партию; решение принимает хост
const RELAY = new Set(["begin", "in", "snap", "chat", "ping", "pong", "state", "rematch"]);
const DB_MSG = new Set(["auth", "push", "score", "top", "players", "global"]);

const send = (ws, o) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) { } };
function broadcast(code, o, except) {
  const r = rooms.get(code); if (!r) return;
  for (const c of r.clients) if (c !== except) send(c, o);
}
const playerList = r => r.clients.map((c, i) => ({ name: c.pname || "PLAYER", index: i }));
const announce = code => { const r = rooms.get(code); if (r) broadcast(code, { t: "peer", players: playerList(r) }); };

function handleMessage(ws, m) {
  /* --- Запросы к базе данных --- */
  if (DB_MSG.has(m.t)) {
    if (m.t === "auth") {
      const r = DB.auth(m.id, m.token, m.name);
      if (r.error) return send(ws, { t: "err", msg: r.error });
      ws.pid = DB.str(m.id, 40);
      return send(ws, { t: "profile", profile: r.profile, rev: r.rev, isNew: r.isNew });
    }
    if (m.t === "push") {
      const r = DB.push(m.id, m.token, m.rev, m.profile);
      if (r.error) return send(ws, { t: "err", msg: r.error });
      return send(ws, { t: "pushed", rev: r.rev, stale: !!r.stale });
    }
    if (m.t === "score") { DB.addScore(m.id, m.name, m.score, m.level); return send(ws, { t: "scored" }); }
    if (m.t === "top") return send(ws, { t: "top", period: m.period || "all", list: DB.top(m.period) });
    if (m.t === "players") return send(ws, { t: "players", list: DB.players() });
    if (m.t === "global") return send(ws, { t: "global", data: DB.global() });
  }

  /* --- Комнаты --- */
  if (m.t === "create") {
    const code = String(m.room || "").trim();
    if (!code) return send(ws, { t: "err", msg: "Не указан код комнаты" });
    if (rooms.has(code)) return send(ws, { t: "err", msg: "Комната уже занята" });
    rooms.set(code, { mode: m.mode || "coop", clients: [ws] });
    ws.room = code; ws.pname = DB.str(m.name, 12) || "PLAYER";
    send(ws, { t: "welcome", room: code, index: 0, mode: m.mode || "coop", players: playerList(rooms.get(code)) });
    console.log(`[+] комната ${code} (${m.mode}) создана игроком ${ws.pname}`);
    return;
  }
  if (m.t === "join") {
    const code = String(m.room || "").trim();
    const r = rooms.get(code);
    if (!r) return send(ws, { t: "err", msg: "Комната " + code + " не найдена" });
    if (r.clients.length >= MAX_PLAYERS) return send(ws, { t: "err", msg: "Комната заполнена" });
    r.clients.push(ws);
    ws.room = code; ws.pname = DB.str(m.name, 12) || "PLAYER";
    send(ws, { t: "welcome", room: code, index: r.clients.indexOf(ws), mode: r.mode, players: playerList(r) });
    announce(code);
    console.log(`[>] ${ws.pname} вошёл в комнату ${code} (${r.clients.length}/${MAX_PLAYERS})`);
    return;
  }
  if (m.t === "rooms") {
    return send(ws, {
      t: "rooms",
      rooms: [...rooms].filter(([, r]) => r.clients.length < MAX_PLAYERS)
        .map(([code, r]) => ({ code, mode: r.mode, players: r.clients.length }))
    });
  }
  if (m.t === "bye") { ws.close(); return; }
  if (RELAY.has(m.t) && ws.room) broadcast(ws.room, m, ws);
}

/* ------------------------------- ЗАПУСК ------------------------------- */
function startServer(port) {
  const { WebSocketServer } = require("ws");
  const wss = new WebSocketServer({ port });
  wss.on("connection", ws => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", raw => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      try { handleMessage(ws, m); } catch (e) { console.error("[!]", e.message); }
    });
    ws.on("close", () => {
      const r = rooms.get(ws.room); if (!r) return;
      const code = ws.room;
      r.clients = r.clients.filter(c => c !== ws);
      if (!r.clients.length) { rooms.delete(code); console.log(`[-] комната ${code} закрыта`); }
      else { broadcast(code, { t: "left", name: ws.pname }); announce(code); }
    });
  });
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; try { ws.ping(); } catch (e) { }
    }
  }, 30000);
  return wss;
}

if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  startServer(PORT);
  console.log(`BATTLE CITY server: ws://localhost:${PORT}`);
  console.log(`База данных: ${DB.file} (внешние сервисы не нужны)`);
} else {
  module.exports = { DB, handleMessage, startServer };   // для тестов
}
