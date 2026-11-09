import { useCallback, useEffect, useState } from "react";
import type { ContactSummary, UploadInfo } from "../../api.ts";
import { Stepper } from "../../components/Stepper.tsx";
import { ContactsStep } from "../../steps/Contacts.tsx";
import { UploadStep } from "../../steps/Upload.tsx";
import { waApi, type Mapping, type Preflight, type TemplateChoice, type WaConfig, type WaMediaInfo, type WaProviderId, type WaTemplate } from "./api.ts";
import { PersonalizeStep, guessMapping } from "./PersonalizeStep.tsx";
import { TemplateStep } from "./TemplateStep.tsx";
import { WaSendStep } from "./WaSendStep.tsx";

const STEPS = ["Upload file", "Check contacts", "Template", "Personalize", "Send"] as const;

export function WhatsAppWizard() {
  const [config, setConfig] = useState<WaConfig | null>(null);
  const [configError, setConfigError] = useState("");
  const [step, setStep] = useState(0);
  const [upload, setUpload] = useState<UploadInfo | null>(null);
  const [column, setColumn] = useState(0);
  const [contacts, setContacts] = useState<ContactSummary | null>(null);
  const [provider, setProvider] = useState<WaProviderId>("meta");
  const [template, setTemplate] = useState<WaTemplate | null>(null);
  const [choice, setChoice] = useState<TemplateChoice | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [media, setMedia] = useState<WaMediaInfo | null>(null);
  const [skipRecent, setSkipRecent] = useState(true);
  const [preflight, setPreflight] = useState<Preflight | null>(null);

  const loadConfig = useCallback((first = false) => {
    waApi
      .config()
      .then((c) => {
        setConfig(c);
        if (first) setProvider(c.defaultProvider);
      })
      .catch((err: Error) => setConfigError(err.message));
  }, []);

  useEffect(() => loadConfig(true), [loadConfig]);

  function chooseTemplate(t: WaTemplate, c: TemplateChoice) {
    setTemplate(t);
    setChoice(c);
    setMapping(guessMapping(t, upload?.columns ?? []));
    setMedia(null);
    setPreflight(null);
  }

  function changeProvider(p: WaProviderId) {
    setProvider(p);
    setTemplate(null);
    setChoice(null);
    setPreflight(null);
  }

  function startOver() {
    setUpload(null);
    setContacts(null);
    setPreflight(null);
    setStep(0);
    loadConfig();
  }

  const live = config && (config.providers.meta.configured || config.providers.msg91.configured);

  return (
    <>
      <div className="channel-bar">
        <p className="muted">Send an approved WhatsApp template to every contact, personalized from your file.</p>
        {config && (
          <span className={`pill ${live ? "pill-live" : ""}`}>
            {live
              ? `WhatsApp connected: ${[config.providers.meta.configured && "Meta", config.providers.msg91.configured && "MSG91"].filter(Boolean).join(", ")}`
              : "Simulate only: no WhatsApp keys"}
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
              setPreflight(null);
              if (template) setMapping(guessMapping(template, info.columns));
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
        {step === 2 && config && (
          <TemplateStep
            config={config}
            provider={provider}
            onProviderChange={changeProvider}
            selected={template}
            onSelect={chooseTemplate}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}
        {step === 3 && config && upload && template && choice && (
          <PersonalizeStep
            config={config}
            upload={upload}
            column={column}
            provider={provider}
            template={template}
            choice={choice}
            mapping={mapping}
            onMappingChange={setMapping}
            media={media}
            onMediaChange={setMedia}
            skipRecent={skipRecent}
            onSkipRecentChange={setSkipRecent}
            preflight={preflight}
            onPreflight={setPreflight}
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
          />
        )}
        {step === 4 && config && upload && template && choice && preflight && (
          <WaSendStep
            config={config}
            upload={upload}
            column={column}
            provider={provider}
            template={template}
            choice={choice}
            mapping={mapping}
            media={media}
            skipRecent={skipRecent}
            preflight={preflight}
            onBack={() => setStep(3)}
            onStartOver={startOver}
            onConfigChanged={() => loadConfig()}
          />
        )}
      </main>
    </>
  );
}
