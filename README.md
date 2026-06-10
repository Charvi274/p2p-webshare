# P2P WebShare

A decentralized, browser-to-browser file transfer app built with WebRTC, React, and Node.js. Files are transferred directly between peers - the server only coordinates the initial connection handshake and never sees any file data.

## Live demo

https://p2p-webshare.vercel.app

## How it works

1. The sender drops a file and gets a unique share link
2. The receiver opens the link in any browser
3. A WebRTC data channel opens directly between the two browsers
4. The file streams peer-to-peer in 64KB chunks
5. Once received, the file is verified and auto-downloaded

No file data ever touches the signaling server.

## Features

- Drag-and-drop file upload
- Unique room-based sharing via URL
- Direct WebRTC P2P transfer (no server relay)
- Real-time progress bar and transfer speed (MB/s)
- SHA-256 integrity verification on received file
- AES-GCM 256-bit end-to-end encryption - decryption key lives only in the URL hash, never sent to the server
- Graceful disconnect handling on both sender and receiver

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + Tailwind CSS |
| P2P | WebRTC DataChannel (native browser API) |
| Signaling | Node.js + Express + Socket.io |
| Encryption | Web Crypto API (AES-GCM) |

## Local setup

### Prerequisites
- Node.js 18+
- npm

### Signaling server

```bash
cd server
npm install
node index.js
```

Runs on `http://localhost:3001`

### Frontend

```bash
cd client
npm install
npm run dev
```

Runs on `http://localhost:5173`

### Testing a transfer

1. Open `http://localhost:5173` in one browser window
2. Drop a file and click **Generate share link**
3. Copy the link and open it in a second browser window
4. The file will transfer directly and download automatically

## Project structure

```
p2p-webshare/
├── server/
│   └── index.js        # Signaling server (Socket.io)
└── client/
    └── src/
        ├── pages/
        │   ├── Sender.jsx
        │   └── Receiver.jsx
        ├── socket.js
        └── App.jsx
```
## Author
Charvi  
24113033  
IIT Roorkee
