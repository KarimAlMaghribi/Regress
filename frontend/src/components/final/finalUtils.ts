export const MIN_CONF = 0.6;

export function fmtVal(v: any): string {
  if (v == null) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function confVariant(conf?: number): "filled" | "outlined" {
  if (conf == null) return "outlined";
  return conf < MIN_CONF ? "outlined" : "filled";
}

export function confColor(
    conf?: number
): "default" | "warning" | "success" | "error" {
  if (conf == null) return "default";
  if (conf < MIN_CONF) return "warning";
  return "default";
}

export function boolColor(b?: boolean): "default" | "success" | "error" {
  if (b === true) return "success";
  if (b === false) return "error";
  return "default";
}
