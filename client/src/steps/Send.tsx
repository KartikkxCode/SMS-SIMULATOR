import { useEffect, useState } from "react";
import { api, type AppConfig, type CampaignView, type SendMode, type UploadInfo } from "../api.ts";
import { fillTemplate, smsInfo } from "../sms.ts";
import { usedVariables, type Compose } from "./Compose.tsx";

type Props = {
  config: AppConfig;
  upload: UploadInfo;
  column: number;
  recipients: number;
  compose: Compose;
  onBack: () => void;
  onStartOver: () => void;
};

const STATUS_TEXT: Record<CampaignView["status"], string> = {
  running: "Sending…",
  completed: "Finished",
  completed_with_errors: "Finished with errors",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function SendStep({ config, upload, column, recipients, compose, onBack, onStartOver }: Props) {
  const [mode, setMode] = useState<SendMode>("simulate");
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<CampaignView | null>(null);

  const message = fillTemplate(compose.template, compose.variables);
  const parts = Math.max(smsInfo(message).parts, 1);
  const variables = usedVariables(compose);
  const templateId = compose.templateId.trim();
  const liveBlocked = mode === "live" && !templateId;

  useEffect(() => {
    if (!campaignId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const c = await api.campaign(campaignId);
        if (stopped) return;
        setCampaign(c);
        if (c.status === "running") timer = setTimeout(poll, 1000);
      } catch (err) {
        if (!stopped) setError((err as Error).message);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [campaignId]);

  async function start() {
    setConfirming(false);
    setStarting(true);
    setError("");
    try {
      const { id } = await api.startCampaign({ uploadId: upload.uploadId, column, mode, templateId, variables, message });
      setCampaignId(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  if (campaignId) {
    return (
      <Progress
        campaign={campaign}
        error={error}
        onCancel={() => api.cancelCampaign(campaignId).catch((err: Error) => setError(err.message))}
        onSendAgain={() => {
          setCampaignId(null);
          setCampaign(null);
        }}
        onStartOver={onStartOver}
      />
    );
  }

  return (
    <section>
      <h2>Send</h2>

      <dl className="summary">
        <div>
          <dt>File</dt>
          <dd>{upload.fileName}</dd>
        </div>
        <div>
          <dt>Recipients</dt>
          <dd>{recipients.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Template ID</dt>
          <dd className="mono">{templateId || <em className="muted">none</em>}</dd>
        </div>
        <div>
          <dt>Estimated credits</dt>
          <dd>
            {(recipients * parts).toLocaleString()} <span className="muted small">({parts} SMS each)</span>
          </dd>
        </div>
      </dl>

      <fieldset className="modes">
        <legend>Mode</legend>
        <label className={`mode ${mode === "simulate" ? "selected" : ""}`}>
          <input type="radio" name="mode" checked={mode === "simulate"} onChange={() => setMode("simulate")} />
          <strong>Simulate</strong>
          <span className="muted small">A dry run: nothing is sent and nothing is charged. You'll see exactly what MSG91 would receive.</span>
        </label>
        <label className={`mode ${mode === "live" ? "selected live" : ""} ${config.liveAvailable ? "" : "disabled"}`}>
          <input type="radio" name="mode" checked={mode === "live"} disabled={!config.liveAvailable} onChange={() => setMode("live")} />
          <strong>Live</strong>
          <span className="muted small">
            {config.liveAvailable
              ? "Sends real SMS through MSG91 and uses your credits."
              : "Add MSG91_AUTH_KEY to the .env file and restart the app to turn this on."}
          </span>
        </label>
      </fieldset>

      {liveBlocked && <p className="error">Go back and enter the MSG91 template ID to send live.</p>}

      <TestSend mode={mode} templateId={templateId} variables={variables} disabled={liveBlocked} />

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="actions">
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className={`btn ${mode === "live" ? "danger" : "primary"}`}
          disabled={starting || liveBlocked}
          onClick={() => (mode === "live" ? setConfirming(true) : void start())}
        >
          {mode === "live" ? `Send ${recipients.toLocaleString()} SMS` : "Run simulation"}
        </button>
      </div>

      {confirming && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div className="dialog">
            <h3 id="confirm-title">Send real SMS?</h3>
            <p>
              This sends the message to <strong>{recipients.toLocaleString()}</strong> numbers through MSG91 and uses about{" "}
              <strong>{(recipients * parts).toLocaleString()}</strong> credits. It can't be undone.
            </p>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setConfirming(false)} autoFocus>
                Cancel
              </button>
              <button type="button" className="btn danger" onClick={() => void start()}>
                Yes, send now
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function TestSend(props: { mode: SendMode; templateId: string; variables: Record<string, string>; disabled: boolean }) {
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.testSend({ mode: props.mode, templateId: props.templateId, variables: props.variables, number });
      setResult({
        ok: true,
        text:
          props.mode === "live"
            ? `Sent to ${r.number}. MSG91 request ID: ${r.requestId}. Check your phone.`
            : `Simulated for ${r.number} (${r.requestId}). Nothing was sent.`,
      });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="test-send">
      <label className="field">
        <span>Send a test to one number first</span>
        <div className="row">
          <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Your mobile number" inputMode="tel" />
          <button type="button" className="btn" disabled={busy || !number.trim() || props.disabled} onClick={() => void send()}>
            {busy ? "Sending…" : props.mode === "live" ? "Send test SMS" : "Simulate test"}
          </button>
        </div>
      </label>
      {result && (
        <p className={result.ok ? "success" : "error"} role="status">
          {result.text}
        </p>
      )}
    </div>
  );
}

function Progress(props: {
  campaign: CampaignView | null;
  error: string;
  onCancel: () => void;
  onSendAgain: () => void;
  onStartOver: () => void;
}) {
  const { campaign: c, error } = props;
  if (!c) return <p className="muted">{error || "Starting…"}</p>;

  const done = c.counts.submitted + c.counts.failed + c.counts.notSent;
  const percent = c.counts.total ? Math.round((done / c.counts.total) * 100) : 0;
  const running = c.status === "running";

  return (
    <section>
      <h2>
        {c.mode === "simulate" ? "Simulation" : "Live send"}: {STATUS_TEXT[c.status]}
      </h2>
      {c.mode === "simulate" && <p className="muted">Simulate mode: no SMS were sent and no credits were used.</p>}

      <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className={`progress-bar ${c.status}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="small muted">
        {done.toLocaleString()} of {c.counts.total.toLocaleString()} processed ({percent}%)
      </p>

      <div className="stats">
        <div className="stat good">
          <span className="value">{c.counts.submitted.toLocaleString()}</span>
          <span className="name">{c.mode === "simulate" ? "simulated" : "submitted to MSG91"}</span>
        </div>
        <div className="stat bad">
          <span className="value">{c.counts.failed.toLocaleString()}</span>
          <span className="name">failed</span>
        </div>
        <div className="stat warn">
          <span className="value">{c.counts.notSent.toLocaleString()}</span>
          <span className="name">not sent</span>
        </div>
      </div>

      {c.stopReason && <p className="error">{c.stopReason}</p>}
      {error && <p className="error">{error}</p>}
      {c.mode === "live" && !running && c.counts.submitted > 0 && (
        <p className="muted small">
          "Submitted" means MSG91 accepted the numbers. Final delivery status for each number is in your MSG91 dashboard under
          Reports.
        </p>
      )}

      <h3>Batches</h3>
      <div className="table-wrap short">
        <table className="table compact">
          <thead>
            <tr>
              <th>#</th>
              <th>Numbers</th>
              <th>Status</th>
              <th>Tries</th>
              <th>Request ID / error</th>
            </tr>
          </thead>
          <tbody>
            {c.batches.map((b) => (
              <tr key={b.index}>
                <td>{b.index}</td>
                <td>{b.size}</td>
                <td>
                  <span className={`badge ${b.status}`}>{b.status.replace("_", " ")}</span>
                </td>
                <td>{b.attempts || ""}</td>
                <td className={b.error ? "error-text" : "mono"}>{b.error ?? b.requestId ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {c.samplePayload && (
        <details className="hint" open={c.mode === "simulate"}>
          <summary>{c.mode === "simulate" ? "Request that would be sent to MSG91" : "Request sent to MSG91"} (batch 1)</summary>
          <pre className="code">
            {`POST https://control.msg91.com/api/v5/flow\nauthkey: ••••••••\n\n${JSON.stringify(c.samplePayload, null, 2)}`}
          </pre>
          {c.samplePayloadRecipients > c.samplePayload.recipients.length && (
            <p className="muted small">
              Showing {c.samplePayload.recipients.length} of {c.samplePayloadRecipients} recipients in this batch.
            </p>
          )}
        </details>
      )}

      <div className="actions">
        {running ? (
          <button type="button" className="btn danger" onClick={props.onCancel}>
            Stop sending
          </button>
        ) : (
          <>
            <a className="btn" href={api.reportCsvUrl(c.id)} download>
              Download report (CSV)
            </a>
            <button type="button" className="btn" onClick={props.onSendAgain}>
              Back to send options
            </button>
            <button type="button" className="btn primary" onClick={props.onStartOver}>
              New campaign
            </button>
          </>
        )}
      </div>
    </section>
  );
}
