import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

/**
 * MVP Visio (sans login)
 * - Room via ?room=xxxx
 * - Bouton "+" : active caméra/micro et rejoint la visio
 * - Mesh WebRTC (chaque pair se connecte aux autres)
 * - Signaling via Socket.IO
 */

const MAX_TILES = 10;

function safeRandomId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch (e) {
    // ignore
  }
  const now = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2);
  return `id_${now}_${rnd}`;
}

function generateRoomId(len = 8) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function getOrCreateUserId() {
  const key = "visio1_user_id";
  try {
    const existing = localStorage.getItem(key);
    if (existing && existing.length > 6) return existing;
    const fresh = safeRandomId();
    localStorage.setItem(key, fresh);
    return fresh;
  } catch (e) {
    return safeRandomId();
  }
}

function getOrCreateRoomIdInUrl() {
  const url = new URL(window.location.href);
  let room = url.searchParams.get("room");
  if (!room) {
    room = generateRoomId(8);
    url.searchParams.set("room", room);
    window.history.replaceState({}, "", url.toString());
  }
  return room;
}

function buildShareLink(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}

function getSignalingUrl() {
  // Option: définir REACT_APP_SIGNALING_URL dans un .env (build-time)
  const envUrl = process.env.REACT_APP_SIGNALING_URL;

  if (envUrl && typeof envUrl === "string" && envUrl.trim().length > 0) {
    return envUrl.trim();
  }

  // En local (dev) : serveur signaling sur 5000
  const { hostname } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "http://localhost:5000";
  }

  // En prod (Cloud Run / 1 seule URL) : même origine (https://...run.app)
  return window.location.origin;
}

