import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AppFatalBoundary from "./AppFatalBoundary";
import "./App.css";
import { registerOfflineAppShell } from "./offlineAppShell";
import { MAZZY_ROOT_ERROR_OPTIONS } from "./reactRootErrorOptions";

registerOfflineAppShell();

createRoot(document.getElementById("root"), MAZZY_ROOT_ERROR_OPTIONS).render(
  <AppFatalBoundary>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </AppFatalBoundary>
);
