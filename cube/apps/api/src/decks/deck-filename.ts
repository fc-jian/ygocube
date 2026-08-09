export function cubeDeckTimestamp(at = new Date()): string {
  return at.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

export function cubeDeckFileBase(tid: number, playerId: string, at = new Date()): string {
  const safePlayerId = playerId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+|\.+$/g, '') || 'player';
  return `cube-deck-${tid}-${safePlayerId}-${cubeDeckTimestamp(at)}`;
}
