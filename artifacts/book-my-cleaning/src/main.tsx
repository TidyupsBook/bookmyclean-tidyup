import { createRoot } from "react-dom/client";

import App from "./App";
import { describeStartupError, reportStartupFailure } from "./lib/appShell";

import "./index.css";

// Anything that goes wrong here leaves the static marketing shell on screen
// with a readable explanation on it, rather than an empty document. The shell
// is dismissed from inside the app itself, once React has rendered something.
const container = document.getElementById("root");

if (!container) {
  reportStartupFailure("This page is missing the container the app mounts to.");
} else {
  try {
    createRoot(container).render(<App />);
  } catch (error) {
    reportStartupFailure(describeStartupError(error));
  }
}
