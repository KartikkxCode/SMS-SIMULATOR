import { useEffect, useState } from "react";
import { api, type AppConfig, type ContactSummary, type UploadInfo } from "./api.ts";
import { ComposeStep, type Compose } from "./steps/Compose.tsx";
import { ContactsStep } from "./steps/Contacts.tsx";
import { SendStep } from "./steps/Send.tsx";
import { UploadStep } from "./steps/Upload.tsx";

const STEPS = ["Upload file", "Check contacts", "Write message", "Send"] as const;

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState("");
  const [step, setStep] = useState(0);
  const [upload, setUpload] = useState<UploadInfo | null>(null);
  const [column, setColumn] = useState(0);
  const [contacts, setContacts] = useState<ContactSummary | null>(null);
  const [compose, setCompose] = useState<Compose>({ templateId: "", template: "", variables: {} });

  useEffect(() => {
    api
      .config()
      .then((c) => {
        setConfig(c);
        setCompose((prev) => ({ ...prev, templateId: prev.templateId || c.defaultTemplateId }));
      })
      .catch((err: Error) => setConfigError(err.message));
  }, []);

  function startOver() {
    setUpload(null);
    setContacts(null);
    setStep(0);
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <div>
            <h1>SMS Simulator</h1>
            <p>Send one message to every contact in a CSV or Excel file, through MSG91.</p>
          </div>
        </div>
        {config && (
          <span className={`pill ${config.liveAvailable ? "pill-live" : ""}`}>
            {config.liveAvailable ? "MSG91 connected" : "Simulate only: no MSG91 key"}
          </span>
        )}
      </header>

      <ol className="stepper" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? "current" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}>
            <span className="dot">{i < step ? "✓" : i + 1}</span>
            <span className="label">{label}</span>
          </li>
        ))}
      </ol>

      <main className="card">
        {configError && <p className="error">{configError}</p>}
        {step === 0 && (
          <UploadStep
            onUploaded={(info) => {
              setUpload(info);
              setColumn(info.phoneColumn);
              setContacts(null);
              setStep(1);
            }}
          />
        )}
        {step === 1 && upload && (
          <ContactsStep
            upload={upload}
            column={column}
            onColumnChange={setColumn}
            contacts={contacts}
            onContacts={setContacts}
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && contacts && (
          <ComposeStep
            value={compose}
            onChange={setCompose}
            recipients={contacts.validCount}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}
        {step === 3 && upload && contacts && config && (
          <SendStep
            config={config}
            upload={upload}
            column={column}
            recipients={contacts.validCount}
            compose={compose}
            onBack={() => setStep(2)}
            onStartOver={startOver}
          />
        )}
      </main>

      <footer className="app-footer">
        Runs on your computer only. Your MSG91 key stays in the <code>.env</code> file and is never sent to the browser.
      </footer>
    </div>
  );
}
