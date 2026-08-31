import {
  analysisAllowed,
  isPendingMediaStale,
  mediaExpiresAt,
  mediaRetentionDays,
  renderPrometheus,
} from './ops.policy';

describe('ops.policy', () => {
  it('defaults retention to 365 days and caps the env', () => {
    expect(mediaRetentionDays(undefined)).toBe(365);
    expect(mediaRetentionDays('0')).toBe(365);
    expect(mediaRetentionDays('30')).toBe(30);
    expect(mediaRetentionDays('99999')).toBe(3650);
  });

  it('sets expiresAt from now + days', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(mediaExpiresAt(now, 2).toISOString()).toBe('2026-01-03T00:00:00.000Z');
  });

  it('flags pending media older than 10 minutes as stale', () => {
    const now = new Date('2026-01-01T00:20:00.000Z');
    expect(
      isPendingMediaStale(new Date('2026-01-01T00:05:00.000Z'), now),
    ).toBe(true);
    expect(
      isPendingMediaStale(new Date('2026-01-01T00:15:00.000Z'), now),
    ).toBe(false);
  });

  it('blocks analysis only when consent was revoked', () => {
    expect(analysisAllowed(null)).toBe(true);
    expect(analysisAllowed({ revokedAt: null })).toBe(true);
    expect(analysisAllowed({ revokedAt: new Date() })).toBe(false);
  });

  it('renders prometheus gauges', () => {
    const text = renderPrometheus([
      { name: 'farm_unknown_pending', help: 'unknown queue', value: 3 },
    ]);
    expect(text).toContain('# TYPE farm_unknown_pending gauge');
    expect(text).toContain('farm_unknown_pending 3');
  });
});
