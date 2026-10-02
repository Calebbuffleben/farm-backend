import { BadRequestException } from '@nestjs/common';

import { LeadsService, isHoneypot, normalizeBrPhone, normalizeEmail } from './leads.service';
import type { CreateDemoLeadDto } from './dto/leads.dto';

const dto = (over: Partial<CreateDemoLeadDto> = {}): CreateDemoLeadDto => ({
  name: 'Ana Gestora',
  company: 'Revenda Campo Alto',
  email: 'ana@campoalto.com.br',
  phone: '(16) 99999-1234',
  consent: true,
  ...over,
});

describe('lead helpers', () => {
  it('treats whitespace-only honeypot as empty', () => {
    expect(isHoneypot(undefined)).toBe(false);
    expect(isHoneypot('')).toBe(false);
    expect(isHoneypot('   ')).toBe(false);
    expect(isHoneypot('https://spam.test')).toBe(true);
  });

  it('normalizes e-mail', () => {
    expect(normalizeEmail('  Ana@CampoAlto.com.br ')).toBe('ana@campoalto.com.br');
  });

  it('accepts Brazilian WhatsApp with DDD', () => {
    expect(normalizeBrPhone('(16) 99999-1234')).toBe('16999991234');
    expect(normalizeBrPhone('+55 16 99999-1234')).toBe('5516999991234');
    expect(normalizeBrPhone('123')).toBeNull();
    expect(normalizeBrPhone('351912345678')).toBeNull();
  });
});

describe('LeadsService.createDemo', () => {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    demoLead: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  };
  const mail = { sendMessage: jest.fn() };

  beforeEach(() => {
    created.length = 0;
    prisma.demoLead.findFirst.mockReset().mockResolvedValue(null);
    prisma.demoLead.create.mockReset().mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'lead-1', ...data };
      },
    );
    mail.sendMessage.mockReset().mockResolvedValue({ id: '<mg>' });
    delete process.env.DEMO_NOTIFY_TO;
    delete process.env.DEMO_MAIL_FROM;
    delete process.env.MAILGUN_API_KEY;
    delete process.env.MAILGUN_DOMAIN;
  });

  function svc() {
    return new LeadsService(prisma as never, mail as never);
  }

  it('returns 201-shaped ok and does not persist honeypot', async () => {
    const result = await svc().createDemo(dto({ companyUrl: 'http://bot' }), {});
    expect(result).toEqual({ ok: true });
    expect(prisma.demoLead.create).not.toHaveBeenCalled();
    expect(mail.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects invalid phone', async () => {
    await expect(svc().createDemo(dto({ phone: '123' }), {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('is idempotent for the same e-mail within 24h', async () => {
    prisma.demoLead.findFirst.mockResolvedValue({ id: 'old' });
    const result = await svc().createDemo(dto(), { ip: '1.1.1.1' });
    expect(result).toEqual({ ok: true });
    expect(prisma.demoLead.create).not.toHaveBeenCalled();
    expect(mail.sendMessage).not.toHaveBeenCalled();
  });

  it('persists even when Mailgun is missing', async () => {
    const result = await svc().createDemo(dto({ utmCampaign: 'agro-gestor' }), {
      ip: '200.1.1.1',
      userAgent: 'Mozilla',
    });
    expect(result).toEqual({ ok: true });
    expect(prisma.demoLead.create).toHaveBeenCalledTimes(1);
    expect(created[0].email).toBe('ana@campoalto.com.br');
    expect(created[0].phone).toBe('16999991234');
    expect(created[0].utmCampaign).toBe('agro-gestor');
    expect(typeof created[0].ipHash).toBe('string');
    expect(mail.sendMessage).not.toHaveBeenCalled();
  });

  it('notifies commercial when Mailgun env is set', async () => {
    process.env.DEMO_NOTIFY_TO = 'comercial@farm.test';
    process.env.DEMO_MAIL_FROM = 'Farm <noreply@farm.test>';
    process.env.MAILGUN_API_KEY = 'key-test';
    process.env.MAILGUN_DOMAIN = 'farm.test';
    await svc().createDemo(dto(), {});
    expect(mail.sendMessage).toHaveBeenCalledTimes(1);
    const [creds, message] = mail.sendMessage.mock.calls[0] as [
      { domain: string },
      { to: string },
    ];
    expect(creds).toMatchObject({ domain: 'farm.test' });
    expect(message.to).toBe('comercial@farm.test');
  });

  it('still returns ok if notify throws', async () => {
    process.env.DEMO_NOTIFY_TO = 'comercial@farm.test';
    process.env.DEMO_MAIL_FROM = 'Farm <noreply@farm.test>';
    process.env.MAILGUN_API_KEY = 'key-test';
    process.env.MAILGUN_DOMAIN = 'farm.test';
    mail.sendMessage.mockRejectedValue(new Error('mailgun down'));
    await expect(svc().createDemo(dto(), {})).resolves.toEqual({ ok: true });
    expect(prisma.demoLead.create).toHaveBeenCalled();
  });
});
