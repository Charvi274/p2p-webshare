import { BrowserRouter, Routes, Route } from "react-router-dom";
import Sender from "./pages/Sender";
import Receiver from "./pages/Receiver";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Sender />} />
        <Route path="/room/:roomId" element={<Receiver />} />
      </Routes>
    </BrowserRouter>
  );
}