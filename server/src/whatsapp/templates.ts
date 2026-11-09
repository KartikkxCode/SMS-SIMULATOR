import type { HeaderFormat, WaButton, WaParam, WaTemplate } from "./types.js";

/** A template as Meta's Graph API returns it (GET /{waba-id}/message_templates). */
export type MetaTemplateJson = {
  id?: string;
  name: string;
  language: string;
  status?: string;
  category?: string;
  parameter_format?: string;
  namespace?: string;
  components?: MetaComponentJson[];
};

type MetaComponentJson = {
  type: string;
  format?: string;
  text?: string;
  example?: {
    header_text?: string[];
    body_text?: string[][];
    header_text_named_params?: Array<{ param_name: string; example: string }>;
    body_text_named_params?: Array<{ param_name: string; example: string }>;
  };
  buttons?: Array<{ type: string; text?: string; url?: string; phone_number?: string; example?: string[] | string }>;
};

const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const SUPPORTED_HEADERS = new Set<HeaderFormat>(["NONE", "TEXT", "IMAGE", "DOCUMENT"]);
const SUPPORTED_BUTTONS = new Set(["QUICK_REPLY", "URL", "PHONE_NUMBER", "COPY_CODE"]);
const KNOWN_COMPONENTS = new Set(["HEADER", "BODY", "FOOTER", "BUTTONS"]);

/** Variable names in the order they first appear, e.g. "Hi {{1}}, {{2}} {{1}}" → ["1", "2"]. */
export function templateVariables(text: string | undefined): string[] {
  if (!text) return [];
  return [...new Set(Array.from(text.matchAll(VARIABLE), (m) => m[1]!))];
}

function ordered(names: string[], format: WaTemplate["parameterFormat"]): string[] {
  return format === "POSITIONAL" ? [...names].sort((a, b) => Number(a) - Number(b)) : names;
}

export function fromMetaTemplate(raw: MetaTemplateJson): WaTemplate {
  const components = raw.components ?? [];
  const find = (type: string) => components.find((c) => c.type?.toUpperCase() === type);
  const headerC = find("HEADER");
  const bodyC = find("BODY");
  const footerC = find("FOOTER");
  const buttonsC = find("BUTTONS");

  const headerFormat = (headerC ? (headerC.format ?? "TEXT").toUpperCase() : "NONE") as HeaderFormat;
  const headerText = headerFormat === "TEXT" ? headerC?.text : undefined;
  const body = bodyC?.text ?? "";
  const allVars = [...templateVariables(headerText), ...templateVariables(body)];
  const parameterFormat =
    raw.parameter_format?.toUpperCase() === "NAMED" || allVars.some((v) => !/^\d+$/.test(v)) ? "NAMED" : "POSITIONAL";

  const params: WaParam[] = [];
  const headerExamples = exampleMap(headerC?.example?.header_text, headerC?.example?.header_text_named_params, templateVariables(headerText), parameterFormat);
  for (const name of ordered(templateVariables(headerText), parameterFormat)) {
    params.push({ key: `header.${name}`, component: "header", name, example: headerExamples[name] });
  }
  const bodyExamples = exampleMap(bodyC?.example?.body_text?.[0], bodyC?.example?.body_text_named_params, templateVariables(body), parameterFormat);
  for (const name of ordered(templateVariables(body), parameterFormat)) {
    params.push({ key: `body.${name}`, component: "body", name, example: bodyExamples[name] });
  }

  const buttons: WaButton[] = (buttonsC?.buttons ?? []).map((b, index) => ({
    index,
    type: b.type.toUpperCase(),
    text: b.text ?? "",
    url: b.url,
    phone: b.phone_number,
  }));
  for (const [i, b] of (buttonsC?.buttons ?? []).entries()) {
    const example = Array.isArray(b.example) ? b.example[0] : b.example;
    const type = b.type.toUpperCase();
    if (type === "URL" && templateVariables(b.url).length > 0) {
      params.push({ key: `button.${i}`, component: "button", name: templateVariables(b.url)[0]!, buttonIndex: i, buttonType: "URL", example });
    } else if (type === "COPY_CODE") {
      params.push({ key: `button.${i}`, component: "button", name: "coupon_code", buttonIndex: i, buttonType: "COPY_CODE", example });
    }
  }

  const status = (raw.status ?? "APPROVED").toUpperCase();
  const category = (raw.category ?? "MARKETING").toUpperCase();
  const template: WaTemplate = {
    ref: `${raw.name}|${raw.language}`,
    name: raw.name,
    language: raw.language,
    category,
    status,
    parameterFormat,
    header: { format: headerFormat, text: headerText },
    body,
    footer: footerC?.text,
    buttons,
    params,
    supported: true,
    namespace: raw.namespace,
  };
  const reason = unsupportedReason(template, components);
  if (reason) {
    template.supported = false;
    template.unsupportedReason = reason;
  }
  return template;
}

