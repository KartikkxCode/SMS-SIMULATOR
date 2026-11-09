/** Builds CSV text that opens correctly in Excel. */
export function toCsv(header: string[], rows: Array<Array<string | number | undefined>>): string {
  const lines = [header, ...rows].map((cells) => cells.map(csvCell).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

function csvCell(value: string | number | undefined): string {
  let s = value === undefined ? "" : String(value);
  // Stop spreadsheet apps from running text such as "=HYPERLINK(...)" as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
