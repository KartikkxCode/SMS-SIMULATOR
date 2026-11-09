import { useEffect, useRef, useState } from "react";
import type { UploadInfo } from "../../api.ts";
import {
  paramLabel,
  waApi,
  type Mapping,
  type Preflight,
  type TemplateChoice,
  type WaConfig,
  type WaMediaInfo,
  type WaProviderId,
  type WaTemplate,
} from "./api.ts";
import { WaPreview } from "./WaPreview.tsx";

type Props = {
  config: WaConfig;
  upload: UploadInfo;
  column: number;
  provider: WaProviderId;
  template: WaTemplate;
  choice: TemplateChoice;
  mapping: Mapping;
  onMappingChange: (m: Mapping) => void;
  media: WaMediaInfo | null;
  onMediaChange: (m: WaMediaInfo | null) => void;
  skipRecent: boolean;
  onSkipRecentChange: (v: boolean) => void;
  preflight: Preflight | null;
  onPreflight: (p: Preflight | null) => void;
  onBack: () => void;
  onNext: () => void;
};

const SKIP_LABELS: Record<keyof Preflight["skippedByReason"], string> = {
  values: "missing or invalid values",
  opted_out: "opted out",
  recent: "already got it today",
  over_limit: "over the daily limit",
};

/** Picks a sensible starting mapping: named variables to matching columns, {{1}} to a name column. */
export function guessMapping(template: WaTemplate, columns: string[]): Mapping {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nameColumn = columns.findIndex((c) => /name/i.test(c));
  const mapping: Mapping = {};
  for (const p of template.params) {
    const byName = columns.findIndex((c) => norm(c) === norm(p.name));
    if (byName !== -1) mapping[p.key] = { column: byName };
    else if (p.key === "body.1" && nameColumn !== -1) mapping[p.key] = { column: nameColumn };
    else mapping[p.key] = { fixed: "" };
  }
  return mapping;
}

