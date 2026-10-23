import { useEffect, useState } from "react";
import { api, type ContactSummary, type UploadInfo } from "../api.ts";

type Props = {
  upload: UploadInfo;
  column: number;
  onColumnChange: (column: number) => void;
  contacts: ContactSummary | null;
  onContacts: (summary: ContactSummary | null) => void;
  onBack: () => void;
  onNext: () => void;
};

const SHOWN_PROBLEMS = 50;

export function ContactsStep({ upload, column, onColumnChange, contacts, onContacts, onBack, onNext }: Props) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    api
      .contacts(upload.uploadId, column)
      .then((summary) => !cancelled && onContacts(summary))
      .catch((err: Error) => {
        if (cancelled) return;
        onContacts(null);
        setError(err.message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [upload.uploadId, column, onContacts]);

  const problems = contacts
    ? [
        ...contacts.invalid.map((c) => ({ row: c.row, value: c.value, problem: c.reason })),
        ...contacts.duplicates.map((c) => ({ row: c.row, value: c.number, problem: `Duplicate of row ${c.firstRow} (sent once)` })),
      ].sort((a, b) => a.row - b.row)
    : [];
  const problemCount = contacts ? contacts.invalidCount + contacts.duplicateCount : 0;

  return (
    <section>
      <h2>Check contacts</h2>
      <p className="muted">
        <strong>{upload.fileName}</strong> · {upload.rowCount.toLocaleString()} rows
      </p>

      <label className="field">
        <span>Which column has the phone numbers?</span>
        <select value={column} onChange={(e) => onColumnChange(Number(e.target.value))}>
          {upload.columns.map((name, i) => (
            <option key={i} value={i}>
              {name}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="stats" aria-live="polite" aria-busy={loading}>
        <div className="stat good">
          <span className="value">{contacts ? contacts.validCount.toLocaleString() : "…"}</span>
          <span className="name">will receive the SMS</span>
        </div>
        <div className="stat bad">
          <span className="value">{contacts ? contacts.invalidCount.toLocaleString() : "…"}</span>
          <span className="name">invalid numbers</span>
        </div>
        <div className="stat warn">
          <span className="value">{contacts ? contacts.duplicateCount.toLocaleString() : "…"}</span>
          <span className="name">duplicates removed</span>
        </div>
      </div>

      <h3>File preview</h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {upload.columns.map((name, i) => (
                <th key={i} className={i === column ? "highlight" : ""}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {upload.preview.map((row, r) => (
              <tr key={r}>
                {row.map((cell, i) => (
                  <td key={i} className={i === column ? "highlight" : ""}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {upload.rowCount > upload.preview.length && (
        <p className="muted small">Showing the first {upload.preview.length} rows.</p>
      )}

      {contacts && problemCount > 0 && (
        <>
          <h3>Skipped rows</h3>
          <div className="table-wrap short">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Value</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {problems.slice(0, SHOWN_PROBLEMS).map((p) => (
                  <tr key={`${p.row}-${p.problem}`}>
                    <td>{p.row}</td>
                    <td className="mono">{p.value || <em className="muted">empty</em>}</td>
                    <td>{p.problem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small">
            {problemCount > SHOWN_PROBLEMS && <span className="muted">Showing {SHOWN_PROBLEMS} of {problemCount}. </span>}
            <a href={api.problemsCsvUrl(upload.uploadId, column)} download>
              Download all skipped rows (CSV)
            </a>
          </p>
        </>
      )}

      <div className="actions">
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn primary" disabled={!contacts || contacts.validCount === 0 || loading} onClick={onNext}>
          Next: write message
        </button>
      </div>
    </section>
  );
}
