/** Regras puras da Fase 5 (LGPD + retenção + métricas). Sem Prisma. */

export const DEFAULT_MEDIA_RETENTION_DAYS = 365;
export const PENDING_MEDIA_STALE_MS = 10 * 60 * 1000;

export function mediaRetentionDays(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MEDIA_RETENTION_DAYS;
  return Math.min(n, 3650);
}

export function mediaExpiresAt(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

export function isPendingMediaStale(
  createdAt: Date,
  now: Date,
  staleMs = PENDING_MEDIA_STALE_MS,
): boolean {
  return now.getTime() - createdAt.getTime() >= staleMs;
}

/** Sem registro ainda = permitido (primeiro contato cria o grant). Revogado = bloqueia análise. */
export function analysisAllowed(
  record: { revokedAt: Date | null } | null | undefined,
): boolean {
  if (!record) return true;
  return record.revokedAt === null;
}

export function renderPrometheus(
  gauges: Array<{ name: string; help: string; value: number }>,
): string {
  return gauges
    .map(
      (g) =>
        `# HELP ${g.name} ${g.help}\n# TYPE ${g.name} gauge\n${g.name} ${g.value}\n`,
    )
    .join('\n');
}
