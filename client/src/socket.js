import { io } from "socket.io-client";

const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const SIGNALING_URL = isLocal ? "http://localhost:3001" : "https://p2p-webshare-s21x.onrender.com";

const socket = io(SIGNALING_URL);

export default socket;