/* Пример WebSocket-сервера для мультиплеера BATTLE CITY.
   Запуск:  npm i ws  &&  node server.js
   Затем в index.html укажите: CFG.MP_SERVER = "ws://localhost:8080"        */
const { WebSocketServer } = require("ws");
const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const rooms = new Map();   // code -> { mode, clients:Set }

const send = (ws, o) => { try { ws.send(JSON.stringify(o)); } catch (e) { } };
const broadcast = (code, o, except) => {
  const r = rooms.get(code); if (!r) return;
  for (const c of r.clients) if (c !== except) send(c, o);
};

wss.on("connection", ws => {
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === "create") {
      rooms.set(m.room, { mode: m.mode, clients: new Set([ws]) });
      ws.room = m.room; ws.name = m.name;
      send(ws, { t: "room", code: m.room });
    } else if (m.t === "join") {
      const r = rooms.get(m.room);
      if (!r) return send(ws, { t: "error", msg: "Комната не найдена" });
      r.clients.add(ws); ws.room = m.room; ws.name = m.name;
      broadcast(m.room, { t: "peer", peers: [...r.clients].map(c => c.name) });
      broadcast(m.room, { t: "start", mode: r.mode });
    } else if (m.t === "rooms") {
      send(ws, { t: "rooms", rooms: [...rooms].map(([code, r]) => ({ code, mode: r.mode, players: r.clients.size })) });
    } else if (m.t === "chat") {
      broadcast(m.room, { t: "chat", from: ws.name, msg: String(m.msg).slice(0, 200) });
    } else if (m.t === "state") {
      broadcast(m.room, m, ws);   // ретрансляция состояния игры остальным
    }
  });
  ws.on("close", () => {
    const r = rooms.get(ws.room); if (!r) return;
    r.clients.delete(ws);
    if (!r.clients.size) rooms.delete(ws.room);
    else broadcast(ws.room, { t: "peer", peers: [...r.clients].map(c => c.name) });
  });
});
console.log("BATTLE CITY multiplayer server: ws://localhost:" + (process.env.PORT || 8080));
