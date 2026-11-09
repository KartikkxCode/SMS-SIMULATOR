import { useRef, useState, type DragEvent } from "react";
import { api, type UploadInfo } from "../api.ts";

const MAX_BYTES = 5 * 1024 * 1024;

export function UploadStep({ onUploaded }: { onUploaded: (info: UploadInfo) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handle(file: File | undefined) {
    if (!file) return;
    setError("");
    if (!/\.(csv|xlsx)$/i.test(file.name)) {
      setError(/\.xls$/i.test(file.name) ? "Old .xls files aren't supported. Save it as .xlsx or .csv first." : "Choose a .csv or .xlsx file.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("The file is larger than 5 MB. Split it into smaller files.");
      return;
    }
    setBusy(true);
    try {
      onUploaded(await api.upload(file));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void handle(e.dataTransfer.files[0]);
  }

  return (
    <section>
      <h2>Upload your contacts</h2>
      <p className="muted">
        A <strong>.csv</strong> or <strong>.xlsx</strong> file whose first row holds column names, with one column of
        phone numbers. Up to 5 MB and 50,000 rows.
      </p>

      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p>{busy ? "Reading file…" : "Drag the file here, or"}</p>
        <button type="button" className="btn primary" disabled={busy} onClick={() => input.current?.click()}>
          Choose file
        </button>
        <input
          ref={input}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          hidden
          onChange={(e) => void handle(e.target.files?.[0])}
        />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <details className="hint">
        <summary>Example layout</summary>
        <table className="table compact">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Asha</td>
              <td>98765 43210</td>
            </tr>
            <tr>
              <td>Ravi</td>
              <td>+91 91234 56789</td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          Numbers can have spaces, dashes, a leading 0 or +91. In Excel, format the phone column as <em>Text</em> so long
          numbers aren't shortened to 9.19877E+11.
        </p>
      </details>
    </section>
  );
}
