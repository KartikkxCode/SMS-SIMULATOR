import { useRef, useState } from "react";
import { api, type UploadInfo } from "../api.ts";
import { isBlank, parseContactLines, type TypedContact } from "./manualContacts.ts";

export const MAX_TYPED = 1000;

type Row = TypedContact & { id: number };

/** Lets people type or paste names and numbers instead of uploading a file. */
export function ManualContacts({ onUploaded }: { onUploaded: (info: UploadInfo) => void }) {
  const nextId = useRef(4);
  const [rows, setRows] = useState<Row[]>([1, 2, 3].map((id) => ({ id, name: "", phone: "" })));
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const filled = rows.filter((r) => !isBlank(r));
  const newRow = (c: TypedContact = { name: "", phone: "" }): Row => ({ id: nextId.current++, ...c });
  const update = (id: number, patch: Partial<TypedContact>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  function addPasted() {
    const parsed = parseContactLines(paste);
    if (parsed.length === 0) return;
    const combined = [...rows.filter((r) => !isBlank(r)), ...parsed.map((c) => newRow(c))];
    if (combined.length > MAX_TYPED) {
      setError(`That makes ${combined.length} contacts. You can type up to ${MAX_TYPED}; for more, upload a file.`);
      return;
    }
    setError("");
    setRows(combined);
    setPaste("");
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      onUploaded(await api.uploadManual(filled.map(({ name, phone }) => ({ name, phone }))));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="manual-contacts">
      <div className="typed-rows">
        {/* Visual headings only: every input has its own label. */}
        <div className="typed-row typed-head" aria-hidden="true">
          <span>Name</span>
          <span>Mobile number</span>
          <span />
        </div>
        {rows.map((r, i) => (
          <div className="typed-row" key={r.id}>
            <input value={r.name} onChange={(e) => update(r.id, { name: e.target.value })} placeholder={i === 0 ? "Asha" : undefined} aria-label={`Name ${i + 1}`} maxLength={100} />
            <input
              value={r.phone}
              onChange={(e) => update(r.id, { phone: e.target.value })}
              placeholder={i === 0 ? "98765 43210" : undefined}
              aria-label={`Number ${i + 1}`}
              inputMode="tel"
              maxLength={30}
            />
            <button
              type="button"
              className="btn small"
              aria-label={`Remove row ${i + 1}`}
              disabled={rows.length === 1}
              onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn" disabled={rows.length >= MAX_TYPED} onClick={() => setRows((rs) => [...rs, newRow()])}>
        + Add row
      </button>

      <details className="hint">
        <summary>Paste a list</summary>
        <p className="muted small">
          One contact per line, like <code>Asha, 98765 43210</code> or just the number. You can also copy two columns straight from
          Excel.
        </p>
        <textarea rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} aria-label="Pasted contacts" placeholder={"Asha, 98765 43210\nRavi, +91 91234 56789"} />
        <button type="button" className="btn" disabled={!paste.trim()} onClick={addPasted}>
          Add to the list
        </button>
      </details>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn primary" disabled={busy || filled.length === 0} onClick={() => void submit()}>
          {busy ? "Checking…" : `Use these contacts (${filled.length})`}
        </button>
      </div>
    </div>
  );
}
