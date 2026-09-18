import {
  SESSION_INACTIVITY_MS,
  isAnalyzableInbound,
  shouldRollSession,
} from './core-ingest.service';
import { normalizeWabaInbound } from '../waba/ingest.service';

describe('shouldRollSession', () => {
  const now = new Date('2026-08-27T12:00:00Z');

  it('keeps session when last message is recent', () => {
    const recent = new Date(now.getTime() - 60 * 60 * 1000);
    expect(shouldRollSession(recent, now)).toBe(false);
  });

  it('rolls session after 24h of inactivity', () => {
    const stale = new Date(now.getTime() - SESSION_INACTIVITY_MS - 1000);
    expect(shouldRollSession(stale, now)).toBe(true);
  });

  it('does not roll for brand-new conversation (no lastMessageAt)', () => {
    expect(shouldRollSession(null, now)).toBe(false);
  });
});

describe('isAnalyzableInbound', () => {
  it('publishes text and audio', () => {
    expect(isAnalyzableInbound({ type: 'TEXT', direction: 'IN', body: 'oi' })).toBe(true);
    expect(isAnalyzableInbound({ type: 'AUDIO', direction: 'IN', body: null })).toBe(true);
  });

  it('publishes image/document when caption is in body', () => {
    expect(
      isAnalyzableInbound({ type: 'IMAGE', direction: 'IN', body: 'ferrugem na soja' }),
    ).toBe(true);
    expect(
      isAnalyzableInbound({ type: 'DOCUMENT', direction: 'IN', body: 'pedido 50 galões' }),
    ).toBe(true);
  });

  it('skips image without caption and outbound', () => {
    expect(isAnalyzableInbound({ type: 'IMAGE', direction: 'IN', body: null })).toBe(false);
    expect(isAnalyzableInbound({ type: 'IMAGE', direction: 'IN', body: '  ' })).toBe(false);
    expect(
      isAnalyzableInbound({ type: 'IMAGE', direction: 'OUT', body: 'legenda' }),
    ).toBe(false);
  });
});

describe('normalizeWabaInbound', () => {
  it('prefixes wamid and E.164, maps text', () => {
    const n = normalizeWabaInbound('t1', 'ep1', {
      id: 'wamid.ABC',
      from: '5566999990000',
      timestamp: '1750000000',
      type: 'text',
      text: { body: 'oi' },
    });
    expect(n).toMatchObject({
      tenantId: 't1',
      endpointId: 'ep1',
      peerAddress: '+5566999990000',
      externalId: 'wamid:wamid.ABC',
      direction: 'IN',
      type: 'TEXT',
      body: 'oi',
    });
    expect(n?.sentAt).toEqual(new Date(1750000000 * 1000));
    expect(n?.mediaRef).toBeUndefined();
  });

  it('maps audio to PENDING_MEDIA ref with vendor meta', () => {
    const n = normalizeWabaInbound('t1', 'ep1', {
      id: 'x',
      from: '+55661111',
      type: 'audio',
      audio: { id: 'mid', url: 'https://mm', mime_type: 'audio/ogg' },
    });
    expect(n?.type).toBe('AUDIO');
    expect(n?.body).toBeNull();
    expect(n?.mediaRef).toMatchObject({
      vendor: 'meta',
      metaMediaId: 'mid',
      metaUrl: 'https://mm',
    });
  });

  it('maps image caption into body', () => {
    const n = normalizeWabaInbound('t1', 'ep1', {
      id: 'x',
      from: '+55661111',
      type: 'image',
      image: { id: 'mid', caption: 'a soja da capela' },
    });
    expect(n?.type).toBe('IMAGE');
    expect(n?.body).toBe('a soja da capela');
  });

  it('trims blank image caption to null', () => {
    const n = normalizeWabaInbound('t1', 'ep1', {
      id: 'x',
      from: '+55661111',
      type: 'image',
      image: { id: 'mid', caption: '   ' },
    });
    expect(n?.type).toBe('IMAGE');
    expect(n?.body).toBeNull();
  });

  it('returns null without id or from', () => {
    expect(normalizeWabaInbound('t1', 'ep1', { from: '1' })).toBeNull();
    expect(normalizeWabaInbound('t1', 'ep1', { id: 'x' })).toBeNull();
  });
});
