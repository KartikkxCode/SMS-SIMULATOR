export type Segment = { type: "text" | "bold" | "italic" | "strike" | "mono"; text: string };

// WhatsApp's formatting: *bold*, _italic_, ~strike~, ```mono```. Markers must hug the text
// ("* not bold *" stays as typed), sit at word edges (snake_case_name stays plain) and don't span lines.
const PATTERN =
  /```([^`]+?)```|(?<![\p{L}\p{N}])(?:\*(\S(?:[^*\n]*?\S)?)\*|_(\S(?:[^_\n]*?\S)?)_|~(\S(?:[^~\n]*?\S)?)~)(?![\p{L}\p{N}])/gu;

/** Splits text into plain and formatted parts, so it can be shown without injecting HTML. */
export function formatWhatsApp(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(PATTERN)) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: "mono", text: m[1] });
    else if (m[2] !== undefined) out.push({ type: "bold", text: m[2] });
    else if (m[3] !== undefined) out.push({ type: "italic", text: m[3] });
    else out.push({ type: "strike", text: m[4]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}
