import { useEffect, useState } from "react";
import type { UploadInfo } from "../../api.ts";
import { waApi, type Mapping, type Preflight, type TemplateChoice, type WaCampaignView, type WaConfig, type WaMediaInfo, type WaMode, type WaProviderId, type WaTemplate } from "./api.ts";

type Props = {
  config: WaConfig;
  upload: UploadInfo;
  column: number;
  provider: WaProviderId;
  template: WaTemplate;
  choice: TemplateChoice;
  mapping: Mapping;
  media: WaMediaInfo | null;
  skipRecent: boolean;
  preflight: Preflight;
  onBack: () => void;
  onStartOver: () => void;
  onConfigChanged: () => void;
};

const STATUS_TEXT: Record<WaCampaignView["status"], string> = {
  running: "Sending…",
  completed: "Finished",
  completed_with_errors: "Finished with errors",
  failed: "Failed",
  cancelled: "Stopped",
};

const money = (n: number) => `₹${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function WaSendStep(props: Props) {
  const { config, provider, template, preflight } = props;
  const liveReady = config.providers[provider].configured;
  const [mode, setMode] = useState<WaMode>("simulate");
  const [optIn, setOptIn] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<WaCampaignView | null>(null);

  const setup = { provider, mode, template: props.choice, mapping: props.mapping, mediaRef: props.media?.ref };
  const liveBlocked = mode === "live" && !optIn;
  const cost = preflight.estimate.cost;

  useEffect(() => {
    if (!campaignId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let finishedOnce = false;
    const poll = async () => {
      try {
        const c = await waApi.campaign(campaignId);
        if (stopped) return;
        setCampaign(c);
        if (c.status === "running") {
          timer = setTimeout(poll, 1000);
          return;
        }
        if (!finishedOnce) props.onConfigChanged();
        finishedOnce = true;
        // Delivery receipts keep arriving after sending ends, so keep the counts fresh.
        if (config.webhookEnabled && c.mode === "live") timer = setTimeout(poll, 5000);
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
      const { id } = await waApi.startCampaign({
        ...setup,
        uploadId: props.upload.uploadId,
        column: props.column,
        skipRecent: props.skipRecent,
        optInConfirmed: optIn,
      });
      setCampaign(null);
      setCampaignId(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function resend() {
    if (!campaign) return;
    setError("");
    try {
      const { id } = await waApi.resend(campaign.id, optIn);
      setCampaign(null);
      setCampaignId(id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (campaignId) {
    return (
      <Progress
        campaign={campaign}
        error={error}
        webhookEnabled={config.webhookEnabled}
        onCancel={() => waApi.cancel(campaignId).catch((err: Error) => setError(err.message))}
        onResend={() => void resend()}
        resendNeedsOptIn={campaign?.mode === "live" && !optIn}
        onOptIn={setOptIn}
        optIn={optIn}
        onBackToOptions={() => {
          setCampaignId(null);
          setCampaign(null);
        }}
        onStartOver={props.onStartOver}
      />
    );
  }

  const used = config.usedLast24h;
  const limit = config.dailyLimit;

  return (
    <section>
      <h2>Send</h2>
      <dl className="summary">
        <div>
          <dt>Template</dt>
          <dd className="mono">{template.name}</dd>
        </div>
        <div>
          <dt>Will get it</dt>
          <dd>{preflight.ready.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Skipped</dt>
          <dd>{preflight.skippedCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Estimated cost</dt>
          <dd>{cost !== undefined ? money(cost) : <span className="muted small">set WHATSAPP_PRICE_PER_MESSAGE</span>}</dd>
        </div>
      </dl>

      {limit > 0 && (
        <div className="limit-meter">
          <div className="row between small">
            <span>New contacts in the last 24 hours (from this app)</span>
            <span>
              {used.toLocaleString()} used of {limit.toLocaleString()}
            </span>
          </div>
          <div className="progress" role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit} aria-label="Daily limit used">
            <div className="progress-bar" style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
          </div>
        </div>
      )}

      <fieldset className="modes">
        <legend>Mode</legend>
        <label className={`mode ${mode === "simulate" ? "selected" : ""}`}>
          <input type="radio" name="wa-mode" checked={mode === "simulate"} onChange={() => setMode("simulate")} />
          <strong>Simulate</strong>
          <span className="muted small">A dry run with the same checks: nothing is sent and nothing is charged. You'll see exactly what WhatsApp would receive.</span>
        </label>
        <label className={`mode ${mode === "live" ? "selected live" : ""} ${liveReady ? "" : "disabled"}`}>
          <input type="radio" name="wa-mode" checked={mode === "live"} disabled={!liveReady} onChange={() => setMode("live")} />
          <strong>Live</strong>
          <span className="muted small">
            {liveReady
              ? `Sends real WhatsApp messages through ${provider === "meta" ? "Meta" : "MSG91"}. You're charged per delivered message.`
              : `Add your ${provider === "meta" ? "Meta" : "MSG91"} WhatsApp settings to .env and restart the app to turn this on.`}
          </span>
        </label>
      </fieldset>

      {mode === "live" && (
        <label className="check optin">
          <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
          These contacts agreed to get WhatsApp messages from my business. (WhatsApp requires this; messaging people who didn't
          agree gets numbers blocked.)
        </label>
      )}

      <TestSend setup={setup} sample={preflight.samples[0]} disabled={mode === "live" && !liveReady} mode={mode} />

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="actions">
        <button type="button" className="btn" onClick={props.onBack}>
          Back
        </button>
        <button
          type="button"
          className={`btn ${mode === "live" ? "danger" : "primary"}`}
          disabled={starting || liveBlocked || preflight.ready === 0}
          onClick={() => (mode === "live" ? setConfirming(true) : void start())}
        >
          {mode === "live" ? `Send ${preflight.ready.toLocaleString()} WhatsApp messages` : "Run simulation"}
        </button>
      </div>

      {confirming && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="wa-confirm-title">
          <div className="dialog">
            <h3 id="wa-confirm-title">Send real WhatsApp messages?</h3>
            <p>
              This sends <strong className="mono">{template.name}</strong> to <strong>{preflight.ready.toLocaleString()}</strong> people
              through {provider === "meta" ? "Meta" : "MSG91"}
              {cost !== undefined && (
                <>
                  , costing about <strong>{money(cost)}</strong>
                </>
              )}
              . It can't be undone.
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

function TestSend(props: {
  setup: { provider: WaProviderId; mode: WaMode; template: TemplateChoice; mapping: Mapping; mediaRef?: string };
  sample?: Preflight["samples"][number];
  disabled: boolean;
  mode: WaMode;
}) {
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function send() {
    if (!props.sample) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await waApi.testSend({ ...props.setup, number, values: props.sample.values });
      setResult({
        ok: true,
        text: r.mode === "live" ? `Sent to ${r.number} (message ID ${r.messageId}). Check WhatsApp on that phone.` : `Simulated for ${r.number}. Nothing was sent.`,
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
        <span>Send a test to your own number first</span>
        <div className="row">
          <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Your WhatsApp number" inputMode="tel" />
          <button type="button" className="btn" disabled={busy || !number.trim() || props.disabled || !props.sample} onClick={() => void send()}>
            {busy ? "Sending…" : props.mode === "live" ? "Send test" : "Simulate test"}
          </button>
        </div>
        {props.sample && <small className="muted">Uses the values of row {props.sample.row} ({props.sample.number}).</small>}
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
  campaign: WaCampaignView | null;
  error: string;
  webhookEnabled: boolean;
  onCancel: () => void;
  onResend: () => void;
  resendNeedsOptIn: boolean;
  optIn: boolean;
  onOptIn: (v: boolean) => void;
  onBackToOptions: () => void;
  onStartOver: () => void;
}) {
  const { campaign: c, error } = props;
  if (!c) return <p className="muted">{error || "Starting…"}</p>;

  const sendable = c.counts.total - c.counts.skipped;
  const done = sendable - c.counts.pending;
  const percent = sendable ? Math.round((done / sendable) * 100) : 100;
  const running = c.status === "running";
  const simulate = c.mode === "simulate";

  return (
    <section>
      <h2>
        {simulate ? "Simulation" : "Live send"}: {STATUS_TEXT[c.status]}
      </h2>
      <p className="muted">
        <span className="mono">{c.template.name}</span> · {c.provider === "meta" ? "Meta" : "MSG91"}
        {c.parentId && " · sending to the rest of an earlier campaign"}
        {simulate && " · nothing was sent and nothing was charged"}
      </p>

      <div className="progress" role="progressbar" aria-label="Sending progress" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className={`progress-bar ${c.status}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="small muted">
        {done.toLocaleString()} of {sendable.toLocaleString()} processed ({percent}%)
        {running && c.rate > 0 && ` · ${c.rate} per second`}
        {running && c.etaSeconds !== undefined && ` · about ${formatEta(c.etaSeconds)} left`}
      </p>

      <div className="stats four">
        <Stat tone="good" value={c.counts.accepted} label={simulate ? "simulated" : "accepted by WhatsApp"} />
        <Stat tone="bad" value={c.counts.failed} label="failed" />
        <Stat tone="warn" value={c.counts.unknown + c.counts.notSent} label={c.counts.unknown ? `not sent / unknown (${c.counts.unknown})` : "not sent"} />
        <Stat tone="" value={c.counts.skipped} label="skipped" />
      </div>

      {c.stopReason && <p className="error">{c.stopReason}</p>}
      {error && <p className="error">{error}</p>}
      {!simulate && !running && c.counts.accepted > 0 && (
        <p className="muted small">
          "Accepted" means WhatsApp took the message. Delivery and read status{" "}
          {props.webhookEnabled ? "arrive below as receipts come in" : "are in WhatsApp Manager (or turn on delivery receipts, see the README)"}.
        </p>
      )}
      {c.counts.unknown > 0 && (
        <p className="note">
          {c.counts.unknown} message(s) got no answer, so they may or may not have been sent. They aren't retried automatically, to avoid
          sending twice. Check them in WhatsApp Manager.
        </p>
      )}

      {props.webhookEnabled && !simulate && (
        <dl className="summary">
          {(["sent", "delivered", "read", "failed"] as const).map((k) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{c.deliveries[k].toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      )}

      {c.errors.length > 0 && (
        <>
          <h3>What went wrong</h3>
          <div className="table-wrap short" tabIndex={0} role="region" aria-label="What went wrong">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Contacts</th>
                  <th>Code</th>
                  <th>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {c.errors.map((e) => (
                  <tr key={`${e.state}-${e.code}-${e.message}`}>
                    <td>{e.count}</td>
                    <td className="mono">{e.code ?? (e.state === "unknown" ? "?" : "")}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {c.samplePayload !== undefined && (
        <details className="hint" open={simulate}>
          <summary>{simulate ? "Request that would be sent" : "Request sent"} (first message)</summary>
          <pre className="code" tabIndex={0} aria-label="Request body">{JSON.stringify(c.samplePayload, null, 2)}</pre>
        </details>
      )}

      {!running && c.resendable > 0 && (
        <div className="note">
          <p>
            <strong>{c.resendable}</strong> contact(s) can be tried again (not reached, over the daily limit, or failed for a reason that may
            pass).
          </p>
          {props.resendNeedsOptIn && (
            <label className="check">
              <input type="checkbox" checked={props.optIn} onChange={(e) => props.onOptIn(e.target.checked)} />
              These contacts agreed to get WhatsApp messages from my business.
            </label>
          )}
          <button type="button" className="btn primary" disabled={props.resendNeedsOptIn} onClick={props.onResend}>
            Send to the rest ({c.resendable})
          </button>
        </div>
      )}

      <div className="actions">
        {running ? (
          <button type="button" className="btn danger" onClick={props.onCancel}>
            Stop sending
          </button>
        ) : (
          <>
            <a className="btn" href={waApi.reportCsvUrl(c.id)} download>
              Download report (CSV)
            </a>
            <button type="button" className="btn" onClick={props.onBackToOptions}>
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

function Stat({ tone, value, label }: { tone: string; value: number; label: string }) {
  return (
    <div className={`stat ${tone}`}>
      <span className="value">{value.toLocaleString()}</span>
      <span className="name">{label}</span>
    </div>
  );
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
