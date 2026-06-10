import { io } from "socket.io-client";

const socket = io("https://p2p-webshare-s21x.onrender.com");

export default socket;