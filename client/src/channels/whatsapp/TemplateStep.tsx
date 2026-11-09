import { useEffect, useState } from "react";
import { waApi, type ManualTemplate, type TemplateChoice, type WaConfig, type WaProviderId, type WaTemplate } from "./api.ts";

type Props = {
  config: WaConfig;
  provider: WaProviderId;
  onProviderChange: (p: WaProviderId) => void;
  selected: WaTemplate | null;
  onSelect: (template: WaTemplate, choice: TemplateChoice) => void;
  onBack: () => void;
  onNext: () => void;
};

const PROVIDERS: Array<{ id: WaProviderId; name: string; detail: string }> = [
  { id: "meta", name: "Meta Cloud API", detail: "Direct from Meta, per-message Meta pricing" },
  { id: "msg91", name: "MSG91 WhatsApp", detail: "Through your MSG91 account" },
];

const HEADER_ICON: Record<string, string> = { IMAGE: "🖼", DOCUMENT: "📄", TEXT: "T", NONE: "" };

export function TemplateStep({ config, provider, onProviderChange, selected, onSelect, onBack, onNext }: Props) {
  const [list, setList] = useState<{ source: string; templates: WaTemplate[] } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [manualOpen, setManualOpen] = useState(false);

  async function load(refresh = false) {
    setLoading(true);
    setError("");
    try {
      setList(await waApi.templates(provider, refresh));
    } catch (err) {
      setList(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [provider]);

  const q = search.trim().toLowerCase();
  const shown = (list?.templates ?? []).filter((t) => !q || t.name.includes(q) || t.body.toLowerCase().includes(q));
  const live = config.providers[provider].configured;

  return (
    <section>
      <h2>Choose a template</h2>
      <p className="muted">
        WhatsApp only lets businesses start a conversation with a <strong>template that Meta has approved</strong>. Create
        templates in WhatsApp Manager (or MSG91), wait for approval, then pick one here.
      </p>

      <fieldset className="modes">
        <legend>Send through</legend>
        {PROVIDERS.map((p) => (
          <label key={p.id} className={`mode ${provider === p.id ? "selected" : ""}`}>
            <input type="radio" name="wa-provider" checked={provider === p.id} onChange={() => onProviderChange(p.id)} />
            <strong>
              {p.name}{" "}
              <span className={`badge ${config.providers[p.id].configured ? "submitted" : ""}`}>
                {config.providers[p.id].configured ? "connected" : "not set up"}
              </span>
            </strong>
            <span className="muted small">
              {p.detail}
              {!config.providers[p.id].configured && ". Simulate mode only until it's set up in .env."}
            </span>
          </label>
        ))}
      </fieldset>

      {provider === "meta" && (config.phone || config.phoneError) && <PhoneHealth config={config} />}

      <div className="row wrap">
        <input type="search" placeholder="Search templates" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search templates" />
        <button type="button" className="btn" onClick={() => void load(true)} disabled={loading || !live}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {list?.source === "demo" && (
        <p className="note">
          These are <strong>demo templates</strong> to try Simulate mode. Your own approved templates appear here once{" "}
          {provider === "meta" ? "your Meta" : "your MSG91 WhatsApp"} settings are in <code>.env</code>.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <ul className="template-list" aria-busy={loading}>
        {shown.map((t) => (
          <li key={t.ref}>
            <button
              type="button"
              className={`template ${selected?.ref === t.ref ? "selected" : ""}`}
              disabled={!t.supported}
              aria-pressed={selected?.ref === t.ref}
              onClick={() => onSelect(t, { ref: t.ref })}
            >
              <span className="template-top">
                <strong className="mono">{t.name}</strong>
                <span className="badge">{t.language}</span>
                <span className={`badge cat-${t.category.toLowerCase()}`}>{t.category.toLowerCase()}</span>
                {HEADER_ICON[t.header.format] && (
                  <span className="badge" title={`${t.header.format.toLowerCase()} header`}>
                    {HEADER_ICON[t.header.format]} {t.header.format.toLowerCase()}
                  </span>
                )}
                {t.params.length > 0 && <span className="muted small">{t.params.length} variable(s)</span>}
              </span>
              <span className="template-body">{t.body}</span>
              {!t.supported && <span className="error-text small">{t.unsupportedReason}</span>}
            </button>
          </li>
        ))}
        {list && shown.length === 0 && <li className="muted">No templates match.</li>}
      </ul>

      <details className="hint" open={manualOpen} onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Template not listed? Type it in by hand</summary>
        <ManualForm provider={provider} onUse={onSelect} />
      </details>

      <div className="actions">
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn primary" disabled={!selected?.supported} onClick={onNext}>
          Next: personalize
        </button>
      </div>
    </section>
  );
}

function PhoneHealth({ config }: { config: WaConfig }) {
  if (config.phoneError) return <p className="note">Couldn't read your WhatsApp number's status: {config.phoneError}</p>;
  const p = config.phone!;
  const quality = (p.quality ?? "UNKNOWN").toUpperCase();
  return (
    <dl className="summary">
      <div>
        <dt>WhatsApp number</dt>
        <dd>{p.displayNumber ?? "—"}</dd>
      </div>
      <div>
        <dt>Business name</dt>
        <dd>{p.verifiedName ?? "—"}</dd>
      </div>
      <div>
        <dt>Quality</dt>
        <dd>
          <span className={`badge quality-${quality.toLowerCase()}`}>{quality.toLowerCase()}</span>
        </dd>
      </div>
      <div>
        <dt>Limit per 24 h</dt>
        <dd>{config.dailyLimit === 0 ? "Unlimited" : config.dailyLimit.toLocaleString()}</dd>
      </div>
    </dl>
  );
}

const EMPTY_MANUAL: ManualTemplate = { name: "", language: "en", category: "MARKETING", headerFormat: "NONE", body: "" };

function ManualForm({ provider, onUse }: { provider: WaProviderId; onUse: Props["onSelect"] }) {
  const [form, setForm] = useState<ManualTemplate>(EMPTY_MANUAL);
  const [error, setError] = useState("");
  const set = (patch: Partial<ManualTemplate>) => setForm((f) => ({ ...f, ...patch }));

  async function use() {
    setError("");
    const manual: ManualTemplate = {
      ...form,
      headerText: form.headerFormat === "TEXT" ? form.headerText : undefined,
      footer: form.footer || undefined,
      namespace: form.namespace || undefined,
    };
    try {
      onUse(await waApi.manualTemplate(manual), { manual });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="manual-form">
      <p className="muted small">Copy these exactly from the approved template, or WhatsApp will reject the messages.</p>
      <div className="grid-2">
        <label className="field">
          <span>Template name</span>
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="festival_offer" spellCheck={false} />
        </label>
        <label className="field">
          <span>Language code</span>
          <input value={form.language} onChange={(e) => set({ language: e.target.value })} placeholder="en, hi, en_US" spellCheck={false} />
        </label>
        <label className="field">
          <span>Category</span>
          <select value={form.category} onChange={(e) => set({ category: e.target.value as ManualTemplate["category"] })}>
            <option value="MARKETING">Marketing</option>
            <option value="UTILITY">Utility</option>
          </select>
        </label>
        <label className="field">
          <span>Header</span>
          <select value={form.headerFormat} onChange={(e) => set({ headerFormat: e.target.value as ManualTemplate["headerFormat"] })}>
            <option value="NONE">None</option>
            <option value="TEXT">Text</option>
            <option value="IMAGE">Image</option>
            <option value="DOCUMENT">Document (PDF)</option>
          </select>
        </label>
      </div>
      {form.headerFormat === "TEXT" && (
        <label className="field">
          <span>Header text</span>
          <input value={form.headerText ?? ""} onChange={(e) => set({ headerText: e.target.value })} maxLength={60} />
        </label>
      )}
      <label className="field">
        <span>Body</span>
        <textarea rows={4} value={form.body} onChange={(e) => set({ body: e.target.value })} placeholder="Hi {{1}}! Our {{2}} sale is live." />
      </label>
      <label className="field">
        <span>Footer (optional)</span>
        <input value={form.footer ?? ""} onChange={(e) => set({ footer: e.target.value })} maxLength={60} />
      </label>
      {provider === "msg91" && (
        <label className="field">
          <span>Namespace (MSG91, if your template has one)</span>
          <input value={form.namespace ?? ""} onChange={(e) => set({ namespace: e.target.value })} spellCheck={false} />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button type="button" className="btn" onClick={() => void use()} disabled={!form.name || !form.body}>
        Use this template
      </button>
    </div>
  );
}
