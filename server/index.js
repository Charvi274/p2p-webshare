const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Store rooms: roomId -> list of socket ids
const rooms = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Sender creates a room
  socket.on("create-room", (roomId) => {
    rooms[roomId] = [socket.id];
    socket.join(roomId);
    console.log(`Room created: ${roomId}`);
  });

  // Receiver joins a room
  socket.on("join-room", (roomId) => {
    if (!rooms[roomId]) {
      socket.emit("room-not-found");
      return;
    }
    rooms[roomId].push(socket.id);
    socket.join(roomId);
    // Tell the sender someone joined
    socket.to(roomId).emit("peer-joined", socket.id);
    console.log(`Peer joined room: ${roomId}`);
  });

  // WebRTC signaling — just relay, server never reads file data
  socket.on("offer", ({ roomId, offer }) => {
    socket.to(roomId).emit("offer", { offer, from: socket.id });
  });

  socket.on("answer", ({ roomId, answer }) => {
    socket.to(roomId).emit("answer", { answer });
  });

  socket.on("ice-candidate", ({ roomId, candidate }) => {
    socket.to(roomId).emit("ice-candidate", { candidate });
  });

  // Graceful disconnect
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      rooms[roomId] = rooms[roomId].filter((id) => id !== socket.id);
      if (rooms[roomId].length === 0) {
        delete rooms[roomId];
      } else {
        // Notify remaining peer
        io.to(roomId).emit("peer-disconnected");
      }
    }
    console.log("User disconnected:", socket.id);
  });
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});