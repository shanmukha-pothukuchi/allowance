import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { embedApprovalId } from "./api/adapter";
import App from "./App";
import { EmbedApproval } from "./Embed";
import { EmbedSheet } from "./EmbedSheet";
import { embedSheet } from "./sheets";
import { applyTheme, themeFromSearch } from "./theme";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/services.css";
import "./styles/sheets.css";

const embedId = embedApprovalId();
const sheet = embedId ? null : embedSheet(location.search);
const root = createRoot(document.getElementById("root")!);

if (sheet) {
  // Owner sheet for the chat (§14.3): same embed rules as the approval card, except that it
  // scrolls inside the iframe if the chat gives it less height than it asked for.
  document.documentElement.classList.add("embed", "embed-sheet-doc");
  applyTheme(themeFromSearch(location.search) ?? "system");
  root.render(
    <StrictMode>
      <EmbedSheet route={sheet} />
    </StrictMode>,
  );
} else if (embedId) {
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
