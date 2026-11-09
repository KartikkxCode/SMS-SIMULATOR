import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { CampaignStore } from "../src/services/campaignRunner.js";
import { MAX_ROWS, parseContactsFile } from "../src/services/parseContacts.js";
import { SimulatedProvider } from "../src/services/sms.js";
import { WaLedger } from "../src/whatsapp/ledger.js";
import { WaProviders } from "../src/whatsapp/providers/index.js";
import { WaCampaignStore } from "../src/whatsapp/runner.js";

const XSS = `<img src=x onerror="alert(1)">`;
const FORMULA = `=HYPERLINK("http://evil.test","Click")`;

async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ REPORTS_DIR: "unused", ...env });
  const ledger = await new WaLedger(await mkdtemp(path.join(tmpdir(), "sec-"))).load();
  const wa = new WaCampaignStore({ ratePerSec: 80, ledger });
  const sms = new CampaignStore({ batchSize: 100, batchDelayMs: 0 });
  const app = createApp({
    config,
    campaigns: sms,
    providerFor: () => new SimulatedProvider(50),
    whatsapp: { store: wa, ledger, providers: new WaProviders(config.whatsapp, undefined, 50) },
  });
  return { app, sms, wa };
}

const typed = (app: Awaited<ReturnType<typeof setup>>["app"], contacts: Array<{ name: string; phone: string }>) =>
  request(app).post("/api/upload/manual").send({ contacts });

describe("hostile contact data", () => {
  it("keeps HTML and formulas as plain text in JSON, and defuses formulas in reports", async () => {
    const { app, wa } = await setup();
    const up = await typed(app, [
      { name: XSS, phone: "9876543210" },
      { name: FORMULA, phone: "9123456789" },
    ]);
    expect(up.body.preview).toEqual([
      [XSS, "9876543210"],
      [FORMULA, "9123456789"],
    ]);

    const setupBody = {
      uploadId: up.body.uploadId,
      column: 1,
      provider: "meta",
      mode: "simulate",
      template: { ref: "order_ready|en" },
      mapping: { "header.1": { fixed: "#1" }, "body.1": { column: 0 }, "body.2": { fixed: "Pune" } },
    };
    const pre = await request(app).post("/api/whatsapp/preflight").send(setupBody);
    expect(pre.body.samples[0].rendered.body).toContain(XSS);

    const start = await request(app).post("/api/whatsapp/campaigns").send(setupBody);
    await wa.waitFor(start.body.id);
    const report = (await request(app).get(`/api/whatsapp/campaigns/${start.body.id}/report.csv`)).text;
    expect(report).toContain(`"'=HYPERLINK(""http://evil.test"",""Click"")"`);
    expect(report).not.toMatch(/,=HYPERLINK/);
  });
});

describe("spreadsheets with surprises", () => {
  async function xlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    build(wb);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("uses formula results, skips an empty first sheet and reads merged cells once", async () => {
    const data = await xlsx((wb) => {
      wb.addWorksheet("Empty");
      const ws = wb.addWorksheet("Contacts");
      ws.addRow(["Name", "Phone", "Note"]);
      ws.addRow(["Asha", { formula: '"98765"&"43210"', result: "9876543210" }, "merged"]);
      ws.addRow(["Ravi", "9123456789", ""]);
      ws.mergeCells("C2:C3");
    });
    const sheet = await parseContactsFile("contacts.xlsx", data);
    expect(sheet.columns).toEqual(["Name", "Phone", "Note"]);
    expect(sheet.rows).toEqual([
      ["Asha", "9876543210", "merged"],
      ["Ravi", "9123456789", "merged"],
    ]);
  });

  it(`refuses more than ${MAX_ROWS.toLocaleString()} rows with a clear message`, async () => {
    const csv = "Phone\n" + "9876543210\n".repeat(MAX_ROWS + 1);
    await expect(parseContactsFile("big.csv", Buffer.from(csv))).rejects.toThrow(/50001 rows\. The limit is 50000; split it/);
  });

  it("reports a CSV with a broken quote", async () => {
    await expect(parseContactsFile("c.csv", Buffer.from('Name,Phone\n"Asha,9876543210\n'))).rejects.toThrow(/Couldn't read the CSV/);
  });
});

describe("webhook abuse", () => {
  const env = { WHATSAPP_WEBHOOK_VERIFY_TOKEN: "v", WHATSAPP_META_APP_SECRET: "secret" };
  const sign = (body: string) => `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  const post = (app: Awaited<ReturnType<typeof setup>>["app"], body: string, sig: string) =>
    request(app).post("/webhooks/whatsapp").set("content-type", "application/json").set("x-hub-signature-256", sig).send(body);

  it("rejects truncated, wrong-scheme and other-secret signatures", async () => {
    const { app } = await setup(env);
    const body = JSON.stringify({ entry: [] });
    const good = sign(body);
    expect((await post(app, body, good.slice(0, -2))).status).toBe(401);
    expect((await post(app, body, good.replace("sha256=", "sha1="))).status).toBe(401);
    const other = `sha256=${createHmac("sha256", "other").update(body).digest("hex")}`;
    expect((await post(app, body, other)).status).toBe(401);
    expect((await post(app, body + " ", good)).status).toBe(401);
    expect((await post(app, body, good)).status).toBe(200);
  });

  it("ignores receipts for unknown messages and strange shapes without crashing", async () => {
    const { app } = await setup(env);
    for (const payload of [
      { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.unknown", status: "read" }] } }] }] },
      { entry: "not a list" },
      { entry: [{ changes: [{ value: { statuses: [{ status: "read" }], messages: [{ text: { body: "STOP" } }] } }] }] },
      { entry: [null] },
      [],
    ]) {
      const body = JSON.stringify(payload);
      expect((await post(app, body, sign(body))).status).toBe(200);
    }
    expect((await request(app).get("/api/whatsapp/config")).body.optOutCount).toBe(0);
  });
});

describe("both channels at once", () => {
  it("runs an SMS and a WhatsApp campaign at the same time", async () => {
    const { app, sms, wa } = await setup();
    const up = await typed(app, [
      { name: "Asha", phone: "9876543210" },
      { name: "Ravi", phone: "9123456789" },
    ]);
    const smsStart = await request(app).post("/api/campaigns").send({ uploadId: up.body.uploadId, column: 1, mode: "simulate" });
    const waStart = await request(app)
      .post("/api/whatsapp/campaigns")
      .send({ uploadId: up.body.uploadId, column: 1, provider: "meta", mode: "simulate", template: { ref: "hello_world|en_US" } });
    expect([smsStart.status, waStart.status]).toEqual([202, 202]);
    await Promise.all([sms.waitFor(smsStart.body.id), wa.waitFor(waStart.body.id)]);
    expect((await request(app).get(`/api/campaigns/${smsStart.body.id}`)).body.status).toBe("completed");
    expect((await request(app).get(`/api/whatsapp/campaigns/${waStart.body.id}`)).body.status).toBe("completed");
  });
});
