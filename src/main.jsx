import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./App.css";
import { registerOfflineAppShell } from "./offlineAppShell";

registerOfflineAppShell();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
