import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { FileFormatError, parseContactsFile, suggestPhoneColumn } from "../src/services/parseContacts.js";

const csv = (text: string) => Buffer.from(text, "utf8");

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Contacts");
  rows.forEach((r) => sheet.addRow(r));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("parseContactsFile (CSV)", () => {
  it("reads headers and rows, dropping a BOM and blank lines", async () => {
    const sheet = await parseContactsFile("contacts.csv", csv("\uFEFFName,Phone\nAsha,9876543210\n\n,\nRavi,\"+91 91234 56789\"\n"));
    expect(sheet.columns).toEqual(["Name", "Phone"]);
    expect(sheet.rows).toEqual([
      ["Asha", "9876543210"],
      ["Ravi", "+91 91234 56789"],
    ]);
    expect(sheet.rowNumbers).toEqual([2, 5]);
  });

  it("detects semicolon-separated files", async () => {
    const sheet = await parseContactsFile("contacts.csv", csv("Name;Mobile\nAsha;9876543210\n"));
    expect(sheet.columns).toEqual(["Name", "Mobile"]);
    expect(sheet.rows).toEqual([["Asha", "9876543210"]]);
  });

  it("names empty and repeated headers", async () => {
    const sheet = await parseContactsFile("c.csv", csv("Phone,,Phone\n1,2,3\n"));
    expect(sheet.columns).toEqual(["Phone", "Column 2", "Phone (2)"]);
  });

  it("pads short rows so every row matches the columns", async () => {
    const sheet = await parseContactsFile("c.csv", csv("Name,Phone,City\nAsha,9876543210\n"));
    expect(sheet.rows).toEqual([["Asha", "9876543210", ""]]);
  });

  it("rejects an empty file and a header-only file", async () => {
    await expect(parseContactsFile("c.csv", csv(""))).rejects.toThrow(FileFormatError);
    await expect(parseContactsFile("c.csv", csv("Name,Phone\n"))).rejects.toThrow(/no contacts/);
  });
});

describe("parseContactsFile (Excel)", () => {
  it("reads numeric phone cells without losing digits", async () => {
    const data = await xlsx([
      ["Name", "Phone"],
      ["Asha", 919876543210],
      ["Ravi", "09123456789"],
    ]);
    const sheet = await parseContactsFile("contacts.xlsx", data);
    expect(sheet.columns).toEqual(["Name", "Phone"]);
    expect(sheet.rows).toEqual([
      ["Asha", "919876543210"],
      ["Ravi", "09123456789"],
    ]);
    expect(sheet.rowNumbers).toEqual([2, 3]);
  });

  it("rejects files that aren't really Excel", async () => {
    await expect(parseContactsFile("fake.xlsx", csv("not a zip"))).rejects.toThrow(/Couldn't open the Excel file/);
  });

  it("explains that old .xls files need converting", async () => {
    await expect(parseContactsFile("old.xls", csv(""))).rejects.toThrow(/\.xls files aren't supported/);
  });

  it("rejects other file types", async () => {
    await expect(parseContactsFile("contacts.pdf", csv(""))).rejects.toThrow(/\.csv or \.xlsx/);
  });
});

describe("suggestPhoneColumn", () => {
  it("prefers a phone-like header", async () => {
    const sheet = await parseContactsFile("c.csv", csv("Name,City,Mobile No\nAsha,Pune,9876543210\n"));
    expect(suggestPhoneColumn(sheet)).toBe(2);
  });

  it("falls back to the column whose values look like phone numbers", async () => {
    const sheet = await parseContactsFile("c.csv", csv("Name,Col\nAsha,9876543210\nRavi,+91 91234 56789\n"));
    expect(suggestPhoneColumn(sheet)).toBe(1);
  });
});
