import {
  PrismaClient,
  type ChannelAccount,
  type ChannelAccountStatus,
  type Prisma,
  type WabaAccount,
  type WabaNumber,
} from '@prisma/client';

type Tx = Prisma.TransactionClient | PrismaClient;

type WabaAccountSlice = Pick<
  WabaAccount,
  'id' | 'tenantId' | 'webhookSecret' | 'status'
>;

type WabaNumberSlice = Pick<
  WabaNumber,
  'id' | 'phoneNumberId' | 'displayNumber' | 'assignedUserId'
>;

/** Dual-write: WabaAccount permanece o cofre do token; Channel* é a identidade. */
export async function ensureWabaChannelAccount(
  tx: Tx,
  account: WabaAccountSlice,
): Promise<ChannelAccount> {
  return tx.channelAccount.upsert({
    where: { wabaAccountId: account.id },
    create: {
      tenantId: account.tenantId,
      kind: 'WABA',
      webhookSecret: account.webhookSecret,
      status: account.status as ChannelAccountStatus,
      wabaAccountId: account.id,
    },
    update: {
      webhookSecret: account.webhookSecret,
      status: account.status as ChannelAccountStatus,
    },
  });
}

export async function ensureWabaChannelEndpoint(
  tx: Tx,
  account: WabaAccountSlice,
  number: WabaNumberSlice,
) {
  const channelAccount = await ensureWabaChannelAccount(tx, account);
  return tx.channelEndpoint.upsert({
    where: { wabaNumberId: number.id },
    create: {
      tenantId: account.tenantId,
      channelAccountId: channelAccount.id,
      address: number.phoneNumberId,
      displayAddress: number.displayNumber,
      assignedUserId: number.assignedUserId,
      wabaNumberId: number.id,
    },
    update: {
      displayAddress: number.displayNumber,
      assignedUserId: number.assignedUserId,
    },
  });
}
