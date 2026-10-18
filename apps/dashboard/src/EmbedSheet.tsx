/**
 * `/?sheet=new-agent&embed=1` and `/?sheet=add-money&agent=<name>&embed=1`: an owner sheet alone,
 * for the agent chat to iframe (§14.3). Same origin as the dashboard, so its wallet calls carry the
 * owner key via the dev proxy. Posts to the parent only at the chat origin (or the dashboard's
 * own), and never a token.
 */
import { useLayoutEffect, useRef } from "react";
import { AddMoneySheet } from "./components/AddMoneySheet";
import { NewAgentSheet } from "./components/NewAgentSheet";
import { agentCreatedMessage, chatUrlFrom, moneyAddedMessage, postSheetMessage, sheetCloseMessage, sheetSizeMessage, type SheetRoute } from "./sheets";
import { useStandaloneAdapter } from "./useAdapter";

export function EmbedSheet({ route }: { route: SheetRoute }) {
  const chatUrl = chatUrlFrom();
  const { adapter, offline } = useStandaloneAdapter();
  const rootRef = useRef<HTMLDivElement>(null);
  const sheet = route.sheet;

  // Height on load and on every resize, so the chat can size the iframe to the sheet.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const send = () => postSheetMessage(sheetSizeMessage(sheet, el.getBoundingClientRect().height), chatUrl);
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sheet, chatUrl]);

  const close = () => postSheetMessage(sheetCloseMessage(sheet), chatUrl);

  return (
    <div className="embed embed-sheet" ref={rootRef}>
      {route.sheet === "new-agent" ? (
        <NewAgentSheet adapter={adapter} offline={offline} embed chatUrl={chatUrl} onClose={close} onReady={(name) => postSheetMessage(agentCreatedMessage(name), chatUrl)} />
      ) : (
        <AddMoneySheet adapter={adapter} offline={offline} embed agentName={route.agent} onClose={close} onAdded={(name, amount) => postSheetMessage(moneyAddedMessage(name, amount), chatUrl)} />
      )}
    </div>
  );
}
