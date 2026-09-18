/**
 * Regras puras de proteção da linha (sessão não oficial). Sem I/O.
 * O IP que a Meta vê é o do vendor; aqui só controlamos cadência e destinatário.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const REPORT_OPT_OUT_FOOTER = 'Responda 0 para não receber mais relatórios.';
export const REPORT_ELIGIBLE_WINDOW_MS = 14 * DAY_MS;
export const REPORT_JITTER_MS: [number, number] = [15_000, 45_000];
const BUSINESS_TZ = 'America/Sao_Paulo';

/** Rampa de warm-up: dia 0 = 5, dia 1 = 15, dia 2 = 30, depois o teto do tenant. */
export function dailyCap(connectedAt: Date | null, now: Date, steadyCap: number): number {
  if (!connectedAt) return 0;
  const day = Math.floor((now.getTime() - connectedAt.getTime()) / DAY_MS);
  if (day <= 0) return Math.min(5, steadyCap);
  if (day === 1) return Math.min(15, steadyCap);
  if (day === 2) return Math.min(30, steadyCap);
  return steadyCap;
}

export function rampDay(connectedAt: Date | null, now: Date): number {
  if (!connectedAt) return 0;
  return Math.max(0, Math.floor((now.getTime() - connectedAt.getTime()) / DAY_MS)) + 1;
}

/** Chave diária no fuso comercial (o dia vira à meia-noite de Brasília, não UTC). */
export function dayKey(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function saoPauloParts(d: Date): { weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { weekday, hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

/** Seg–sex 08:00–18:00 em Brasília. */
export function inBusinessHours(d: Date): boolean {
  const { weekday, hour } = saoPauloParts(d);
  return weekday >= 1 && weekday <= 5 && hour >= 8 && hour < 18;
}

/**
 * Próximo instante dentro do horário comercial (>= from). Passo de 30 min:
 * ponytail — 30 iterações no pior caso (fim de semana), sem aritmética de fuso.
 */
export function nextBusinessSlot(from: Date): Date {
  let t = new Date(from);
  for (let i = 0; i < 2 * 24 * 4 && !inBusinessHours(t); i++) {
    t = new Date(t.getTime() + 30 * 60 * 1000);
    const { minute } = saoPauloParts(t);
    if (minute % 30 !== 0) t = new Date(t.getTime() - (minute % 30) * 60 * 1000);
  }
  return t;
}

export function jitterMs(rand = Math.random): number {
  const [lo, hi] = REPORT_JITTER_MS;
  return lo + Math.floor(rand() * (hi - lo));
}

/** "0", "parar", "stop", "sair" — só isso ou como primeira palavra. */
export function isOptOutText(body: string | null | undefined): boolean {
  if (!body) return false;
  const first = body.trim().toLowerCase().split(/\s+/)[0] ?? '';
  return ['0', 'parar', 'stop', 'sair'].includes(first.replace(/[.!]+$/, ''));
}

export function reportEligibility(input: {
  optOutAt: Date | null;
  lastInboundAt: Date | null;
  openFacts: number;
  sessionActive: boolean;
  now: Date;
}): { eligible: boolean; reason: string | null } {
  if (!input.sessionActive) return { eligible: false, reason: 'WhatsApp do RTV desconectado' };
  if (input.optOutAt) return { eligible: false, reason: 'produtor pediu para parar' };
  if (!input.lastInboundAt || input.now.getTime() - input.lastInboundAt.getTime() > REPORT_ELIGIBLE_WINDOW_MS) {
    return { eligible: false, reason: 'sem mensagem do produtor nos últimos 14 dias' };
  }
  if (input.openFacts === 0) return { eligible: false, reason: 'nenhum fato aberto' };
  return { eligible: true, reason: null };
}

export function composeReport(producerName: string, headlines: string[]): string {
  const lines = headlines.slice(0, 5).map((h) => `• ${h}`);
  return [`Resumo Farm — ${producerName}`, ...lines, '', REPORT_OPT_OUT_FOOTER].join('\n');
}