function formatShort(id) {
  if (!id) return "";
  const s = String(id);
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function VideoTile({ label, subLabel, stream, muted, isPlaceholder }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = stream || null;
  }, [stream]);

  return (
    <div className={`tile ${isPlaceholder ? "tilePlaceholder" : ""}`}>
      <div className="tileInner">
        <video
          ref={videoRef}
          className="tileVideo"
          autoPlay
          playsInline
          muted={muted}
        />
        <div className="tileOverlay">
          <div className="tileLabel">{label}</div>
          {subLabel ? <div className="tileSubLabel">{subLabel}</div> : null}
        </div>
        {isPlaceholder ? (
          <div className="tileHint">
            Clique sur <span className="kbd">+</span> pour apparaître
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function App() {
  const isTestEnv = process.env.NODE_ENV === "test";

  const [roomId] = useState(() =>
    isTestEnv ? "testroom" : getOrCreateRoomIdInUrl()
  );
  const [userId] = useState(() => getOrCreateUserId());

  const [signalingConnected, setSignalingConnected] = useState(false);

  const [isActive, setIsActive] = useState(false);
  const isActiveRef = useRef(isActive);

  const [localStream, setLocalStream] = useState(null);
  const localStreamRef = useRef(null);

  const [remoteTiles, setRemoteTiles] = useState([]);
  const remoteTilesRef = useRef([]);

  const [statusMsg, setStatusMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const [maxActive, setMaxActive] = useState(MAX_TILES);

  const socketRef = useRef(null);
  const activePeersRef = useRef(new Map());
  const peersRef = useRef(new Map());
  const pendingIceRef = useRef(new Map());
  const remoteStreamsRef = useRef(new Map());

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  useEffect(() => {
    remoteTilesRef.current = remoteTiles;
  }, [remoteTiles]);

  const shareLink = useMemo(() => buildShareLink(roomId), [roomId]);
  const signalingUrl = useMemo(() => (isTestEnv ? "" : getSignalingUrl()), [isTestEnv]);

  const rtcConfig = useMemo(() => {
    return {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
      ]
    };
  }, []);

  const setTransientStatus = useCallback((msg) => {
    setStatusMsg(msg);
    if (!msg) return;
    window.setTimeout(() => {
      setStatusMsg((current) => (current === msg ? "" : current));
    }, 2500);
  }, []);

  const upsertRemoteTile = useCallback((socketId, peerUserId, stream) => {
    setRemoteTiles((prev) => {
      const exists = prev.some((t) => t.socketId === socketId);
      const next = exists
        ? prev.map((t) => (t.socketId === socketId ? { ...t, stream, userId: peerUserId } : t))
        : [...prev, { socketId, userId: peerUserId, stream }];
      return next.slice(0, maxActive);
    });
  }, [maxActive]);

  const removePeerEverywhere = useCallback((socketId) => {
    const entry = peersRef.current.get(socketId);
    if (entry && entry.pc) {
      try {
        entry.pc.onicecandidate = null;
        entry.pc.ontrack = null;
        entry.pc.onconnectionstatechange = null;
        entry.pc.close();
      } catch (e) { }
    }
    peersRef.current.delete(socketId);
    remoteStreamsRef.current.delete(socketId);
    pendingIceRef.current.delete(socketId);
    activePeersRef.current.delete(socketId);

    setRemoteTiles((prev) => prev.filter((t) => t.socketId !== socketId));
  }, []);

  const flushPendingIce = useCallback(async (fromSocketId, pc) => {
    const queued = pendingIceRef.current.get(fromSocketId);
    if (!queued || queued.length === 0) return;
    pendingIceRef.current.delete(fromSocketId);

    for (const cand of queued) {
      try {
        await pc.addIceCandidate(cand);
      } catch (e) { }
    }
  }, []);

  const getMySocketId = useCallback(() => {
    const s = socketRef.current;
    return s && s.id ? s.id : null;
  }, []);

  const shouldInitiateWith = useCallback((otherSocketId) => {
    const myId = getMySocketId();
    if (!myId) return true;
    return String(myId) < String(otherSocketId);
  }, [getMySocketId]);

  const ensurePeerConnection = useCallback(async (peerSocketId, peerUserId) => {
    if (!peerSocketId) return null;

    const existing = peersRef.current.get(peerSocketId);
    if (existing && existing.pc) return existing.pc;

    const stream = localStreamRef.current;
    if (!isActiveRef.current || !stream) return null;

    const pc = new RTCPeerConnection(rtcConfig);

    try {
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }
    } catch (e) { }

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const sock = socketRef.current;
      if (!sock) return;

      sock.emit("webrtc-ice-candidate", {
        to: peerSocketId,
        candidate: event.candidate
      });
    };

    pc.ontrack = (event) => {
      const streams = event.streams || [];
      const first = streams[0];

      if (first) {
        remoteStreamsRef.current.set(peerSocketId, first);
        upsertRemoteTile(peerSocketId, peerUserId, first);
      } else {
        const ms = remoteStreamsRef.current.get(peerSocketId) || new MediaStream();
        ms.addTrack(event.track);
        remoteStreamsRef.current.set(peerSocketId, ms);
        upsertRemoteTile(peerSocketId, peerUserId, ms);
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "disconnected" || st === "closed") {
        window.setTimeout(() => {
          removePeerEverywhere(peerSocketId);
        }, 700);
      }
    };

    peersRef.current.set(peerSocketId, { pc, userId: peerUserId });

    if (shouldInitiateWith(peerSocketId)) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const sock = socketRef.current;
        if (sock) {
          sock.emit("webrtc-offer", {
            to: peerSocketId,
            sdp: pc.localDescription
          });
        }
      } catch (e) { }
    }

    return pc;
  }, [rtcConfig, removePeerEverywhere, shouldInitiateWith, upsertRemoteTile]);

  const connectToAllKnownActivePeers = useCallback(async () => {
    const known = activePeersRef.current;
    const entries = Array.from(known.entries());

    for (const [peerSocketId, peerUserId] of entries) {
      if (!peerSocketId) continue;
      await ensurePeerConnection(peerSocketId, peerUserId);
    }
  }, [ensurePeerConnection]);

  const handleOffer = useCallback(async ({ from, userId: fromUserId, sdp }) => {
    if (!from || !sdp) return;

    const stream = localStreamRef.current;
    if (!isActiveRef.current || !stream) return;

    let pc = null;
    const existing = peersRef.current.get(from);
    if (existing && existing.pc) {
      pc = existing.pc;
    } else {
      pc = new RTCPeerConnection(rtcConfig);

      try {
        for (const track of stream.getTracks()) {
          pc.addTrack(track, stream);
        }
      } catch (e) { }

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        const sock = socketRef.current;
        if (!sock) return;

        sock.emit("webrtc-ice-candidate", {
          to: from,
          candidate: event.candidate
        });
      };

      pc.ontrack = (event) => {
        const streams = event.streams || [];
        const first = streams[0];

        if (first) {
          remoteStreamsRef.current.set(from, first);
          upsertRemoteTile(from, fromUserId, first);
        } else {
          const ms = remoteStreamsRef.current.get(from) || new MediaStream();
          ms.addTrack(event.track);
          remoteStreamsRef.current.set(from, ms);
          upsertRemoteTile(from, fromUserId, ms);
        }
      };

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "failed" || st === "disconnected" || st === "closed") {
          window.setTimeout(() => {
            removePeerEverywhere(from);
          }, 700);
        }
      };

      peersRef.current.set(from, { pc, userId: fromUserId });
    }

    try {
      await pc.setRemoteDescription(sdp);
      await flushPendingIce(from, pc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      const sock = socketRef.current;
      if (sock) {
        sock.emit("webrtc-answer", {
          to: from,
          sdp: pc.localDescription
        });
      }
    } catch (e) { }
  }, [flushPendingIce, removePeerEverywhere, rtcConfig, upsertRemoteTile]);

  const handleAnswer = useCallback(async ({ from, sdp }) => {
    if (!from || !sdp) return;

    const entry = peersRef.current.get(from);
    if (!entry || !entry.pc) return;

    try {
      await entry.pc.setRemoteDescription(sdp);
      await flushPendingIce(from, entry.pc);
    } catch (e) { }
  }, [flushPendingIce]);

  const handleIce = useCallback(async ({ from, candidate }) => {
    if (!from || !candidate) return;

    const entry = peersRef.current.get(from);
    if (!entry || !entry.pc) {
      const arr = pendingIceRef.current.get(from) || [];
      arr.push(candidate);
      pendingIceRef.current.set(from, arr);
      return;
    }

    const pc = entry.pc;

    if (!pc.remoteDescription || !pc.remoteDescription.type) {
      const arr = pendingIceRef.current.get(from) || [];
      arr.push(candidate);
      pendingIceRef.current.set(from, arr);
      return;
    }

    try {
      await pc.addIceCandidate(candidate);
    } catch (e) { }
  }, []);

  useEffect(() => {
    if (isTestEnv) return undefined;

    const sock = io(signalingUrl, {
      transports: ["websocket", "polling"]
    });

    socketRef.current = sock;

    const onConnect = () => {
      setSignalingConnected(true);
      setTransientStatus("Signaling connecté ✅");
      sock.emit("join-room", { roomId, userId });
    };

    const onDisconnect = () => {
      setSignalingConnected(false);
      setTransientStatus("Signaling déconnecté ⚠️");
    };

    sock.on("connect", onConnect);
    sock.on("disconnect", onDisconnect);

    sock.on("room-users", ({ activePeers, maxActive: serverMax }) => {
      if (typeof serverMax === "number") {
        setMaxActive(serverMax);
      }

      const map = new Map();
      (activePeers || []).forEach((p) => {
        if (!p || !p.socketId) return;
        map.set(p.socketId, p.userId || "unknown");
      });
      activePeersRef.current = map;

      if (isActiveRef.current) {
        connectToAllKnownActivePeers();
      }
    });

    sock.on("peer-active", ({ socketId, userId: peerUserId }) => {
      if (!socketId) return;
      activePeersRef.current.set(socketId, peerUserId || "unknown");

      if (isActiveRef.current) {
        ensurePeerConnection(socketId, peerUserId || "unknown");
      }
    });

    sock.on("peer-inactive", ({ socketId }) => {
      if (!socketId) return;
      removePeerEverywhere(socketId);
    });

    sock.on("peer-left", ({ socketId }) => {
      if (!socketId) return;
      removePeerEverywhere(socketId);
    });

    sock.on("room-full", ({ maxActive: m }) => {
      const mm = typeof m === "number" ? m : MAX_TILES;
      setErrorMsg(`Salon complet : ${mm} participants actifs maximum.`);
      setTransientStatus("");
    });

    sock.on("webrtc-offer", handleOffer);
    sock.on("webrtc-answer", handleAnswer);
    sock.on("webrtc-ice-candidate", handleIce);

    return () => {
      try {
        sock.off("connect", onConnect);
        sock.off("disconnect", onDisconnect);
        sock.disconnect();
      } catch (e) { }

      socketRef.current = null;
      setSignalingConnected(false);
    };
  }, [
    connectToAllKnownActivePeers,
    ensurePeerConnection,
    handleAnswer,
    handleIce,
    handleOffer,
    isTestEnv,
    roomId,
    setTransientStatus,
    signalingUrl,
    userId,
    removePeerEverywhere
  ]);

  const startLocalMedia = useCallback(async () => {
    setErrorMsg("");

    if (!socketRef.current || !signalingConnected) {
      setErrorMsg("Signaling non connecté. Vérifie que le serveur tourne.");
      return;
    }

    if (isActiveRef.current) {
      setTransientStatus("Tu es déjà actif 🙂");
      return;
    }

    try {
      setTransientStatus("Activation caméra/micro…");

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true
      });

      setLocalStream(stream);
      localStreamRef.current = stream;

      setIsActive(true);
      isActiveRef.current = true;

      socketRef.current.emit("user-active");

      setTransientStatus("Tu es dans la visio ✅");

      await connectToAllKnownActivePeers();
    } catch (e) {
      setIsActive(false);
      isActiveRef.current = false;
      setLocalStream(null);
      localStreamRef.current = null;

      setErrorMsg("Impossible d'accéder à la caméra/micro (permission refusée ou non disponible).");
      setTransientStatus("");
    }
  }, [connectToAllKnownActivePeers, signalingConnected, setTransientStatus]);

  const stopLocalMedia = useCallback(() => {
    setErrorMsg("");

    if (socketRef.current) {
      socketRef.current.emit("user-inactive");
    }

    const stream = localStreamRef.current;
    if (stream) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) { }
    }

    setLocalStream(null);
    localStreamRef.current = null;

    setIsActive(false);
    isActiveRef.current = false;

    const peers = Array.from(peersRef.current.keys());
    peers.forEach((sid) => removePeerEverywhere(sid));

    setRemoteTiles([]);
    remoteTilesRef.current = [];

    setTransientStatus("Tu as quitté la visio.");
  }, [removePeerEverywhere, setTransientStatus]);

  const copyLink = useCallback(async () => {
    setErrorMsg("");
    try {
      await navigator.clipboard.writeText(shareLink);
      setTransientStatus("Lien copié ✅");
    } catch (e) {
      try {
        window.prompt("Copie le lien :", shareLink);
      } catch (e2) { }
    }
  }, [shareLink, setTransientStatus]);

  const newRoom = useCallback(() => {
    const next = generateRoomId(8);
    const url = new URL(window.location.href);
    url.searchParams.set("room", next);
    window.location.href = url.toString();
  }, []);

  const activeCount = useMemo(() => {
    const local = isActive ? 1 : 0;
    return local + remoteTiles.length;
  }, [isActive, remoteTiles.length]);

  return (
    <div className="appRoot">
      <div className="topBar">
        <div className="brand">
          <div className="brandTitle">Visio 1</div>
          <div className="brandSub">
            Room: <span className="mono">{roomId}</span>
            <span className={`pill ${signalingConnected ? "pillOk" : "pillWarn"}`}>
              {signalingConnected ? "Signaling OK" : "Signaling OFF"}
            </span>
            <span className="pill pillInfo">
              Actifs: {activeCount}/{maxActive}
            </span>
          </div>
        </div>

        <div className="actions">
          <button className="btn" type="button" onClick={copyLink}>
            Copier le lien
          </button>

          <button className="btn" type="button" onClick={newRoom}>
            Nouveau salon
          </button>

          {!isActive ? (
            <button className="btnPrimary" type="button" onClick={startLocalMedia}>
              + (apparaître)
            </button>
          ) : (
            <button className="btnDanger" type="button" onClick={stopLocalMedia}>
              Stop
            </button>
          )}
        </div>
      </div>

      <div className="content">
        {statusMsg ? <div className="status">{statusMsg}</div> : null}
        {errorMsg ? <div className="error">{errorMsg}</div> : null}

        <div className="hintBox">
          <div className="hintTitle">Mode d’emploi ultra simple :</div>
          <ol className="hintList">
            <li>Partage le lien “Copier le lien” à une autre personne.</li>
            <li>Chacun ouvre le lien, puis clique sur <span className="kbd">+</span> pour apparaître.</li>
            <li>À chaque nouvelle personne, une nouvelle vignette vidéo s’ajoute automatiquement.</li>
          </ol>
          <div className="hintSmall">
            Ton ID (sans login) : <span className="mono">{formatShort(userId)}</span>
          </div>
        </div>

        <div className="grid">
          {!isActive ? (
            <VideoTile
              label="Moi"
              subLabel="(pas encore visible)"
              stream={null}
              muted={true}
              isPlaceholder={true}
            />
          ) : (
            <VideoTile
              label="Moi"
              subLabel="cam/micro ON"
              stream={localStream}
              muted={true}
              isPlaceholder={false}
            />
          )}

          {remoteTiles.map((t) => (
            <VideoTile
              key={t.socketId}
              label="Participant"
              subLabel={formatShort(t.userId)}
              stream={t.stream}
              muted={false}
              isPlaceholder={false}
            />
          ))}
        </div>

        <div className="footer">
          <div className="footerLine">
            Astuce : sur Cloud Run, tu es en HTTPS donc ça marche sur mobile.
          </div>
          <div className="footerLine">
            Plus tard : si certains réseaux ne se connectent pas, ajoute un serveur <b>TURN</b>.
          </div>
        </div>
      </div>
    </div>
  );
}