export function PersonalizeStep(props: Props) {
  const { config, upload, column, provider, template, choice, mapping, media, preflight } = props;
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [sample, setSample] = useState(0);
  const needsMedia = template.header.format === "IMAGE" ? "image" : template.header.format === "DOCUMENT" ? "document" : null;
  const onPreflight = useRef(props.onPreflight);
  onPreflight.current = props.onPreflight;

  // Re-check the contacts whenever the setup changes (debounced).
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    const timer = setTimeout(() => {
      waApi
        .preflight({ provider, mode: "simulate", template: choice, mapping, mediaRef: media?.ref, uploadId: upload.uploadId, column, skipRecent: props.skipRecent })
        .then((p) => {
          if (cancelled) return;
          setError("");
          onPreflight.current(p);
          setSample(0);
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setError(err.message);
          onPreflight.current(null);
        })
        .finally(() => !cancelled && setChecking(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [provider, choice, mapping, media, upload.uploadId, column, props.skipRecent]);

  const current = preflight?.samples[sample];
  const rendered = current?.rendered ?? { header: template.header.text, body: template.body, footer: template.footer, buttons: template.buttons };
  const ready = Boolean(preflight && preflight.ready > 0 && (!needsMedia || media) && !checking);

  return (
    <section>
      <h2>Personalize</h2>
      <p className="muted">
        Choose where each value in <span className="mono">{template.name}</span> comes from: a column of your file (different for
        each contact) or the same text for everyone.
      </p>

      <div className="compose">
        <div className="compose-form">
          {template.params.length === 0 && <p className="note">This template has no variables: everyone gets the same message.</p>}
          {template.params.map((p) => (
            <ParamField
              key={p.key}
              label={paramLabel(p)}
              example={p.example}
              columns={upload.columns}
              value={mapping[p.key] ?? { fixed: "" }}
              onChange={(source) => props.onMappingChange({ ...mapping, [p.key]: source })}
            />
          ))}

          {needsMedia && <MediaField kind={needsMedia} provider={provider} live={config.providers[provider].configured} media={media} onChange={props.onMediaChange} />}

          <label className="check">
            <input type="checkbox" checked={props.skipRecent} onChange={(e) => props.onSkipRecentChange(e.target.checked)} />
            Skip people who already got this template in the last 24 hours
          </label>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {preflight && <PreflightSummary preflight={preflight} checking={checking} />}
        </div>

        <div>
          <WaPreview
            message={rendered}
            headerFormat={template.header.format}
            media={media}
            businessName={config.phone?.verifiedName}
            caption={
              preflight && preflight.samples.length > 0 ? (
                <span className="sample-nav">
                  <button type="button" className="btn small" disabled={sample === 0} onClick={() => setSample((s) => s - 1)} aria-label="Previous contact">
                    ‹
                  </button>
                  <span>
                    Row {current?.row} · {current?.number}
                  </span>
                  <button
                    type="button"
                    className="btn small"
                    disabled={sample >= preflight.samples.length - 1}
                    onClick={() => setSample((s) => s + 1)}
                    aria-label="Next contact"
                  >
                    ›
                  </button>
                </span>
              ) : (
                <span className="muted small">Template text: values appear once they're chosen</span>
              )
            }
          />
        </div>
      </div>

      <div className="actions">
        <button type="button" className="btn" onClick={props.onBack}>
          Back
        </button>
        <button type="button" className="btn primary" disabled={!ready} onClick={props.onNext}>
          Next: send
        </button>
      </div>
    </section>
  );
}

function ParamField(props: {
  label: string;
  example?: string;
  columns: string[];
  value: { column: number } | { fixed: string };
  onChange: (v: { column: number } | { fixed: string }) => void;
}) {
  const { value } = props;
  const selectValue = "column" in value ? String(value.column) : "fixed";
  return (
    <div className="param">
      <label className="field">
        <span>
          <span className="mono">{props.label}</span>
          {props.example && <span className="muted small"> e.g. {props.example}</span>}
        </span>
        <div className="row wrap">
          <select
            value={selectValue}
            onChange={(e) => props.onChange(e.target.value === "fixed" ? { fixed: "" } : { column: Number(e.target.value) })}
            aria-label={`Source for ${props.label}`}
          >
            {props.columns.map((c, i) => (
              <option key={i} value={i}>
                Column: {c}
              </option>
            ))}
            <option value="fixed">Same text for everyone…</option>
          </select>
          {"fixed" in value && (
            <input
              value={value.fixed}
              onChange={(e) => props.onChange({ fixed: e.target.value })}
              placeholder={props.example ?? "Type the value"}
              aria-label={`Text for ${props.label}`}
            />
          )}
        </div>
      </label>
    </div>
  );
}

function MediaField(props: {
  kind: "image" | "document";
  provider: WaProviderId;
  live: boolean;
  media: WaMediaInfo | null;
  onChange: (m: WaMediaInfo | null) => void;
}) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const what = props.kind === "image" ? "image (JPEG or PNG, up to 5 MB)" : "PDF (up to 16 MB)";

  async function run(action: () => Promise<WaMediaInfo>) {
    setBusy(true);
    setError("");
    try {
      props.onChange(await action());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <fieldset className="field-group">
      <legend>Header {props.kind === "image" ? "image" : "document"}</legend>
      {props.media ? (
        <p>
          <strong>{props.media.filename}</strong>{" "}
          <button type="button" className="btn small" onClick={() => props.onChange(null)}>
            Remove
          </button>
        </p>
      ) : (
        <p className="muted small">The same {what} goes to everyone.</p>
      )}
      <div className="row wrap">
        <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Adding…" : "Upload file"}
        </button>
        <input
          ref={input}
          type="file"
          hidden
          accept={props.kind === "image" ? "image/jpeg,image/png" : "application/pdf"}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void run(() => waApi.uploadMedia(file));
          }}
        />
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="or paste a public https:// link" aria-label="Public link to the file" />
        <button type="button" className="btn" disabled={busy || !link.trim()} onClick={() => void run(() => waApi.mediaLink(link.trim(), props.kind))}>
          Use link
        </button>
      </div>
      {props.provider === "msg91" && (
        <p className="muted small">MSG91 needs a public link for live sends. An uploaded file works in Simulate mode only.</p>
      )}
      {error && <p className="error">{error}</p>}
    </fieldset>
  );
}

function PreflightSummary({ preflight, checking }: { preflight: Preflight; checking: boolean }) {
  const reasons = (Object.keys(preflight.skippedByReason) as Array<keyof Preflight["skippedByReason"]>).filter((k) => preflight.skippedByReason[k] > 0);
  return (
    <div aria-live="polite" aria-busy={checking}>
      <div className="stats two">
        <div className="stat good">
          <span className="value">{preflight.ready.toLocaleString()}</span>
          <span className="name">will get the message</span>
        </div>
        <div className="stat warn">
          <span className="value">{preflight.skippedCount.toLocaleString()}</span>
          <span className="name">skipped{reasons.length > 0 && `: ${reasons.map((r) => `${preflight.skippedByReason[r]} ${SKIP_LABELS[r]}`).join(", ")}`}</span>
        </div>
      </div>
      {preflight.warnings.map((w) => (
        <p key={w} className="note">
          {w}
        </p>
      ))}
      {preflight.skippedCount > 0 && (
        <details className="hint">
          <summary>See skipped contacts</summary>
          <div className="table-wrap short" tabIndex={0} role="region" aria-label="Skipped contacts">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Number</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {preflight.skipped.map((s) => (
                  <tr key={`${s.row}-${s.number}`}>
                    <td>{s.row}</td>
                    <td className="mono">{s.number}</td>
                    <td>{s.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small">
            <a href={waApi.skippedCsvUrl(preflight.preflightId)} download>
              Download all skipped contacts (CSV)
            </a>
          </p>
        </details>
      )}
    </div>
  );
}
