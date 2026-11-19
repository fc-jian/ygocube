/** Exact-code ownership and the combined rules-name limit across all deck zones. */
export class DraftCopyAllowance {
  private readonly owned = new Map<number, number>();
  private readonly usedExact = new Map<number, number>();
  private readonly usedByName = new Map<number, number>();

  constructor(picks: readonly number[], private readonly maxCopies: number, private readonly physicalOnly: boolean,
    private readonly ruleCode: (code: number) => number, used: readonly number[] = []) {
    for (const code of picks) this.owned.set(code, (this.owned.get(code) ?? 0) + 1);
    for (const code of used) this.record(code);
  }

  rejection(code: number): 'unpicked' | 'name_limit' | 'quantity' | null {
    if (!this.owned.has(code)) return 'unpicked';
    if ((this.usedByName.get(this.ruleCode(code)) ?? 0) >= this.maxCopies) return 'name_limit';
    if (this.physicalOnly && (this.usedExact.get(code) ?? 0) >= this.owned.get(code)!) return 'quantity';
    return null;
  }

  take(code: number): boolean {
    if (this.rejection(code)) return false;
    this.record(code);
    return true;
  }

  private record(code: number): void {
    const key = this.ruleCode(code);
    this.usedExact.set(code, (this.usedExact.get(code) ?? 0) + 1);
    this.usedByName.set(key, (this.usedByName.get(key) ?? 0) + 1);
  }
}
