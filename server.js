/* eslint-disable no-console */
/**
 * server.js
 * Serveur de signaling Socket.IO pour WebRTC (visio mesh)
 * - Rooms via roomId
 * - Pas de login
 * - Limite de 10 participants "actifs" par room (cam/micro ON)
 * - Relai des messages offer/answer/ice
 *
 * Lancement:
 *   npm start
 *   -> Client React : http://localhost:3000
 *   -> Signaling    : http://localhost:5000
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 5000);
const MAX_ACTIVE_PER_ROOM = 10;

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: true,
    methods: ["GET", "POST"]
  }
});

// roomId -> Map(socketId -> { userId: string, active: boolean })
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function countActive(room) {
  let count = 0;
  for (const info of room.values()) {
    if (info && info.active) count += 1;
  }
  return count;
}

function listActivePeers(room, exceptSocketId) {
  const peers = [];
  for (const [socketId, info] of room.entries()) {
    if (!info) continue;
    if (socketId === exceptSocketId) continue;
    if (info.active) {
      peers.push({ socketId, userId: info.userId });
    }
  }
  return peers;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    port: PORT,
    rooms: rooms.size
  });
});

/**
 * (Optionnel) Servir le build React en prod si le dossier build existe.
 * - En dev, tu utilises react-scripts (port 3000).
 * - En prod, tu peux faire: npm run build puis node server.js et ouvrir http://localhost:5000
 */
const buildDir = path.join(__dirname, "build");
if (fs.existsSync(buildDir)) {
  app.use(express.static(buildDir));
  app.get("*", (req, res) => {
    res.sendFile(path.join(buildDir, "index.html"));
  });
}

io.on("connection", (socket) => {
  // On stocke quelques infos dans socket.data
  socket.data.roomId = null;
  socket.data.userId = null;

  socket.on("join-room", ({ roomId, userId }) => {
    if (!roomId || typeof roomId !== "string") return;
    if (!userId || typeof userId !== "string") return;

    socket.data.roomId = roomId;
    socket.data.userId = userId;

    const room = getRoom(roomId);

    room.set(socket.id, {
      userId,
      active: false
    });

    socket.join(roomId);

    // Envoie au nouvel arrivant la liste des participants "actifs" déjà présents
    socket.emit("room-users", {
      activePeers: listActivePeers(room, socket.id),
      maxActive: MAX_ACTIVE_PER_ROOM
    });
  });

  socket.on("user-active", () => {
    const roomId = socket.data.roomId;
    const userId = socket.data.userId;
    if (!roomId || !userId) return;

    const room = getRoom(roomId);
    const entry = room.get(socket.id);
    if (!entry) return;

    // Déjà actif ? On ne refait rien.
    if (entry.active) {
      socket.emit("user-active-ok", { ok: true });
      return;
    }

    const activeCount = countActive(room);
    if (activeCount >= MAX_ACTIVE_PER_ROOM) {
      socket.emit("room-full", { maxActive: MAX_ACTIVE_PER_ROOM });
      return;
    }

    entry.active = true;
    room.set(socket.id, entry);

    socket.emit("user-active-ok", { ok: true });

    // Prévenir les autres que ce socket devient actif
    socket.to(roomId).emit("peer-active", {
      socketId: socket.id,
      userId: userId
    });
  });

  socket.on("user-inactive", () => {
    const roomId = socket.data.roomId;
    const userId = socket.data.userId;
    if (!roomId || !userId) return;

    const room = getRoom(roomId);
    const entry = room.get(socket.id);
    if (!entry) return;

    if (!entry.active) {
      socket.emit("user-inactive-ok", { ok: true });
      return;
    }

    entry.active = false;
    room.set(socket.id, entry);

    socket.emit("user-inactive-ok", { ok: true });

    // Prévenir les autres que ce socket n'est plus actif
    socket.to(roomId).emit("peer-inactive", {
      socketId: socket.id
    });
  });

  /**
   * Relai signaling WebRTC
   * - webrtc-offer {to, sdp}
   * - webrtc-answer {to, sdp}
   * - webrtc-ice-candidate {to, candidate}
   */
  socket.on("webrtc-offer", ({ to, sdp }) => {
    if (!to || !sdp) return;
    io.to(to).emit("webrtc-offer", {
      from: socket.id,
      userId: socket.data.userId,
      sdp
    });
  });

  socket.on("webrtc-answer", ({ to, sdp }) => {
    if (!to || !sdp) return;
    io.to(to).emit("webrtc-answer", {
      from: socket.id,
      sdp
    });
  });

  socket.on("webrtc-ice-candidate", ({ to, candidate }) => {
    if (!to || !candidate) return;
    io.to(to).emit("webrtc-ice-candidate", {
      from: socket.id,
      candidate
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const hadEntry = room.has(socket.id);
    room.delete(socket.id);

    // Prévenir les autres qu'il est parti
    if (hadEntry) {
      socket.to(roomId).emit("peer-left", { socketId: socket.id });
    }

    // Si room vide, on nettoie
    if (room.size === 0) {
      rooms.delete(roomId);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[server] Signaling en écoute sur http://localhost:${PORT}`);
});
