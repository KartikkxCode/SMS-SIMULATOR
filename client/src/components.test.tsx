// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WaTemplate } from "./channels/whatsapp/api.ts";
import { guessMapping } from "./channels/whatsapp/PersonalizeStep.tsx";
import { WaPreview } from "./channels/whatsapp/WaPreview.tsx";
import { Stepper } from "./components/Stepper.tsx";
import { ManualContacts } from "./steps/ManualContacts.tsx";
import { UploadStep } from "./steps/Upload.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const XSS = `<img src=x onerror="window.hacked=true">`;

const template = (params: WaTemplate["params"]): WaTemplate => ({
  ref: "t|en",
  name: "t",
  language: "en",
  category: "UTILITY",
  status: "APPROVED",
  parameterFormat: "POSITIONAL",
  header: { format: "NONE" },
  body: "x",
  buttons: [],
  params,
  supported: true,
});

describe("guessMapping", () => {
  it("maps {{1}} to a name column and named variables to matching columns", () => {
    const t = template([
      { key: "body.1", component: "body", name: "1" },
      { key: "body.2", component: "body", name: "2" },
    ]);
    expect(guessMapping(t, ["Phone", "Customer Name", "City"])).toEqual({ "body.1": { column: 1 }, "body.2": { fixed: "" } });
    const named = template([
      { key: "body.first_name", component: "body", name: "first_name" },
      { key: "body.city", component: "body", name: "city" },
    ]);
    expect(guessMapping(named, ["First Name", "Phone", "CITY"])).toEqual({ "body.first_name": { column: 0 }, "body.city": { column: 2 } });
    expect(guessMapping(t, [])).toEqual({ "body.1": { fixed: "" }, "body.2": { fixed: "" } });
  });
});

describe("WaPreview", () => {
  it("shows contact values as text, never as HTML", () => {
    const { container } = render(
      <WaPreview message={{ header: XSS, body: `Hi ${XSS}, *welcome*`, footer: XSS, buttons: [{ type: "URL", text: XSS }] }} headerFormat="TEXT" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
    expect(container.querySelector(".wa-body")?.textContent).toBe(`Hi ${XSS}, welcome`);
    expect(container.querySelector(".wa-body strong")?.textContent).toBe("welcome");
  });

  it("shows header media, footer and buttons", () => {
    const { container } = render(
      <WaPreview
        message={{ body: "Body", footer: "Reply STOP", buttons: [{ type: "URL", text: "Shop" }, { type: "COPY_CODE", text: "", code: "SAVE10" }] }}
        headerFormat="DOCUMENT"
        media={{ ref: "r", kind: "document", filename: "invoice.pdf" }}
        businessName="ABC Store"
      />,
    );
    expect(container.querySelector(".wa-doc")?.textContent).toContain("invoice.pdf");
    expect(screen.getByText("ABC Store")).toBeTruthy();
    expect([...container.querySelectorAll(".wa-button")].map((b) => b.textContent)).toEqual(["↗ Shop", "⧉ Copy code SAVE10"]);
  });
});

describe("Stepper", () => {
  it("marks done steps and the current one", () => {
    render(<Stepper steps={["One", "Two", "Three"]} current={1} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.className)).toEqual(["done", "current", ""]);
    expect(items[1]!.getAttribute("aria-current")).toBe("step");
    expect(within(items[0]!).getByText("✓")).toBeTruthy();
  });
});

describe("typed contacts", () => {
  function mockServer() {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const { contacts } = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ uploadId: "u1", fileName: `Typed contacts (${contacts.length})`, columns: ["Name", "Phone"], rowCount: contacts.length, preview: [], phoneColumn: 1 }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("adds and removes rows, pastes a list and sends only filled rows", async () => {
    const user = userEvent.setup();
    const fetchMock = mockServer();
    const onUploaded = vi.fn();
    render(<ManualContacts onUploaded={onUploaded} />);

    await user.type(screen.getByLabelText("Name 1"), "Asha");
    await user.type(screen.getByLabelText("Number 1"), "98765 43210");
    await user.click(screen.getByRole("button", { name: "+ Add row" }));
    expect(screen.getAllByLabelText(/^Name \d+$/)).toHaveLength(4);
    await user.click(screen.getByRole("button", { name: "Remove row 4" }));
    expect(screen.getAllByLabelText(/^Name \d+$/)).toHaveLength(3);

    await user.click(screen.getByText("Paste a list"));
    await user.type(screen.getByLabelText("Pasted contacts"), "Ravi, +91 91234 56789{enter}9988776655");
    await user.click(screen.getByRole("button", { name: "Add to the list" }));
    // Blank rows are replaced by the pasted ones.
    expect((screen.getAllByLabelText(/^Number \d+$/) as HTMLInputElement[]).map((i) => i.value)).toEqual([
      "98765 43210",
      "+91 91234 56789",
      "9988776655",
    ]);

    await user.click(screen.getByRole("button", { name: "Use these contacts (3)" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      contacts: [
        { name: "Asha", phone: "98765 43210" },
        { name: "Ravi", phone: "+91 91234 56789" },
        { name: "", phone: "9988776655" },
      ],
    });
    expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ uploadId: "u1", phoneColumn: 1 }));
  });

  it("won't send an empty list, and stops a paste that goes over 1,000", async () => {
    const user = userEvent.setup();
    render(<ManualContacts onUploaded={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Use these contacts (0)" })).toHaveProperty("disabled", true);
    await user.click(screen.getByText("Paste a list"));
    const many = Array.from({ length: 1001 }, (_, i) => `98765${String(i).padStart(5, "0")}`).join("\n");
    await user.click(screen.getByLabelText("Pasted contacts"));
    await user.paste(many);
    await user.click(screen.getByRole("button", { name: "Add to the list" }));
    expect(screen.getByRole("alert").textContent).toMatch(/1001 contacts\. You can type up to 1000/);
  });

  it("shows the server's error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Add at least one number." }), { status: 400 })));
    const user = userEvent.setup();
    render(<ManualContacts onUploaded={vi.fn()} />);
    await user.type(screen.getByLabelText("Name 1"), "Only a name");
    await user.click(screen.getByRole("button", { name: "Use these contacts (1)" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Add at least one number.");
  });

  it("switches between uploading a file and typing numbers", async () => {
    const user = userEvent.setup();
    render(<UploadStep onUploaded={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Choose file" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Type numbers" }));
    expect(screen.getByRole("button", { name: "Type numbers" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Choose file" })).toBeNull();
    expect(screen.getByLabelText("Name 1")).toBeTruthy();
  });
});