function exampleMap(
  positional: string[] | undefined,
  named: Array<{ param_name: string; example: string }> | undefined,
  names: string[],
  format: WaTemplate["parameterFormat"],
): Record<string, string> {
  if (format === "NAMED") return Object.fromEntries((named ?? []).map((n) => [n.param_name, n.example]));
  const sorted = ordered(names, "POSITIONAL");
  return Object.fromEntries(sorted.map((name, i) => [name, positional?.[i] ?? ""]).filter(([, v]) => v));
}

function unsupportedReason(t: WaTemplate, components: MetaComponentJson[]): string | undefined {
  if (t.status !== "APPROVED") return `Not approved yet (status: ${t.status.toLowerCase()}).`;
  if (t.category === "AUTHENTICATION") return "Authentication (one-time password) templates can't be sent in bulk.";
  const other = components.find((c) => !KNOWN_COMPONENTS.has(c.type?.toUpperCase()));
  if (other) return `${titleCase(other.type)} templates aren't supported.`;
  if (!SUPPORTED_HEADERS.has(t.header.format)) return `${titleCase(t.header.format)} headers aren't supported.`;
  const button = t.buttons.find((b) => !SUPPORTED_BUTTONS.has(b.type));
  if (button) return `${titleCase(button.type)} buttons aren't supported.`;
  if (!t.body.trim()) return "The template has no body text.";
  return undefined;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ");

export type ManualTemplateInput = {
  name: string;
  language: string;
  category: string;
  headerFormat: "NONE" | "TEXT" | "IMAGE" | "DOCUMENT";
  headerText?: string;
  body: string;
  footer?: string;
  namespace?: string;
};

/** For when the provider can't list templates: the user types in the approved template. */
export function manualTemplate(input: ManualTemplateInput): WaTemplate {
  const components: MetaComponentJson[] = [];
  if (input.headerFormat !== "NONE") {
    components.push({ type: "HEADER", format: input.headerFormat, text: input.headerFormat === "TEXT" ? input.headerText : undefined });
  }
  components.push({ type: "BODY", text: input.body });
  if (input.footer) components.push({ type: "FOOTER", text: input.footer });
  return fromMetaTemplate({
    name: input.name,
    language: input.language,
    category: input.category,
    status: "APPROVED",
    namespace: input.namespace,
    components,
  });
}

/** Sample templates so Simulate mode can be tried without a WhatsApp Business account. */
export function demoTemplates(): WaTemplate[] {
  const raw: MetaTemplateJson[] = [
    {
      name: "festival_offer",
      language: "en",
      category: "MARKETING",
      components: [
        { type: "HEADER", format: "IMAGE" },
        {
          type: "BODY",
          text: "Hi {{1}}! 🎉 Our *{{2}} sale* is live. Get {{3}} off on everything this week.",
          example: { body_text: [["Asha", "Diwali", "20%"]] },
        },
        { type: "FOOTER", text: "Reply STOP to unsubscribe" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "URL", text: "Shop now", url: "https://example.com/shop/{{1}}", example: ["diwali"] },
            { type: "QUICK_REPLY", text: "Stop promotions" },
          ],
        },
      ],
    },
    {
      name: "order_ready",
      language: "en",
      category: "UTILITY",
      components: [
        { type: "HEADER", format: "TEXT", text: "Order {{1}} is ready", example: { header_text: ["#1042"] } },
        {
          type: "BODY",
          text: "Hello {{1}}, your order is ready for pickup at our {{2}} store. Show this message at the counter.",
          example: { body_text: [["Ravi", "Pune"]] },
        },
        { type: "BUTTONS", buttons: [{ type: "PHONE_NUMBER", text: "Call store", phone_number: "+910000000000" }] },
      ],
    },
    {
      name: "invoice_ready",
      language: "en",
      category: "UTILITY",
      parameter_format: "NAMED",
      components: [
        { type: "HEADER", format: "DOCUMENT" },
        {
          type: "BODY",
          text: "Dear {{customer_name}}, your invoice is attached. Amount due: {{amount}}.",
          example: { body_text_named_params: [{ param_name: "customer_name", example: "Meera" }, { param_name: "amount", example: "₹1,250" }] },
        },
      ],
    },
    {
      name: "welcome_coupon",
      language: "en",
      category: "MARKETING",
      components: [
        { type: "BODY", text: "Welcome {{1}}! Here is a coupon for your next visit.", example: { body_text: [["Imran"]] } },
        { type: "BUTTONS", buttons: [{ type: "COPY_CODE", example: ["WELCOME10"] }] },
      ],
    },
    {
      name: "hello_world",
      language: "en_US",
      category: "UTILITY",
      components: [
        { type: "HEADER", format: "TEXT", text: "Hello World" },
        {
          type: "BODY",
          text: "Welcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification from the Cloud API, hosted by Meta. Thank you for taking the time to test with us.",
        },
        { type: "FOOTER", text: "WhatsApp Business Platform sample message" },
      ],
    },
    {
      name: "login_code",
      language: "en",
      category: "AUTHENTICATION",
      components: [{ type: "BODY", text: "{{1}} is your verification code." }],
    },
  ];
  return raw.map(fromMetaTemplate);
}
