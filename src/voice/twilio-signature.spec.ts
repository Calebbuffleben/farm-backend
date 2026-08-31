import { createHmac } from 'crypto';
import { verifyTwilioSignature, twilioWebhookUrl } from './twilio-signature';
import { e164, twilioRecordingUrl } from './twilio-media';
import { dialTwiml, hangupTwiml } from './voice.twiml';

describe('verifyTwilioSignature', () => {
  const authToken = 'test-token';
  const url = 'https://farm.example/voice/webhook/acc';
  const params = { CallSid: 'CA123', From: '+5566' };

  it('accepts a valid HMAC-SHA1 signature', () => {
    const data =
      url +
      Object.keys(params)
        .sort()
        .reduce((acc, k) => acc + k + params[k as keyof typeof params], '');
    const sig = createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
    expect(verifyTwilioSignature(authToken, sig, url, params)).toBe(true);
  });

  it('rejects a wrong signature', () => {
    expect(verifyTwilioSignature(authToken, 'aaaa', url, params)).toBe(false);
    expect(verifyTwilioSignature(authToken, undefined, url, params)).toBe(false);
  });
});

describe('twilioWebhookUrl', () => {
  const req = {
    protocol: 'http',
    originalUrl: '/voice/webhook/a',
    get: () => 'localhost:8080',
  };

  afterEach(() => {
    delete process.env.FARM_PUBLIC_URL;
  });

  it('prefers FARM_PUBLIC_URL', () => {
    process.env.FARM_PUBLIC_URL = 'https://farm.example/';
    expect(twilioWebhookUrl(req)).toBe('https://farm.example/voice/webhook/a');
  });
});

describe('twilioRecordingUrl', () => {
  it('appends .mp3 to the callback URL', () => {
    expect(
      twilioRecordingUrl({ recordingUrl: 'https://api.twilio.com/rec/RE1' }),
    ).toBe('https://api.twilio.com/rec/RE1.mp3');
  });

  it('builds REST fallback from sids', () => {
    expect(
      twilioRecordingUrl({
        recordingSid: 'RE9',
        accountSid: 'ACxx',
      }),
    ).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/ACxx/Recordings/RE9.mp3',
    );
  });
});

describe('e164', () => {
  it('normalizes digits', () => {
    expect(e164('5566999990000')).toBe('+5566999990000');
    expect(e164('+55 66 99999-0000')).toBe('+5566999990000');
    expect(e164('12')).toBeNull();
  });
});

describe('twiml', () => {
  it('dials the RTV with recording callback', () => {
    const xml = dialTwiml({
      callerId: '+55661111',
      rtvE164: '+55662222',
      recordingCallback: 'https://farm.example/voice/recording/a',
    });
    expect(xml).toContain('<Dial');
    expect(xml).toContain('+55662222');
    expect(xml).toContain('gravada');
    expect(xml).toContain('https://farm.example/voice/recording/a');
  });

  it('rings Client and Number together for the softphone', () => {
    const xml = dialTwiml({
      callerId: '+55661111',
      rtvE164: '+55662222',
      clientIdentity: 'farm_user-1',
      recordingCallback: 'https://farm.example/voice/recording/a',
    });
    expect(xml).toContain('<Client>farm_user-1</Client>');
    expect(xml).toContain('<Number>+55662222</Number>');
  });

  it('hangs up with a spoken error', () => {
    expect(hangupTwiml('Não foi possível')).toContain('<Hangup/>');
  });
});
