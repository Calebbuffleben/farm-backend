import { dealTemperature, type TemperatureInput } from './deal-temperature';

const NOW = new Date('2026-09-15T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

const base: TemperatureInput = {
  stage: 'NEGOCIACAO',
  intent: 'MEDIA',
  urgency: 'MEDIA',
  lastMessageAt: daysAgo(1),
  lastDirection: 'OUT',
};

describe('dealTemperature', () => {
  it('HOT: intenção ou urgência alta com contato recente', () => {
    expect(dealTemperature({ ...base, intent: 'ALTA' }, NOW)).toBe('HOT');
    expect(dealTemperature({ ...base, urgency: 'ALTA', lastMessageAt: daysAgo(3) }, NOW)).toBe(
      'HOT',
    );
  });

  it('WARM: negócio aberto com contato na semana, sem pressa', () => {
    expect(dealTemperature(base, NOW)).toBe('WARM');
    expect(dealTemperature({ ...base, intent: 'ALTA', lastMessageAt: daysAgo(5) }, NOW)).toBe(
      'WARM',
    );
  });

  it('COOLING: entre 7 e 21 dias sem contato', () => {
    expect(dealTemperature({ ...base, lastMessageAt: daysAgo(10) }, NOW)).toBe('COOLING');
  });

  it('COOLING: produtor falou e ninguém respondeu há > 48h, mesmo com intenção alta', () => {
    expect(
      dealTemperature(
        { ...base, intent: 'ALTA', lastMessageAt: hoursAgo(50), lastDirection: 'IN' },
        NOW,
      ),
    ).toBe('COOLING');
    expect(
      dealTemperature(
        { ...base, intent: 'ALTA', lastMessageAt: hoursAgo(20), lastDirection: 'IN' },
        NOW,
      ),
    ).toBe('HOT');
  });

  it('COLD: > 21 dias, SEM_NEGOCIO ou sem contato', () => {
    expect(dealTemperature({ ...base, lastMessageAt: daysAgo(30) }, NOW)).toBe('COLD');
    expect(dealTemperature({ ...base, stage: 'SEM_NEGOCIO', intent: 'ALTA' }, NOW)).toBe('COLD');
    expect(dealTemperature({ ...base, lastMessageAt: null }, NOW)).toBe('COLD');
  });
});
