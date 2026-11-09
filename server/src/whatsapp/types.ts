export type WaProviderId = "meta" | "msg91";
export type WaMode = "simulate" | "live";
export type HeaderFormat = "NONE" | "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO" | "LOCATION";

/** One value the template needs, e.g. {{1}} in the body or the dynamic end of a link button. */
export type WaParam = {
  /** Unique key used in mappings and value maps: "header.1", "body.1", "body.first_name", "button.0". */
  key: string;
  component: "header" | "body" | "button";
  /** "1", "2"… for positional templates, or the variable name for named ones. */
  name: string;
  buttonIndex?: number;
  buttonType?: "URL" | "COPY_CODE";
  /** Example value from the template, if it has one. */
  example?: string;
};

export type WaButton = { index: number; type: string; text: string; url?: string; phone?: string };

export type WaTemplate = {
  /** `${name}|${language}`: a template name can exist in several languages. */
  ref: string;
  name: string;
  language: string;
  category: string;
  status: string;
  parameterFormat: "POSITIONAL" | "NAMED";
  header: { format: HeaderFormat; text?: string };
  body: string;
  footer?: string;
  buttons: WaButton[];
  params: WaParam[];
  supported: boolean;
  unsupportedReason?: string;
  /** MSG91 asks for the WhatsApp template namespace. */
  namespace?: string;
};

/** Image or PDF shown in the template header. Meta uses an uploaded `id`; MSG91 needs a public `link`. */
export type WaMedia = { kind: "image" | "document"; id?: string; link?: string; filename?: string };
