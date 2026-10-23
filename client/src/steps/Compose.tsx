import { fillTemplate, smsInfo, templateVariables } from "../sms.ts";

export type Compose = {
  templateId: string;
  /** Template text exactly as approved in MSG91, used for the preview and the length count. */
  template: string;
  variables: Record<string, string>;
};

type Props = {
  value: Compose;
  onChange: (value: Compose) => void;
  recipients: number;
  onBack: () => void;
  onNext: () => void;
};

/** Variable values for the variables the template actually uses. */
export function usedVariables(compose: Compose): Record<string, string> {
  return Object.fromEntries(templateVariables(compose.template).map((name) => [name, compose.variables[name] ?? ""]));
}

export function ComposeStep({ value, onChange, recipients, onBack, onNext }: Props) {
  const names = templateVariables(value.template);
  const message = fillTemplate(value.template, value.variables);
  const info = smsInfo(message);
  const missing = names.filter((n) => !value.variables[n]?.trim());

  return (
    <section>
      <h2>Write the message</h2>
      <p className="muted">
        In India, every SMS must match a template approved on the DLT portal. Create the template in MSG91 (with your sender
        ID), then paste its ID and text here. The text is used for the preview and the length count; MSG91 sends the approved
        template with your variable values filled in.
      </p>

      <div className="compose">
        <div className="compose-form">
          <label className="field">
            <span>MSG91 template ID</span>
            <input
              value={value.templateId}
              onChange={(e) => onChange({ ...value, templateId: e.target.value })}
              placeholder="e.g. 65a1b2c3d4e5f6a7b8c9d0e1"
              spellCheck={false}
            />
            <small className="muted">Required for Live mode. Simulate mode works without it.</small>
          </label>

          <label className="field">
            <span>Template text</span>
            <textarea
              rows={5}
              value={value.template}
              onChange={(e) => onChange({ ...value, template: e.target.value })}
              placeholder="Dear customer, our ##var1## sale starts today. Visit us! - ABC Store"
            />
            <small className="muted">
              Write variables the way MSG91 shows them, e.g. <code>##var1##</code>.
            </small>
          </label>

          {names.length > 0 && (
            <fieldset className="field-group">
              <legend>Variable values (the same for every contact)</legend>
              {names.map((name) => (
                <label key={name} className="field inline">
                  <span className="mono">{name}</span>
                  <input
                    value={value.variables[name] ?? ""}
                    onChange={(e) => onChange({ ...value, variables: { ...value.variables, [name]: e.target.value } })}
                  />
                </label>
              ))}
            </fieldset>
          )}

          <dl className="counter">
            <div>
              <dt>Characters</dt>
              <dd>{info.length}</dd>
            </div>
            <div>
              <dt>Encoding</dt>
              <dd>{info.encoding}</dd>
            </div>
            <div>
              <dt>SMS parts</dt>
              <dd>{info.parts}</dd>
            </div>
            <div>
              <dt>Estimated credits</dt>
              <dd>{(info.parts * recipients).toLocaleString()}</dd>
            </div>
          </dl>
          <p className="muted small">
            {info.encoding === "GSM" ? "160 characters per SMS, 153 per part when longer." : "Hindi, emoji and other symbols use Unicode: 70 characters per SMS, 67 per part."}{" "}
            {info.length > 0 && `${info.remaining} characters left in this part.`}
          </p>
        </div>

        <PhonePreview message={message} />
      </div>

      <div className="actions">
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn primary" disabled={missing.length > 0} onClick={onNext}>
          Next: send
        </button>
      </div>
      {missing.length > 0 && <p className="muted small right">Fill in: {missing.join(", ")}</p>}
    </section>
  );
}

export function PhonePreview({ message }: { message: string }) {
  return (
    <div className="phone" aria-label="Message preview">
      <div className="phone-notch" />
      <div className="phone-sender">Your sender ID</div>
      <div className="phone-screen">
        {message ? <div className="bubble">{message}</div> : <p className="muted small center">Your message preview appears here.</p>}
      </div>
    </div>
  );
}
