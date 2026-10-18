import { useEffect, type ReactElement } from "react";
import type { Notice } from "../conversation/types.ts";
import { useT, type MessageKey, type Translate } from "./i18n.ts";
import { AlertIcon, CloseIcon, InfoIcon } from "./icons.tsx";

export function noticeText(t: Translate, n: Notice): string {
  if (n.key === "mic") return t("notice.mic", { message: n.message ?? "" });
  if (n.key !== "generic") return t(`notice.${n.key}` as MessageKey);
  const lead = n.code ? t(`err.${n.code}` as MessageKey) : "";
  const msg = n.message ?? "";
  return lead && !msg.toLowerCase().startsWith(lead.toLowerCase()) ? `${lead}. ${msg}` : msg || lead;
}

function Toast({ n, onDismiss }: { n: Notice; onDismiss(id: number): void }): ReactElement {
  const t = useT();
  useEffect(() => {
    if (n.kind !== "info") return;
    const timer = setTimeout(() => onDismiss(n.id), 9000);
    return () => clearTimeout(timer);
  }, [n, onDismiss]);
  return (
    <div className={`toast toast--${n.kind}`} role={n.kind === "error" ? "alert" : "status"}>
      {n.kind === "error" ? <AlertIcon className="toast__icon" /> : <InfoIcon className="toast__icon" />}
      <p className="toast__text">{noticeText(t, n)}</p>
      <button type="button" className="icon-button icon-button--small" onClick={() => onDismiss(n.id)} aria-label={t("notice.dismiss")} title={t("notice.dismiss")}>
        <CloseIcon width={16} height={16} />
      </button>
    </div>
  );
}

export function Toasts({ notices, onDismiss }: { notices: Notice[]; onDismiss(id: number): void }): ReactElement {
  return (
    <div className="toasts">
      {notices.map((n) => (
        <Toast key={n.id} n={n} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
