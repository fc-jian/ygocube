import type { Prompt } from "@ygocube/duel-protocol";

export type ChainPreference = "auto" | "always" | "available" | "skip";
export type NativePromptDetails = {
  chainSpecialCount?: number;
  finishable?: boolean;
};

// These UI flags are not retained by the shared protocol model. Keep them local
// to the decoded prompt (including when MSG_RETRY restores that same object).
export function nativePromptDetails(frame: Uint8Array): NativePromptDetails {
  if (frame[2] !== 1) return {};
  if (frame[3] === 16 && frame.length > 6)
    return { chainSpecialCount: frame[6] };
  if (frame[3] === 26 && frame.length > 5) return { finishable: !!frame[5] };
  return {};
}

export function shouldPassChain(
  p: Prompt | null,
  preference: ChainPreference,
  details: NativePromptDetails = {},
) {
  if (p?.kind !== "chain" || !p.cancel) return false;
  // DuelClient::ClientAnalyze preserves trigger selection even in ignore mode.
  if (details.chainSpecialCount === 0x7f) return false;
  if (preference === "always") return false;
  if (preference === "skip") return true;
  return (
    !p.choices.length ||
    (preference === "auto" && details.chainSpecialCount === 0)
  );
}

export function selectionLimit(p: Prompt): number | null {
  if (!["cards", "tribute", "sum", "sort", "mask", "place"].includes(p.kind))
    return null;
  // Greater-than sums use max=0 on the wire; this is not a zero-card limit.
  if (p.kind === "sum" && p.mode === 1) return p.choices.length;
  return Number.isInteger(p.max) && p.max >= 0
    ? Math.min(p.max, p.choices.length)
    : null;
}

export function toggleSelection(p: Prompt, current: number[], index: number) {
  const limit = selectionLimit(p);
  if (limit === null || !p.choices.some((c) => c.index === index))
    return current;
  if (current.includes(index)) return current.filter((i) => i !== index);
  return current.length < limit ? [...current, index] : current;
}

export function shouldSubmitSelection(
  p: Prompt,
  indices: number[],
  valid: boolean,
) {
  const limit = selectionLimit(p);
  return valid && limit !== null && limit > 0 && indices.length === limit;
}

export function canCancelSelection(p: Prompt, count: number) {
  return !!p.cancel && (!["cards", "tribute"].includes(p.kind) || count === 0);
}

export function selectionRange(p: Prompt): string {
  if (
    !["cards", "sum", "sort", "mask", "unselect"].includes(p.kind) ||
    (p.kind === "sum" && p.mode === 1) ||
    !Number.isInteger(p.min) ||
    !Number.isInteger(p.max)
  )
    return "";
  return p.min === p.max ? String(p.min) : `${p.min}–${p.max}`;
}

// The server announces a revision before its binary prompt. Do not bind the
// previous prompt to that new revision, or let an old render use the latest ID.
export function createResponseGate() {
  let revision = -1,
    prompt: Prompt | null = null,
    sent = false;
  return {
    begin(nextRevision: number) {
      revision = nextRevision;
      prompt = null;
      sent = false;
    },
    bind(nextPrompt: Prompt | null) {
      prompt = nextPrompt;
    },
    canSend(expectedRevision: number, expectedPrompt: Prompt | null) {
      return (
        !sent &&
        !!prompt &&
        prompt === expectedPrompt &&
        revision === expectedRevision
      );
    },
    claim(expectedRevision: number, expectedPrompt: Prompt | null) {
      if (!this.canSend(expectedRevision, expectedPrompt)) return false;
      sent = true;
      return true;
    },
    reject(expectedRevision: number, expectedPrompt: Prompt | null) {
      if (revision === expectedRevision && prompt === expectedPrompt)
        sent = false;
    },
  };
}

// Mirrors ClientField::CancelOrFinish; required selections must never be skipped.
export function secondaryResponse(
  p: Prompt | null,
  count: number,
  valid: boolean,
): "none" | "cancel" | "no" | "finish" {
  if (!p) return "none";
  if (p.kind === "yesno") return "no";
  if (p.kind === "unselect") return p.cancel ? "cancel" : "none";
  if (p.kind === "place") return p.cancel ? "cancel" : "none";
  if (["cards", "tribute"].includes(p.kind)) {
    if (!count && p.cancel) return "cancel";
    return valid ? "finish" : "none";
  }
  if (p.kind === "sum") return valid ? "finish" : "none";
  if (p.kind === "sort" && p.cancel) return "cancel";
  return "none";
}
