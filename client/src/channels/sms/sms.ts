// GSM 03.38 alphabet: these characters fit 160 per SMS. Anything else switches to Unicode (70 per SMS).
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
// These need an escape character, so each counts as 2.
const GSM_EXTENDED = "^{}\\[~]|€\f";

export type SmsInfo = {
  encoding: "GSM" | "Unicode";
  length: number;
  parts: number;
  /** Characters left before the message needs another part. */
  remaining: number;
};

export function smsInfo(text: string): SmsInfo {
  let septets = 0;
  let unicode = false;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) septets += 1;
    else if (GSM_EXTENDED.includes(ch)) septets += 2;
    else {
      unicode = true;
      break;
    }
  }
  // Unicode SMS are counted in UTF-16 code units, so emoji take 2.
  const [length, single, multi] = unicode ? [text.length, 70, 67] : [septets, 160, 153];
  if (length === 0) return { encoding: unicode ? "Unicode" : "GSM", length, parts: 0, remaining: single };
  const parts = length <= single ? 1 : Math.ceil(length / multi);
  const capacity = parts === 1 ? single : parts * multi;
  return { encoding: unicode ? "Unicode" : "GSM", length, parts, remaining: capacity - length };
}

const VARIABLE = /##([A-Za-z0-9_]+)##/g;

/** Variable names in an MSG91 template, e.g. "Hi ##name##" → ["name"]. */
export function templateVariables(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(VARIABLE), (m) => m[1]!))];
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(VARIABLE, (whole, name: string) => values[name] || whole);
}
