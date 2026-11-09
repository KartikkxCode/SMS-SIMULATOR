import type { WaMedia, WaParam, WaTemplate } from "./types.js";

type TextParameter = { type: "text"; text: string; parameter_name?: string };
type MediaParameter =
  | { type: "image"; image: { id?: string; link?: string } }
  | { type: "document"; document: { id?: string; link?: string; filename?: string } };
type ButtonParameter = TextParameter | { type: "coupon_code"; coupon_code: string };

export type MetaComponent =
  | { type: "header"; parameters: Array<TextParameter | MediaParameter> }
  | { type: "body"; parameters: TextParameter[] }
  | { type: "button"; sub_type: "url" | "copy_code"; index: string; parameters: ButtonParameter[] };

/** Body of POST /{phone-number-id}/messages (and /marketing_messages) for a template message. */
export type MetaTemplatePayload = {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "template";
  template: { name: string; language: { code: string }; components?: MetaComponent[] };
};

export class PayloadError extends Error {}

export function buildMetaPayload(t: WaTemplate, to: string, values: Record<string, string>, media?: WaMedia): MetaTemplatePayload {
  const value = (p: WaParam) => {
    const v = values[p.key];
    if (v === undefined) throw new PayloadError(`Missing value for ${p.key}`);
    return v;
  };
  const text = (p: WaParam): TextParameter =>
    t.parameterFormat === "NAMED" ? { type: "text", parameter_name: p.name, text: value(p) } : { type: "text", text: value(p) };

  const components: MetaComponent[] = [];
  const headerParams = t.params.filter((p) => p.component === "header");
  if (t.header.format === "IMAGE" || t.header.format === "DOCUMENT") {
    components.push({ type: "header", parameters: [mediaParameter(t, media)] });
  } else if (headerParams.length > 0) {
    components.push({ type: "header", parameters: headerParams.map(text) });
  }
  const bodyParams = t.params.filter((p) => p.component === "body");
  if (bodyParams.length > 0) components.push({ type: "body", parameters: bodyParams.map(text) });
  for (const p of t.params.filter((p) => p.component === "button")) {
    components.push(
      p.buttonType === "COPY_CODE"
        ? { type: "button", sub_type: "copy_code", index: String(p.buttonIndex), parameters: [{ type: "coupon_code", coupon_code: value(p) }] }
        : { type: "button", sub_type: "url", index: String(p.buttonIndex), parameters: [{ type: "text", text: value(p) }] },
    );
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: { name: t.name, language: { code: t.language }, ...(components.length > 0 ? { components } : {}) },
  };
}

function mediaParameter(t: WaTemplate, media: WaMedia | undefined): MediaParameter {
  const expected = t.header.format === "IMAGE" ? "image" : "document";
  if (!media || media.kind !== expected || !(media.id || media.link)) {
    throw new PayloadError(`This template needs ${expected === "image" ? "an image" : "a PDF document"} for its header.`);
  }
  const ref = media.id ? { id: media.id } : { link: media.link };
  return expected === "image"
    ? { type: "image", image: ref }
    : { type: "document", document: { ...ref, ...(media.filename ? { filename: media.filename } : {}) } };
}

/** Body of MSG91's POST /api/v5/whatsapp/whatsapp-outbound-message/bulk/. */
export type Msg91BulkPayload = {
  integrated_number: string;
  content_type: "template";
  payload: {
    messaging_product: "whatsapp";
    type: "template";
    template: {
      name: string;
      language: { code: string; policy: "deterministic" };
      namespace?: string;
      to_and_components: Array<{ to: string[]; components: Record<string, Msg91Component> }>;
    };
  };
};

type Msg91Component = { type: string; value: string; filename?: string; subtype?: string };

export function buildMsg91Payload(
  t: WaTemplate,
  integratedNumber: string,
  items: Array<{ to: string; values: Record<string, string> }>,
  media?: WaMedia,
): Msg91BulkPayload {
  return {
    integrated_number: integratedNumber,
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: t.name,
        language: { code: t.language, policy: "deterministic" },
        ...(t.namespace ? { namespace: t.namespace } : {}),
        // One entry per contact so everyone gets their own values.
        to_and_components: items.map((item) => ({ to: [item.to], components: msg91Components(t, item.values, media) })),
      },
    },
  };
}

/**
 * MSG91 names components by position: header_1, body_1, body_2…, button_1.
 * This follows MSG91's published samples; if your account expects other keys, this is the only place to change.
 */
function msg91Components(t: WaTemplate, values: Record<string, string>, media?: WaMedia): Record<string, Msg91Component> {
  const out: Record<string, Msg91Component> = {};
  const value = (p: WaParam) => {
    const v = values[p.key];
    if (v === undefined) throw new PayloadError(`Missing value for ${p.key}`);
    return v;
  };
  if (t.header.format === "IMAGE" || t.header.format === "DOCUMENT") {
    const kind = t.header.format === "IMAGE" ? "image" : "document";
    if (!media?.link || media.kind !== kind) {
      throw new PayloadError(`MSG91 needs a public link to ${kind === "image" ? "the image" : "the PDF"} for the header.`);
    }
    out.header_1 = { type: kind, value: media.link, ...(kind === "document" && media.filename ? { filename: media.filename } : {}) };
  } else {
    t.params.filter((p) => p.component === "header").forEach((p, i) => (out[`header_${i + 1}`] = { type: "text", value: value(p) }));
  }
  t.params.filter((p) => p.component === "body").forEach((p, i) => (out[`body_${i + 1}`] = { type: "text", value: value(p) }));
  t.params
    .filter((p) => p.component === "button")
    .forEach((p, i) => {
      out[`button_${i + 1}`] = { subtype: p.buttonType === "COPY_CODE" ? "copy_code" : "url", type: "text", value: value(p) };
    });
  return out;
}
