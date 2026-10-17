import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { embedApprovalId } from "./api/adapter";
import App from "./App";
import { EmbedApproval } from "./Embed";
import { applyTheme, themeFromSearch } from "./theme";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/services.css";

const embedId = embedApprovalId();
const root = createRoot(document.getElementById("root")!);

if (embedId) {
  // Embed: no app chrome, transparent, theme from ?theme= (the chat can pass its own) or the OS.
  document.documentElement.classList.add("embed");
  applyTheme(themeFromSearch(location.search) ?? "system");
  root.render(
    <StrictMode>
      <EmbedApproval id={embedId} />
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
