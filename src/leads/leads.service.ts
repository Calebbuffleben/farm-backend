import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { EmailClient, type MailgunCreds } from '../email/email.client';
import { CreateDemoLeadDto } from './dto/leads.dto';

const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DemoLeadMeta = { ip?: string; userAgent?: string };

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: EmailClient,
  ) {}

  async createDemo(dto: CreateDemoLeadDto, meta: DemoLeadMeta) {
    if (isHoneypot(dto.companyUrl)) {
      this.logger.warn('demo lead honeypot tripped');
      return { ok: true as const };
    }

    const email = normalizeEmail(dto.email);
    const phone = normalizeBrPhone(dto.phone);
    if (!phone) {
      throw new BadRequestException('phone must be a Brazilian number with DDD');
    }

    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
    const duplicate = await this.prisma.demoLead.findFirst({
      where: { email, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    });
    if (duplicate) {
      return { ok: true as const };
    }

    const lead = await this.prisma.demoLead.create({
      data: {
        name: dto.name,
        company: dto.company,
        email,
        phone,
        consentAt: new Date(),
        utmSource: emptyToNull(dto.utmSource),
        utmMedium: emptyToNull(dto.utmMedium),
        utmCampaign: emptyToNull(dto.utmCampaign),
        utmContent: emptyToNull(dto.utmContent),
        utmTerm: emptyToNull(dto.utmTerm),
        gclid: emptyToNull(dto.gclid),
        ipHash: meta.ip ? hashIp(meta.ip) : null,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
      },
    });

    await this.notifyCommercial(lead);
    return { ok: true as const };
  }

  private async notifyCommercial(lead: {
    name: string;
    company: string;
    email: string;
    phone: string;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    utmContent: string | null;
    utmTerm: string | null;
    gclid: string | null;
  }) {
    const to = process.env.DEMO_NOTIFY_TO?.trim();
    const from = process.env.DEMO_MAIL_FROM?.trim();
    const creds = platformMailgunFromEnv();
    if (!to || !from || !creds) {
      this.logger.warn(
        'demo lead stored without e-mail (DEMO_NOTIFY_TO / DEMO_MAIL_FROM / MAILGUN_* missing)',
      );
      return;
    }
    const lines = [
      'Novo pedido de demonstração Farm',
      '',
      `Nome: ${lead.name}`,
      `Revenda: ${lead.company}`,
      `E-mail: ${lead.email}`,
      `WhatsApp: ${lead.phone}`,
      `utm_source: ${lead.utmSource ?? '—'}`,
      `utm_medium: ${lead.utmMedium ?? '—'}`,
      `utm_campaign: ${lead.utmCampaign ?? '—'}`,
      `utm_content: ${lead.utmContent ?? '—'}`,
      `utm_term: ${lead.utmTerm ?? '—'}`,
      `gclid: ${lead.gclid ?? '—'}`,
    ];
    try {
      await this.mail.sendMessage(creds, {
        from,
        to,
        subject: `Demo Farm — ${lead.company}`,
        text: lines.join('\n'),
      });
    } catch (err) {
      this.logger.warn(
        `demo notify failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function isHoneypot(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Dígitos com DDD; aceita 55. 10–13 dígitos. */
export function normalizeBrPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return null;
  if (digits.length >= 12 && !digits.startsWith('55')) return null;
  return digits;
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

export function platformMailgunFromEnv(): MailgunCreds | null {
  const apiKey = process.env.MAILGUN_API_KEY?.trim();
  const domain = process.env.MAILGUN_DOMAIN?.trim();
  if (!apiKey || !domain) return null;
  return {
    apiKey,
    domain,
    signingKey: '',
    region: process.env.MAILGUN_REGION === 'eu' ? 'eu' : 'us',
  };
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
