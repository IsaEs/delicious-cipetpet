import { memo, useContext, useEffect, useLayoutEffect, useRef, type ReactElement, type ReactNode } from "react";
import type { AssistantMessage, Message, UserMessage } from "../conversation/types.ts";
import { formatMs, I18nContext, useT } from "./i18n.ts";
import { MicIcon, SpeakerIcon } from "./icons.tsx";

function UserBubble({ m }: { m: UserMessage }): ReactElement {
  const t = useT();
  const { lang } = useContext(I18nContext);
  return (
    <li className="msg msg--user">
      <div className="msg__meta">
        <span className="msg__who">{t("msg.you")}</span>
        {m.source === "voice" ? (
          <span className="msg__chip" title={m.lang ? `lang: ${m.lang}` : undefined}>
            <MicIcon width={14} height={14} />
            {m.sttMs !== undefined ? t("msg.stt", { ms: formatMs(t, m.sttMs, lang) }) : null}
            {m.lang && m.lang !== "tr" ? <span className="msg__lang">{m.lang}</span> : null}
          </span>
        ) : (
          <span className="msg__chip">{t("msg.typed")}</span>
        )}
      </div>
      <div className="msg__bubble">{m.text}</div>
    </li>
  );
}

function highlighted(m: AssistantMessage): ReactNode {
  const span = m.speaking !== null ? m.sentences[m.speaking] : undefined;
  if (!span) return m.text;
  return (
    <>
      {m.text.slice(0, span.start)}
      <mark className="speaking">{m.text.slice(span.start, span.end)}</mark>
      {m.text.slice(span.end)}
    </>
  );
}

function AssistantBubble({ m, onSpeakAgain, canSpeak }: { m: AssistantMessage; onSpeakAgain(id: string): void; canSpeak: boolean }): ReactElement {
  const t = useT();
  const { lang } = useContext(I18nContext);
  const tm = m.timings;
  const stats: string[] = [];
  if (tm.ttftMs !== undefined) stats.push(t("msg.ttft", { ms: formatMs(t, tm.ttftMs, lang) }));
  if (tm.ttfaMs !== undefined) stats.push(t("msg.ttfa", { ms: formatMs(t, tm.ttfaMs, lang) }));
  if (tm.totalMs !== undefined) stats.push(t("msg.total", { ms: formatMs(t, tm.totalMs, lang) }));
  const busy = m.status === "pending" || m.status === "streaming";
  return (
    <li className={`msg msg--assistant is-${m.status}${m.speaking !== null ? " is-speaking" : ""}`}>
      <div className="msg__meta">
        <span className="msg__who">{t("msg.assistant")}</span>
        <span className="msg__chip">{m.backend === "echo" ? t("msg.echo") : m.model}</span>
        {m.status === "interrupted" && <span className="msg__chip is-warn">{t("msg.interrupted")}</span>}
        {m.status === "error" && <span className="msg__chip is-error">{t("msg.error")}</span>}
        {m.silent && <span className="msg__chip">{t("msg.silent")}</span>}
      </div>
      <div className="msg__bubble" aria-busy={busy}>
        {m.text ? highlighted(m) : m.status === "pending" ? <span className="typing" aria-label={t("msg.thinking")}><i /><i /><i /></span> : null}
        {m.status === "streaming" && <span className="caret" aria-hidden="true" />}
      </div>
      <div className="msg__foot">
        {stats.length > 0 && <span className="msg__stats">{stats.join(" · ")}</span>}
        {!busy && m.text && (
          <button type="button" className="link-button" onClick={() => onSpeakAgain(m.id)} disabled={!canSpeak} title={t("msg.speakAgain")}>
            <SpeakerIcon width={16} height={16} />
            {t("msg.speakAgain")}
          </button>
        )}
      </div>
    </li>
  );
}

const MemoUser = memo(UserBubble);
const MemoAssistant = memo(AssistantBubble);

export interface TranscriptProps {
  messages: Message[];
  onSpeakAgain(id: string): void;
  canSpeak: boolean;
}

export function Transcript({ messages, onSpeakAgain, canSpeak }: TranscriptProps): ReactElement {
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const t = useT();

  // follow new content while the user is at the bottom; leave them alone when they scrolled up to read
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  return (
    // role="log" with aria-live off: streamed text would be read token by token; finished messages are
    // announced by the separate live region in Conversation.tsx
    <ol ref={ref} className="transcript" role="log" aria-live="off" aria-label={t("app.title")}>
      {messages.map((m) =>
        m.role === "user" ? <MemoUser key={m.id} m={m} /> : <MemoAssistant key={m.id} m={m} onSpeakAgain={onSpeakAgain} canSpeak={canSpeak} />,
      )}
    </ol>
  );
}
