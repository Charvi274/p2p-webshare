import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import socket from "../socket";

export default function Receiver() {
  const { roomId } = useParams();
  const [status, setStatus] = useState("connecting"); // connecting, waiting ,receiving ,verifying , done, error
  const [fileInfo, setFileInfo] = useState(null);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [socketConnected, setSocketConnected] = useState(socket.connected);

  const peerRef = useRef(null);
  const chunksRef = useRef([]);
  const receivedSizeRef = useRef(0);
  const lastTimeRef = useRef(null);
  const lastBytesRef = useRef(0);

  const fileInfoRef = useRef(null);
  const iceCandidatesQueue = useRef([]);

  const verifyAndDownload = useCallback(async () => {
    setStatus("verifying");
    setSpeed(0);

    // Extract key from URL hash: /room/abc#key=<base64>
    const hash = window.location.hash;
    const keyBase64 = hash.startsWith("#key=") ? hash.slice(5) : null;

    if (!keyBase64) {
      console.error("No decryption key found in URL hash");
      setStatus("error");
      return;
    }

    // Decode base64 key and import it as AES-GCM
    const rawKey = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false, // not extractable on receiver side
      ["decrypt"]
    );

    // Reassemble all encrypted chunks into one ArrayBuffer
    const encryptedBlob = new Blob(chunksRef.current);
    const encryptedBuffer = await encryptedBlob.arrayBuffer();

    // IV was sent in metadata as a plain number array
    const iv = new Uint8Array(fileInfoRef.current.iv);

    let decryptedBuffer;
    try {
      decryptedBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        encryptedBuffer
      );
    } catch (e) {
      console.error("Decryption failed — wrong key or corrupted data:", e);
      setStatus("error");
      return;
    }

    // SHA-256 is verified against the DECRYPTED (original) file
    const hashBuffer = await crypto.subtle.digest("SHA-256", decryptedBuffer);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (hashHex !== fileInfoRef.current.hash) {
      console.error("Hash mismatch — file corrupted in transit");
      setStatus("error");
      return;
    }

    const downloadBlob = new Blob([decryptedBuffer], {
      type: fileInfoRef.current.type,
    });
    const url = URL.createObjectURL(downloadBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileInfoRef.current.name;
    a.click();
    URL.revokeObjectURL(url);

    setStatus("done");
    setProgress(100);
  }, []);

  useEffect(() => {
    // Wake up the signaling server early if it is sleeping on Render free tier
    const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    const wakeupUrl = isLocal ? "http://localhost:3001/" : "https://p2p-webshare-s21x.onrender.com/";
    fetch(wakeupUrl).catch(() => {});

    function onConnect() {
      setSocketConnected(true);
      console.log("Receiver socket connected. Joining room:", roomId);
      socket.emit("join-room", roomId);
    }

    function onDisconnect() {
      setSocketConnected(false);
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    // Initial emit
    if (socket.connected) {
      socket.emit("join-room", roomId);
    }

    socket.on("room-not-found", () => setStatus("error"));

    socket.on("offer", async ({ offer }) => {
    
      setStatus("waiting");
      chunksRef.current = [];
      receivedSizeRef.current = 0;
      lastBytesRef.current = 0;
      lastTimeRef.current = null;

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

      peer.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit("ice-candidate", { roomId, candidate: e.candidate });
        }
      };


      peer.ondatachannel = (e) => {
        const channel = e.channel;
        channel.binaryType = "arraybuffer";

    
        let metadataReceived = false;

        channel.onopen = () => {
          // Channel is open on receiver side — transfer is about to begin
          console.log("Data channel open on receiver");
        };

        channel.onerror = (e) => {
          console.error("Receiver data channel error:", e);
          setStatus("error");
        };

        channel.onmessage = (event) => {
          //First message: JSON metadata 
          if (!metadataReceived) {
            try {
              const metadata = JSON.parse(event.data);
              fileInfoRef.current = metadata;
              setFileInfo(metadata);
              setStatus("receiving");
              metadataReceived = true;
            } catch {
              console.error("Failed to parse metadata:", event.data);
              setStatus("error");
            }
            return;
          }

          //Sentinel string: transfer complete 
          if (typeof event.data === "string") {
            if (event.data === "__END__") {
              verifyAndDownload();
            }
            return;
          }

          //Binary chunk
          chunksRef.current.push(event.data);
          receivedSizeRef.current += event.data.byteLength;

          // Speed (sampled every 500 ms)
          const now = Date.now();
          if (lastTimeRef.current === null) {
            lastTimeRef.current = now;
          }
          const elapsed = (now - lastTimeRef.current) / 1000;
          if (elapsed >= 0.5) {
            const delta = receivedSizeRef.current - lastBytesRef.current;
            setSpeed((delta / elapsed / (1024 * 1024)).toFixed(2));
            lastBytesRef.current = receivedSizeRef.current;
            lastTimeRef.current = now;
          }

          if (fileInfoRef.current) {
            setProgress(
              Math.round(
                (receivedSizeRef.current / fileInfoRef.current.size) * 100
              )
            );
          }
        };
      };

      peer.onconnectionstatechange = () => {
        if (
          peer.connectionState === "failed" ||
          peer.connectionState === "disconnected"
        ) {
          setStatus((prev) => (prev !== "done" ? "error" : "done"));
        }
      };

      await peer.setRemoteDescription(offer);

      // Process queued candidates
      while (iceCandidatesQueue.current.length > 0) {
        const qc = iceCandidatesQueue.current.shift();
        try {
          await peer.addIceCandidate(qc);
        } catch (e) {
          console.warn("Error adding queued ICE candidate:", e);
        }
      }

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit("answer", { roomId, answer });
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
      setStatus((prev) => (prev !== "done" ? "error" : "done"));
    });

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room-not-found");
      socket.off("offer");
      socket.off("ice-candidate");
      socket.off("peer-disconnected");
    };
  }, [roomId, verifyAndDownload]);

  const formatSize = (bytes) => {
    if (!bytes) return "";
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

      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-2xl p-6">

        {/* Connecting to signaling server */}
        {!socketConnected && (
          <div className="flex items-center gap-2 animate-pulse">
            <div className="w-2 h-2 rounded-full bg-yellow-400 animate-ping" />
            <p className="text-yellow-400 text-sm">Waking up signaling server... (This may take up to 50 seconds)</p>
          </div>
        )}

        {socketConnected && status === "connecting" && (
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-400 animate-pulse" />
            <p className="text-yellow-400 text-sm">Connecting to room…</p>
          </div>
        )}

        {socketConnected && status === "waiting" && (
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-400 animate-pulse" />
            <p className="text-yellow-400 text-sm">Establishing connection…</p>
          </div>
        )}

        {/* File name / size — shown once metadata has arrived */}
        {fileInfo && (status === "receiving" || status === "verifying" || status === "done") && (
          <div className="mb-4">
            <p className="text-gray-400 text-sm mb-1">Receiving</p>
            <p className="text-violet-300 font-semibold text-lg truncate">
              {fileInfo.name}
            </p>
            <p className="text-gray-500 text-xs mt-1">{formatSize(fileInfo.size)}</p>
          </div>
        )}

        {status === "receiving" && (
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-400">Receiving…</span>
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

        {status === "verifying" && (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <p className="text-blue-400 text-sm">Verifying file integrity…</p>
          </div>
        )}

        {status === "done" && (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-400" />
            <p className="text-green-400 text-sm">
              Transfer complete. File downloaded ✓
            </p>
          </div>
        )}

        {status === "error" && (
          <div>
            <p className="text-red-400 font-semibold">Connection failed.</p>
            <p className="text-gray-500 text-sm mt-1">
              The room may not exist, the sender disconnected, or file
              integrity check failed.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}