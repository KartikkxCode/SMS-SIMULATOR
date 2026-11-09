import type { ReactNode } from "react";
import type { Rendered, WaMediaInfo } from "./api.ts";
import { formatWhatsApp } from "./format.ts";

function Formatted({ text }: { text: string }) {
  return (
    <>
      {formatWhatsApp(text).map((s, i) => {
        if (s.type === "bold") return <strong key={i}>{s.text}</strong>;
        if (s.type === "italic") return <em key={i}>{s.text}</em>;
        if (s.type === "strike") return <s key={i}>{s.text}</s>;
        if (s.type === "mono") return <code key={i}>{s.text}</code>;
        return <span key={i}>{s.text}</span>;
      })}
    </>
  );
}

const BUTTON_ICON: Record<string, string> = { URL: "↗", PHONE_NUMBER: "✆", QUICK_REPLY: "↩", COPY_CODE: "⧉" };

type Props = {
  message: Rendered;
  headerFormat: string;
  media?: WaMediaInfo | null;
  businessName?: string;
  /** Shown above the phone, e.g. "Asha · row 2". */
  caption?: ReactNode;
};

/** The message as it will look in WhatsApp. */
export function WaPreview({ message, headerFormat, media, businessName, caption }: Props) {
  return (
    <figure className="wa-phone" aria-label="WhatsApp message preview">
      {caption && <figcaption className="wa-caption">{caption}</figcaption>}
      <div className="wa-topbar">
        <span className="wa-avatar" aria-hidden="true">
          {(businessName ?? "B").charAt(0).toUpperCase()}
        </span>
        <span>{businessName ?? "Your business"}</span>
      </div>
      <div className="wa-chat">
        <div className="wa-bubble">
          {headerFormat === "IMAGE" &&
            (media?.previewUrl ? (
              <img className="wa-media" src={media.previewUrl} alt="Header image" />
            ) : (
              <div className="wa-media wa-media-empty">Image goes here</div>
            ))}
          {headerFormat === "DOCUMENT" && (
            <div className="wa-doc">
              <span className="wa-doc-icon" aria-hidden="true">
                PDF
              </span>
              <span>{media?.filename ?? "Document goes here"}</span>
            </div>
          )}
          {message.header && (
            <p className="wa-header">
              <Formatted text={message.header} />
            </p>
          )}
          <p className="wa-body">
            <Formatted text={message.body} />
          </p>
          {message.footer && <p className="wa-footer">{message.footer}</p>}
          <span className="wa-time">10:42</span>
        </div>
        {message.buttons.length > 0 && (
          <div className="wa-buttons">
            {message.buttons.map((b, i) => (
              <span key={i} className="wa-button" title={b.url ?? b.code}>
                <span aria-hidden="true">{BUTTON_ICON[b.type] ?? "•"}</span> {b.type === "COPY_CODE" ? `Copy code ${b.code ?? ""}`.trim() : b.text}
              </span>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
