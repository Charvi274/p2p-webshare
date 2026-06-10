import { useState, useRef, useEffect } from "react";
import socket from "../socket";

export default function Sender() {
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [shareLink, setShareLink] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | waiting | connected | transferring | done
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const fileInputRef = useRef(null);
  const roomIdRef = useRef(null);
  const peerRef = useRef(null);
  const encryptionKeyRef = useRef(null);
  // ✅ FIX 1: Keep a ref that always mirrors the latest `file` state.
  // The useEffect closure captures `file` at mount time (null), so
  // channel.onopen → sendFile(channel) would call file.arrayBuffer()
  // on null and crash silently. Reading fileRef.current instead always
  // gets the live value regardless of when the closure was created.
  const fileRef = useRef(null);
  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  const CHUNK_SIZE = 64 * 1024; // 64 KB

  useEffect(() => {
    // Receiver joined — initiate WebRTC offer
    socket.on("peer-joined", async () => {
      setStatus("connected");

      const peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      peerRef.current = peer;

      const channel = peer.createDataChannel("fileTransfer");
      channel.binaryType = "arraybuffer";

      // ✅ FIX 2: Pass fileRef.current into sendFile explicitly at the
      // moment onopen fires, instead of relying on the stale closure.
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
      await peerRef.current?.setRemoteDescription(answer);
    });

    socket.on("ice-candidate", async ({ candidate }) => {
      try {
        await peerRef.current?.addIceCandidate(candidate);
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
  }, []);

  // ✅ FIX 3: Accept `activeFile` as a parameter so this function never
  // touches the React state variable (which would be stale in the closure).
  const sendFile = async (channel, activeFile) => {
  setStatus("transferring");

  const arrayBuffer = await activeFile.arrayBuffer();

  // Encrypt the entire buffer with AES-GCM
  // IV (initialization vector) is 12 random bytes — safe to send in plaintext
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

  // Send metadata — iv is sent as a regular array so JSON can carry it
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
};

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

  // Key goes in the hash fragment — never sent to the server
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
      <div className="mb-10 text-center">
        <h1 className="text-4xl font-bold text-violet-400 tracking-tight">
          P2P WebShare
        </h1>
        <p className="text-gray-400 mt-2 text-sm">
          Direct browser-to-browser file transfer. No server storage.
        </p>
      </div>

      {/* ── Drop Zone (pre-share) ── */}
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
              className="mt-6 px-8 py-3 bg-violet-600 hover:bg-violet-500 text-white font-semibold rounded-xl transition-all"
              onClick={generateRoom}
            >
              Generate Share Link
            </button>
          )}
        </>
      )}

      {/* ── Share / Transfer Panel ── */}
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