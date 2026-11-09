import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { CampaignStore } from "../src/services/campaignRunner.js";
import { SimulatedProvider, buildFlowPayload, type SmsProvider } from "../src/services/sms.js";

const CSV = "Name,Phone\nAsha,9876543210\nRavi,+91 91234 56789\nBad,12345\nAsha again,98765 43210\n";

function setup(env: Record<string, string> = {}, simulateLatencyMs = 0) {
  const config = loadConfig({ REPORTS_DIR: "unused", ...env });
  const campaigns = new CampaignStore({ batchSize: 100, batchDelayMs: 0, sleep: async () => undefined });
  const live: SmsProvider = {
    mode: "live",
    sendBatch: vi.fn(async (req) => ({ requestId: "live-req", payload: buildFlowPayload(req) })),
  };
  const app = createApp({ config, campaigns, providerFor: (mode) => (mode === "live" ? live : new SimulatedProvider(simulateLatencyMs)) });
  return { app, campaigns, live };
}

async function upload(app: ReturnType<typeof setup>["app"], body = CSV, name = "contacts.csv") {
  return request(app).post("/api/upload").attach("file", Buffer.from(body), name);
}

describe("API", () => {
  it("reports whether live mode is available without exposing the key", async () => {
    const { app } = setup({ MSG91_AUTH_KEY: "secret", MSG91_TEMPLATE_ID: "tpl_1" });
    const res = await request(app).get("/api/config");
    expect(res.body).toEqual({ liveAvailable: true, defaultTemplateId: "tpl_1", defaultCountryCode: "91", batchSize: 100 });
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("uploads a file, checks the contacts and runs a simulated campaign", async () => {
    const { app, campaigns } = setup();

    const up = await upload(app);
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ fileName: "contacts.csv", columns: ["Name", "Phone"], rowCount: 4, phoneColumn: 1 });

    const check = await request(app).get(`/api/uploads/${up.body.uploadId}/contacts?column=1`);
    expect(check.body).toMatchObject({ validCount: 2, invalidCount: 1, duplicateCount: 1 });
    expect(check.body.invalid[0]).toMatchObject({ row: 4, value: "12345" });

    const problems = await request(app).get(`/api/uploads/${up.body.uploadId}/problems.csv?column=1`);
    expect(problems.headers["content-disposition"]).toContain("skipped-contacts.csv");
    expect(problems.text).toContain("Duplicate of row 2");

    const start = await request(app)
      .post("/api/campaigns")
      .send({ uploadId: up.body.uploadId, column: 1, mode: "simulate", variables: { var1: "Diwali" }, message: "Happy Diwali" });
    expect(start.status).toBe(202);
    await campaigns.waitFor(start.body.id);

    const status = await request(app).get(`/api/campaigns/${start.body.id}`);
    expect(status.body).toMatchObject({
      mode: "simulate",
      status: "completed",
      templateId: "SIMULATED-TEMPLATE",
      counts: { total: 2, submitted: 2, failed: 0 },
      samplePayload: { template_id: "SIMULATED-TEMPLATE", recipients: [{ mobiles: "919876543210", var1: "Diwali" }, { mobiles: "919123456789" }] },
    });
    expect(status.body).not.toHaveProperty("recipients");

    const report = await request(app).get(`/api/campaigns/${start.body.id}/report.csv`);
    expect(report.headers["content-type"]).toContain("text/csv");
    expect(report.text.trim().split("\r\n")).toHaveLength(3);
  });

  it("refuses live mode when no authkey is configured", async () => {
    const { app, live } = setup();
    const up = await upload(app);
    const res = await request(app).post("/api/campaigns").send({ uploadId: up.body.uploadId, column: 1, mode: "live", templateId: "tpl" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/MSG91_AUTH_KEY/);
    expect(live.sendBatch).not.toHaveBeenCalled();
  });

  it("requires a template id in live mode", async () => {
    const { app } = setup({ MSG91_AUTH_KEY: "k" });
    const up = await upload(app);
    const res = await request(app).post("/api/campaigns").send({ uploadId: up.body.uploadId, column: 1, mode: "live" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/template ID/);
  });

  it("sends live campaigns through the MSG91 provider", async () => {
    const { app, campaigns, live } = setup({ MSG91_AUTH_KEY: "k" });
    const up = await upload(app);
    const start = await request(app)
      .post("/api/campaigns")
      .send({ uploadId: up.body.uploadId, column: 1, mode: "live", templateId: "tpl_9" });
    await campaigns.waitFor(start.body.id);
    expect(live.sendBatch).toHaveBeenCalledWith({ templateId: "tpl_9", numbers: ["919876543210", "919123456789"], variables: {} });
  });

  it("allows only one campaign at a time", async () => {
    const { app, campaigns } = setup({}, 200);
    const up = await upload(app);
    const body = { uploadId: up.body.uploadId, column: 1, mode: "simulate" };
    const first = await request(app).post("/api/campaigns").send(body);
    const second = await request(app).post("/api/campaigns").send(body);
    expect(second.status).toBe(409);
    await campaigns.waitFor(first.body.id);
  });

  it("test-sends to one normalized number", async () => {
    const { app, live } = setup({ MSG91_AUTH_KEY: "k" });
    const res = await request(app).post("/api/test-send").send({ mode: "live", templateId: "tpl", number: "098765 43210" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ number: "919876543210", requestId: "live-req" });
    expect(live.sendBatch).toHaveBeenCalledWith({ templateId: "tpl", numbers: ["919876543210"], variables: {} });
  });

  it("explains bad test numbers", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/test-send").send({ mode: "simulate", number: "123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Expected 10 digits/);
  });

  it("returns readable errors for bad files and bad requests", async () => {
    const { app } = setup();
    const xls = await upload(app, "x", "old.xls");
    expect(xls.status).toBe(400);
    expect(xls.body.error).toMatch(/\.xls/);

    const noFile = await request(app).post("/api/upload");
    expect(noFile.status).toBe(400);

    const badMode = await request(app).post("/api/campaigns").send({ uploadId: "x", column: 0, mode: "loud" });
    expect(badMode.status).toBe(400);
    expect(badMode.body.error).toMatch(/^mode:/);

    const expired = await request(app).post("/api/campaigns").send({ uploadId: "gone", column: 0, mode: "simulate" });
    expect(expired.status).toBe(404);
  });

  it("rejects files over 5 MB", async () => {
    const { app } = setup();
    const res = await upload(app, "Phone\n" + "9876543210\n".repeat(500_000));
    expect(res.status).toBe(413);
  });

  it("rejects requests addressed to other host names", async () => {
    const { app } = setup();
    const res = await request(app).get("/api/config").set("Host", "evil.example.com");
    expect(res.status).toBe(403);
    const ok = await request(app).get("/api/config").set("Host", "localhost:3000");
    expect(ok.status).toBe(200);
  });

  it("accepts typed contacts and checks them like a file", async () => {
    const { app, campaigns } = setup();
    const contacts = [
      { name: " Asha ", phone: "98765 43210" },
      { name: "", phone: "" },
      { name: "Ravi", phone: "12345" },
      { phone: "+91 91234 56789" },
      { name: "Asha again", phone: "9876543210" },
    ];
    const up = await request(app).post("/api/upload/manual").send({ contacts });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({
      fileName: "Typed contacts (4)",
      columns: ["Name", "Phone"],
      rowCount: 4,
      phoneColumn: 1,
      preview: [
        ["Asha", "98765 43210"],
        ["Ravi", "12345"],
        ["", "+91 91234 56789"],
        ["Asha again", "9876543210"],
      ],
    });

    const check = await request(app).get(`/api/uploads/${up.body.uploadId}/contacts?column=1`);
    expect(check.body).toMatchObject({ validCount: 2, invalidCount: 1, duplicateCount: 1 });
    expect(check.body.invalid[0]).toMatchObject({ row: 2, value: "12345" });
    expect(check.body.duplicates[0]).toMatchObject({ row: 4, firstRow: 1 });

    const start = await request(app).post("/api/campaigns").send({ uploadId: up.body.uploadId, column: 1, mode: "simulate" });
    await campaigns.waitFor(start.body.id);
    expect((await request(app).get(`/api/campaigns/${start.body.id}`)).body.counts).toMatchObject({ total: 2, submitted: 2 });
  });

  it("explains problems with typed contacts", async () => {
    const { app } = setup();
    const send = (body: unknown) => request(app).post("/api/upload/manual").send(body as object);
    expect((await send({ contacts: [] })).body.error).toBe("contacts: Add at least one number.");
    expect((await send({ contacts: [{ name: " ", phone: "" }] })).body.error).toBe("Add at least one number.");
    const tooMany = Array.from({ length: 1001 }, () => ({ name: "A", phone: "9876543210" }));
    expect((await send({ contacts: tooMany })).body.error).toMatch(/up to 1000 contacts\. For more, upload a file/);
    expect((await send({ contacts: [{ phone: "9".repeat(31) }] })).status).toBe(400);
    expect((await send({})).status).toBe(400);
  });

  it("accepts the largest typed list allowed", async () => {
    const { app } = setup();
    const contacts = Array.from({ length: 1000 }, (_, i) => ({ name: "N".repeat(100), phone: `98765${String(i).padStart(5, "0")}` }));
    const up = await request(app).post("/api/upload/manual").send({ contacts });
    expect(up.status).toBe(200);
    expect(up.body.rowCount).toBe(1000);
  });
});
