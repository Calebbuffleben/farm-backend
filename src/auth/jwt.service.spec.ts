import { AuthJwtService } from './jwt.service';

describe('AuthJwtService (HS256 dev fallback)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-key-please-rotate-in-prod',
      JWT_PRIVATE_KEY: '',
      JWT_PUBLIC_KEY: '',
      JWT_ISSUER: 'meet-backend-test',
      JWT_AUDIENCE: 'meet-platform-test',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('signs and verifies an access token with all required claims including mid', () => {
    const svc = new AuthJwtService();
    const token = svc.sign({
      subject: 'user-123',
      tenantId: 'tenant-abc',
      membershipId: 'membership-xyz',
      role: 'MEMBER',
      jti: 'jti-1',
      type: 'access',
      ttlSeconds: 60,
    });
    expect(typeof token).toBe('string');
    const claims = svc.verify(token, 'access');
    expect(claims.sub).toBe('user-123');
    expect(claims.tid).toBe('tenant-abc');
    expect(claims.mid).toBe('membership-xyz');
    expect(claims.role).toBe('MEMBER');
    expect(claims.jti).toBe('jti-1');
    expect(claims.type).toBe('access');
    expect(claims.iss).toBe('meet-backend-test');
    expect(claims.aud).toBe('meet-platform-test');
  });

  it('rejects the wrong token type', () => {
    const svc = new AuthJwtService();
    const refresh = svc.sign({
      subject: 'u',
      tenantId: 't',
      membershipId: 'm',
      role: 'MEMBER',
      jti: 'j',
      type: 'refresh',
      ttlSeconds: 60,
    });
    expect(() => svc.verify(refresh, 'access')).toThrow(/Unexpected token type/);
  });

  it('rejects tokens signed with a different secret', () => {
    const svcA = new AuthJwtService();
    const token = svcA.sign({
      subject: 'u',
      tenantId: 't',
      membershipId: 'm',
      role: 'MEMBER',
      jti: 'j',
      type: 'access',
      ttlSeconds: 60,
    });
    process.env.JWT_SECRET = 'different-secret';
    const svcB = new AuthJwtService();
    expect(() => svcB.verify(token, 'access')).toThrow(/JWT verification failed/);
  });

  it('throws when no keys are configured', () => {
    process.env.JWT_SECRET = '';
    expect(() => new AuthJwtService()).toThrow(/JWT keys missing/);
  });

  it('rejects an access token without mid (membership id)', () => {
    const svc = new AuthJwtService();
    // Sign a payload manually bypassing the normal mid requirement:
    // use the library API to craft one without `mid`.
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      {
        sub: 'u',
        tid: 't',
        role: 'MEMBER',
        jti: 'j',
        type: 'access',
      },
      process.env.JWT_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: 60,
        issuer: 'meet-backend-test',
        audience: 'meet-platform-test',
      },
    );
    expect(() => svc.verify(token, 'access')).toThrow(
      /JWT payload missing tenant id \(tid\) or membership id \(mid\)/,
    );
  });

  it('allows a global service token without tid or mid', () => {
    const svc = new AuthJwtService();
    const token = svc.sign({
      subject: 'service:ingestion',
      role: 'SERVICE',
      jti: 'svc-1',
      type: 'service',
      ttlSeconds: 60,
    });
    const claims = svc.verify(token, 'service');
    expect(claims.tid).toBeUndefined();
    expect(claims.mid).toBeUndefined();
    expect(claims.role).toBe('SERVICE');
  });

  it('keeps accepting legacy service tokens with tid but without mid', () => {
    const svc = new AuthJwtService();
    const token = svc.sign({
      subject: 'service:ingestion',
      tenantId: 'tenant-abc',
      role: 'SERVICE',
      jti: 'svc-legacy',
      type: 'service',
      ttlSeconds: 60,
    });
    const claims = svc.verify(token, 'service');
    expect(claims.tid).toBe('tenant-abc');
    expect(claims.mid).toBeUndefined();
  });

  it('rejects a service token that carries a mid', () => {
    const svc = new AuthJwtService();
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      {
        sub: 'service:x',
        tid: 't',
        mid: 'not-allowed',
        role: 'SERVICE',
        jti: 'svc',
        type: 'service',
      },
      process.env.JWT_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: 60,
        issuer: 'meet-backend-test',
        audience: 'meet-platform-test',
      },
    );
    expect(() => svc.verify(token, 'service')).toThrow(
      /Service token must not carry a membership id/,
    );
  });
});
