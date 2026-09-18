import type { PrismaService } from '../prisma/prisma.service';

/** Address do endpoint antes de o RTV conectar (E.164 só depois do pareamento). */
export const pendingAddress = (userId: string) => `pending:${userId}`;

/**
 * Um RTV = um ChannelAccount WA_SESSION = um ChannelEndpoint (address = E.164
 * do RTV). Import de export e conexão Evolution compartilham o mesmo endpoint —
 * é isso que mantém a Conversation estável no cutover para o oficial.
 */
export async function ensureWaSessionEndpoint(
  prisma: PrismaService,
  tenantId: string,
  userId: string,
) {
  const existing = await prisma.channelEndpoint.findFirst({
    where: {
      tenantId,
      assignedUserId: userId,
      channelAccount: { kind: 'WA_SESSION' },
    },
    include: { channelAccount: true },
  });
  if (existing) return existing;

  const account = await prisma.channelAccount.create({
    data: { tenantId, kind: 'WA_SESSION', status: 'DISABLED' },
  });
  return prisma.channelEndpoint.create({
    data: {
      tenantId,
      channelAccountId: account.id,
      address: pendingAddress(userId),
      displayAddress: 'WhatsApp não conectado',
      assignedUserId: userId,
    },
    include: { channelAccount: true },
  });
}
