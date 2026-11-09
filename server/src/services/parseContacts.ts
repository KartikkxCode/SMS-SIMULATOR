import path from "node:path";
import ExcelJS from "exceljs";
import Papa from "papaparse";

export const MAX_ROWS = 50_000;

export type ParsedSheet = {
  columns: string[];
  /** Cell text for each data row, in the same order as `columns`. */
  rows: string[][];
  /** Spreadsheet row number of each data row (the header is row 1). */
  rowNumbers: number[];
};

export class FileFormatError extends Error {}

export async function parseContactsFile(fileName: string, data: Buffer): Promise<ParsedSheet> {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".csv" || ext === ".txt") return fromGrid(parseCsv(data));
  if (ext === ".xlsx") return fromGrid(await parseXlsx(data));
  if (ext === ".xls") {
    throw new FileFormatError("Old .xls files aren't supported. In Excel, use Save As → .xlsx or .csv, then upload again.");
  }
  throw new FileFormatError("Upload a .csv or .xlsx file.");
}

function parseCsv(data: Buffer): string[][] {
  const text = new TextDecoder("utf-8").decode(data); // also drops a UTF-8 BOM
  // Blank lines confuse delimiter detection, so detect it on a cleaned sample first.
  const { delimiter } = Papa.parse(text, { preview: 20, skipEmptyLines: "greedy" }).meta;
  // Blank lines are kept here (and dropped later) so row numbers match the file.
  const result = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: false });
  const fatal = result.errors.find((e) => e.type === "Quotes");
  if (fatal) throw new FileFormatError(`Couldn't read the CSV: ${fatal.message} (row ${fatal.row ?? "?"})`);
  return result.data;
}

async function parseXlsx(data: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's Buffer type predates the generic Node Buffer.
    await workbook.xlsx.load(data as unknown as ExcelJS.Buffer);
  } catch {
    throw new FileFormatError("Couldn't open the Excel file. Make sure it is a real .xlsx file and not password protected.");
  }
  const sheet = workbook.worksheets.find((ws) => ws.actualRowCount > 0);
  if (!sheet) return [];

  const grid: string[][] = [];
  const columnCount = sheet.columnCount;
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= columnCount; c++) cells.push(cellText(row.getCell(c)));
    grid.push(cells);
  }
  return grid;
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  // Plain numbers: String() keeps all digits of a phone number (no 9.19877E+11).
  if (typeof value === "number") return String(value);
  return cell.text ?? "";
}

/** First non-empty row becomes the header; blank rows are dropped. */
function fromGrid(grid: string[][]): ParsedSheet {
  const indexed = grid
    .map((cells, i) => ({ cells: cells.map((c) => String(c ?? "").trim()), rowNumber: i + 1 }))
    .filter(({ cells }) => cells.some((c) => c !== ""));

  const header = indexed.shift();
  if (!header) throw new FileFormatError("The file is empty.");
  if (indexed.length === 0) throw new FileFormatError("The file has a header row but no contacts under it.");
  if (indexed.length > MAX_ROWS) {
    throw new FileFormatError(`The file has ${indexed.length} rows. The limit is ${MAX_ROWS}; split it into smaller files.`);
  }

  const width = indexed.reduce((w, r) => Math.max(w, r.cells.length), header.cells.length);
  const columns = uniqueColumnNames(header.cells, width);
  const rows = indexed.map(({ cells }) => Array.from({ length: width }, (_, i) => cells[i] ?? ""));
  return { columns, rows, rowNumbers: indexed.map((r) => r.rowNumber) };
}

function uniqueColumnNames(headerCells: string[], width: number): string[] {
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, i) => {
    const base = headerCells[i] || `Column ${i + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

const PHONE_HEADER = /phone|mobile|mob\b|number|contact|cell|whatsapp|msisdn/i;

/**
 * Picks the column most likely to hold phone numbers: a phone-like header name first,
 * otherwise the column whose sample values look most like phone numbers.
 */
export function suggestPhoneColumn(sheet: ParsedSheet): number {
  const byName = sheet.columns.findIndex((c) => PHONE_HEADER.test(c));
  if (byName !== -1) return byName;

  const sample = sheet.rows.slice(0, 50);
  let best = 0;
  let bestScore = -1;
  sheet.columns.forEach((_, i) => {
    const score = sample.filter((r) => /^\+?[\d\s\-()]{10,16}$/.test(r[i] ?? "")).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}
