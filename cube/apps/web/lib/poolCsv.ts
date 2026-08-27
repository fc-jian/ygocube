import { CardInfo } from './types';
import { isExtraDeckType, typeLabel } from './cardInfo';

/**
 * Build a UTF-8 CSV export for a public card pool.
 *
 * Keep this client-side so the export uses the same exact card metadata that
 * the preview displays.  A BOM makes Chinese names render correctly in Excel
 * and other Windows spreadsheet programs.  Every cell is escaped according to
 * RFC 4180, including descriptions/names containing commas or quotes.
 */
export function buildPoolCsv(codes: number[], cards: Record<number, CardInfo>): string {
  const escapeCell = (value: unknown): string => {
    const text = String(value ?? '');
    return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
  };
  const rows = [
    ['code', '卡名', 'main/extra', '类型'],
    ...codes.map((code) => {
      const card = cards[code];
      return [
        code,
        card?.name ?? '',
        card && isExtraDeckType(card.type) ? 'extra' : 'main',
        card ? typeLabel(card) : '未知',
      ];
    }),
  ];
  return `\uFEFF${rows.map((row) => row.map(escapeCell).join(',')).join('\r\n')}\r\n`;
}
