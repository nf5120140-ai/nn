import React from "react";
import ReactDOM from "react-dom/client";
import "./storageShim.js";
import "./index.css";
import App from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// רישום ה-service worker - נדרש עבור התראות push ועבודה אופליין.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => console.log("Service worker registered:", reg.scope))
      .catch((err) => console.error("Service worker registration failed:", err));
  });
}
