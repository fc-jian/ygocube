import type { Prompt } from "@ygocube/duel-protocol";

// Mirrors ClientField::CancelOrFinish; required selections must never be skipped.
export function secondaryResponse(
  p: Prompt | null,
  count: number,
  valid: boolean,
): "none" | "cancel" | "no" | "finish" {
  if (!p) return "none";
  if (p.kind === "yesno") return "no";
  if (p.kind === "unselect") return p.cancel ? "cancel" : "none";
  if (["cards", "tribute"].includes(p.kind)) {
    if (!count && p.cancel) return "cancel";
    return valid ? "finish" : "none";
  }
  if (p.kind === "sum") return valid ? "finish" : "none";
  if (p.kind === "sort" && p.cancel) return "cancel";
  return "none";
}
