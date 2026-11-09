import { useEffect, useState } from "react";
import { api, type AppConfig, type ContactSummary, type UploadInfo } from "../../api.ts";
import { Stepper } from "../../components/Stepper.tsx";
import { ContactsStep } from "../../steps/Contacts.tsx";
import { UploadStep } from "../../steps/Upload.tsx";
import { ComposeStep, type Compose } from "./Compose.tsx";
import { SendStep } from "./Send.tsx";

const STEPS = ["Add contacts", "Check contacts", "Write message", "Send"] as const;

export function SmsWizard() {
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
    <>
      <div className="channel-bar">
        <p className="muted">Send one SMS to every contact through MSG91.</p>
        {config && (
          <span className={`pill ${config.liveAvailable ? "pill-live" : ""}`}>
            {config.liveAvailable ? "MSG91 connected" : "Simulate only: no MSG91 key"}
          </span>
        )}
      </div>

      <Stepper steps={STEPS} current={step} />

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
    </>
  );
}
