import { useState, useRef, useEffect, useCallback } from "react";
import socket from "../socket";

const CHUNK_SIZE = 64 * 1024; // 64 KB

export default function Sender() {
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [shareLink, setShareLink] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | waiting | connected | transferring | done
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [socketConnected, setSocketConnected] = useState(socket.connected);
  const fileInputRef = useRef(null);
  const roomIdRef = useRef(null);
  const peerRef = useRef(null);
  const encryptionKeyRef = useRef(null);
  const iceCandidatesQueue = useRef([]);

  const fileRef = useRef(null);
  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  const sendFile = useCallback(async (channel, activeFile) => {
    setStatus("transferring");

    const arrayBuffer = await activeFile.arrayBuffer();

    // Encrypt the entire buffer with AES-GCM
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      encryptionKeyRef.current,
      arrayBuffer
    );

    // SHA-256 is computed on the ENCRYPTED buffer
    // Receiver decrypts first, then verifies the original file hash
    // So we hash the original plaintext here
    const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Send metadata - iv is sent as a regular array so JSON can carry it
    channel.send(
      JSON.stringify({
        name: activeFile.name,
        size: activeFile.size,
        type: activeFile.type,
        hash: hashHex,
        iv: Array.from(iv), // 12 bytes, not secret
      })
    );

    // Stream the ENCRYPTED buffer in chunks
    let offset = 0;
    let bytesSentWindow = 0;
    let lastTime = Date.now();

    const sendChunk = () => {
      while (offset < encryptedBuffer.byteLength) {
        if (channel.bufferedAmount > 1024 * 1024) {
          setTimeout(sendChunk, 50);
          return;
        }

        const chunk = encryptedBuffer.slice(offset, offset + CHUNK_SIZE);
        channel.send(chunk);
        offset += chunk.byteLength;
        bytesSentWindow += chunk.byteLength;

        const now = Date.now();
        const elapsed = (now - lastTime) / 1000;
        if (elapsed >= 0.5) {
          setSpeed((bytesSentWindow / elapsed / (1024 * 1024)).toFixed(2));
          bytesSentWindow = 0;
          lastTime = now;
        }

        setProgress(Math.round((offset / encryptedBuffer.byteLength) * 100));
      }

      channel.send("__END__");
      setStatus("done");
      setSpeed(0);
      setProgress(100);
    };

    sendChunk();
  }, []);

  useEffect(() => {
    // Receiver joined — initiate WebRTC offer
    socket.on("peer-joined", async () => {
      setStatus("connected");

      const peer = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun.services.mozilla.com" },
          { urls: "stun:openrelay.metered.ca:80" },
          {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
          {
            urls: "turn:openrelay.metered.ca:443",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
          {
            urls: "turn:openrelay.metered.ca:443?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject",
          }
        ],
      });
      peerRef.current = peer;

      // Clear any previous queued candidates
      iceCandidatesQueue.current = [];

      const channel = peer.createDataChannel("fileTransfer");
      channel.binaryType = "arraybuffer";

      channel.onopen = () => {
        const currentFile = fileRef.current;
        if (!currentFile) {
          console.error("onopen fired but fileRef.current is null");
          return;
        }
        sendFile(channel, currentFile);
      };

      channel.onerror = (e) => {
        console.error("Data channel error:", e);
        setStatus("error");
      };

      peer.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit("ice-candidate", {
            roomId: roomIdRef.current,
            candidate: e.candidate,
          });
        }
      };

      peer.onconnectionstatechange = () => {
        if (
          peer.connectionState === "failed" ||
          peer.connectionState === "disconnected"
        ) {
          setStatus("waiting");
          setProgress(0);
          setSpeed(0);
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socket.emit("offer", { roomId: roomIdRef.current, offer });
    });

    socket.on("answer", async ({ answer }) => {
      if (!peerRef.current) return;
      await peerRef.current.setRemoteDescription(answer);

      // Process queued candidates
      while (iceCandidatesQueue.current.length > 0) {
        const qc = iceCandidatesQueue.current.shift();
        try {
          await peerRef.current.addIceCandidate(qc);
        } catch (e) {
          console.warn("Error adding queued ICE candidate:", e);
        }
      }
    });

    socket.on("ice-candidate", async ({ candidate }) => {
      try {
        if (peerRef.current && peerRef.current.remoteDescription) {
          await peerRef.current.addIceCandidate(candidate);
        } else {
          iceCandidatesQueue.current.push(candidate);
        }
      } catch (e) {
        console.warn("ICE candidate error (usually harmless):", e);
      }
    });

    socket.on("peer-disconnected", () => {
      setStatus("waiting");
      setProgress(0);
      setSpeed(0);
    });

    return () => {
      socket.off("peer-joined");
      socket.off("answer");
      socket.off("ice-candidate");
      socket.off("peer-disconnected");
    };
  }, [sendFile]);

  useEffect(() => {
    // Wake up the signaling server early if it is sleeping on Render free tier
    const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    const wakeupUrl = isLocal ? "http://localhost:3001/" : "https://p2p-webshare-s21x.onrender.com/";
    fetch(wakeupUrl).catch(() => {});

    function onConnect() {
      setSocketConnected(true);
      if (status === "waiting" && roomIdRef.current) {
        console.log("Re-creating room on reconnect:", roomIdRef.current);
        socket.emit("create-room", roomIdRef.current);
      }
    }

    function onDisconnect() {
      setSocketConnected(false);
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [status]);



  const handleFile = (selectedFile) => {
    if (!selectedFile) return;
    if (selectedFile.size > 50 * 1024 * 1024) {
      alert("File must be under 50 MB");
      return;
    }
    setFile(selectedFile);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const generateRoom = async () => {
  const id = crypto.randomUUID();
  roomIdRef.current = id;

  // Generate a 256-bit AES-GCM key
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable so we can export it into the URL
    ["encrypt", "decrypt"]
  );

  // Export key as raw bytes -> base64 for URL embedding
  const rawKey = await crypto.subtle.exportKey("raw", key);
  const keyBase64 = btoa(String.fromCharCode(...new Uint8Array(rawKey)));

  // Store key in ref so sendFile can use it later
  encryptionKeyRef.current = key;

  // Key goes in the hash fragment - never sent to the server
  setShareLink(`${window.location.origin}/room/${id}#key=${keyBase64}`);
  setStatus("waiting");
  socket.emit("create-room", id);
};

  const copyLink = () => {
    navigator.clipboard.writeText(shareLink);
    alert("Link copied!");
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center px-4">
      <div className="mb-8 text-center">
        <h1 className="text-4xl font-bold text-violet-400 tracking-tight">
          P2P WebShare
        </h1>
        <p className="text-gray-400 mt-2 text-sm">
          Direct browser-to-browser file transfer. No server storage.
        </p>
      </div>

      {/* Signaling server status message */}
      {!socketConnected && (
        <div className="mb-6 w-full max-w-md bg-yellow-950/40 border border-yellow-800/50 rounded-xl p-3 text-center animate-pulse">
          <p className="text-yellow-400 text-xs flex items-center justify-center gap-2">
            <span className="w-2.5 h-2.5 bg-yellow-400 rounded-full animate-ping" />
            Connecting to signaling server... (This may take up to 50 seconds on cold start)
          </p>
        </div>
      )}
      {socketConnected && !shareLink && (
        <div className="mb-6 w-full max-w-md bg-green-950/20 border border-green-900/30 rounded-xl p-2 text-center">
          <p className="text-green-400 text-xs flex items-center justify-center gap-2">
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full" />
            Connected to signaling server
          </p>
        </div>
      )}

      {/*Drop Zone (pre-share)*/}
      {!shareLink && (
        <>
          <div
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onClick={() => fileInputRef.current.click()}
            className={`w-full max-w-md border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-200
              ${dragging
                ? "border-violet-400 bg-violet-950"
                : "border-gray-700 bg-gray-900 hover:border-violet-600 hover:bg-gray-800"
              }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => handleFile(e.target.files[0])}
            />
            {file ? (
              <div>
                <p className="text-violet-300 font-semibold text-lg truncate">
                  {file.name}
                </p>
                <p className="text-gray-400 text-sm mt-1">{formatSize(file.size)}</p>
                <p className="text-gray-600 text-xs mt-3">Click to change file</p>
              </div>
            ) : (
              <div>
                <p className="text-gray-300 text-lg font-medium">Drop your file here</p>
                <p className="text-gray-500 text-sm mt-2">or click to browse</p>
                <p className="text-gray-600 text-xs mt-4">Max size: 50 MB</p>
              </div>
            )}
          </div>

          {file && (
            <button
              disabled={!socketConnected}
              className={`mt-6 px-8 py-3 font-semibold rounded-xl transition-all ${
                socketConnected
                  ? "bg-violet-600 hover:bg-violet-500 text-white cursor-pointer"
                  : "bg-gray-800 text-gray-500 cursor-not-allowed"
              }`}
              onClick={generateRoom}
            >
              {socketConnected ? "Generate Share Link" : "Waiting for Server Connection..."}
            </button>
          )}
        </>
      )}

      {/*Share / Transfer Panel*/}
      {shareLink && (
        <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-2xl p-6">
          <p className="text-gray-400 text-sm mb-1">Sharing</p>
          <p className="text-violet-300 font-semibold text-lg truncate">{file.name}</p>
          <p className="text-gray-500 text-xs mt-1">{formatSize(file.size)}</p>

          <div className="mt-5">
            <p className="text-gray-400 text-sm mb-2">
              Share this link with the receiver:
            </p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={shareLink}
                className="flex-1 bg-gray-800 text-gray-300 text-xs rounded-lg px-3 py-2 outline-none truncate"
              />
              <button
                onClick={copyLink}
                className="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold rounded-lg transition-all"
              >
                Copy
              </button>
            </div>
          </div>

          <div className="mt-5">
            {status === "waiting" && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                <p className="text-yellow-400 text-sm">
                  Waiting for receiver to connect…
                </p>
              </div>
            )}
            {status === "connected" && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <p className="text-green-400 text-sm">
                  Receiver connected. Starting transfer…
                </p>
              </div>
            )}
            {status === "transferring" && (
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-gray-400">Sending…</span>
                  <span className="text-violet-300">{progress}%</span>
                </div>
                <div className="w-full bg-gray-800 rounded-full h-2">
                  <div
                    className="bg-violet-500 h-2 rounded-full transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-gray-500 text-xs mt-2">{speed} MB/s</p>
              </div>
            )}
            {status === "done" && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-400" />
                <p className="text-green-400 text-sm">Transfer complete.</p>
              </div>
            )}
            {status === "error" && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-red-400" />
                <p className="text-red-400 text-sm">
                  Connection error. Ask the receiver to refresh and retry.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}