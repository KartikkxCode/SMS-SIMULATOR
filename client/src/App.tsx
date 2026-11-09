import { useEffect, useState } from "react";
import { SmsWizard } from "./channels/sms/SmsWizard.tsx";
import { WhatsAppWizard } from "./channels/whatsapp/WhatsAppWizard.tsx";

type Channel = "sms" | "whatsapp";

const channelFromHash = (): Channel => (window.location.hash === "#/whatsapp" ? "whatsapp" : "sms");

export function App() {
  const [channel, setChannel] = useState<Channel>(channelFromHash);

  useEffect(() => {
    const onHash = () => setChannel(channelFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className={`app channel-${channel}`}>
      <header className="app-header">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <div>
            <h1>SMS Simulator</h1>
            <p>Send one message to every contact in a file or a typed list.</p>
          </div>
        </div>
        <nav className="channel-switch" aria-label="Channel">
          <a href="#/sms" className={channel === "sms" ? "active" : ""} aria-current={channel === "sms" ? "page" : undefined}>
            SMS
          </a>
          <a
            href="#/whatsapp"
            className={channel === "whatsapp" ? "active" : ""}
            aria-current={channel === "whatsapp" ? "page" : undefined}
          >
            WhatsApp
          </a>
        </nav>
      </header>

      {/* Both stay mounted so switching channels keeps each one's progress. */}
      <div hidden={channel !== "sms"} data-channel="sms">
        <SmsWizard />
      </div>
      <div hidden={channel !== "whatsapp"} data-channel="whatsapp">
        <WhatsAppWizard />
      </div>

      <footer className="app-footer">
        Runs on your computer only. Your API keys stay in the <code>.env</code> file and are never sent to the browser.
      </footer>
    </div>
  );
}
