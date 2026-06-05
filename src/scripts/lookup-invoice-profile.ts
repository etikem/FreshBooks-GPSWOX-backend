/**
 * One-shot lookup: given a client email, print
 *   1. the FreshBooks client record,
 *   2. the actual invoices on the account for that client,
 *   3. the recurring profile(s) / template(s) for that client.
 *
 * Run: npx tsx src/scripts/lookup-invoice-profile.ts <email>
 */
import 'dotenv/config';
import axios from 'axios';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { freshbooksService } from '../services/freshbooks.service';
import {
  loadTokens as loadFreshbooksTokens,
  getAccessToken,
} from '../services/freshbooks-token.service';

async function main(): Promise<void> {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: npx tsx src/scripts/lookup-invoice-profile.ts <email>');
    process.exit(1);
  }

  await loadFreshbooksTokens();

  // 1. Resolve the client in FreshBooks (source of truth).
  const { client, total } = await freshbooksService.findClientByEmail(email);
  console.log('\n=== FreshBooks client lookup ===');
  console.log('search total:', total);
  if (!client) {
    console.log('No FreshBooks client matched that email.');
    await prisma.$disconnect();
    return;
  }
  const fbClientId = String(client.id ?? client.userid ?? '');
  console.log({
    id: fbClientId,
    name: [client.fname, client.lname].filter(Boolean).join(' ') || client.organization,
    organization: client.organization,
    email: client.email,
    signup_date: client.signup_date,
  });

  // 2. Actual invoices.
  const invoices = await freshbooksService.listInvoicesForClient(fbClientId);
  console.log('\n=== Actual invoices (' + invoices.length + ') ===');
  for (const inv of invoices) {
    console.log({
      number: inv.invoiceNumber,
      id: inv.id,
      status: inv.status,
      amount: inv.amount.toFixed(2) + ' ' + inv.currency,
      paid: inv.paid.toFixed(2),
      balance: inv.balance.toFixed(2),
      issued: inv.issuedDate?.toISOString().slice(0, 10) ?? null,
      due: inv.dueDate?.toISOString().slice(0, 10) ?? null,
    });
  }

  // 3. Recurring profiles / templates. This backend never queries these,
  //    so we hit the endpoint raw to show what FreshBooks holds.
  const base = env.FRESHBOOKS_API_BASE.replace(/\/$/, '');
  const url = `${base}/accounting/account/${env.FRESHBOOKS_ACCOUNT_ID}/recurring/recurrings`;
  console.log('\n=== Recurring profiles (templates) ===');
  try {
    const res = await axios.get(url, {
      params: { 'search[customerid]': fbClientId, per_page: 100, page: 1, include: 'lines' },
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
        'Api-Version': 'alpha',
      },
      timeout: 20_000,
    });
    const result = res.data?.response?.result ?? res.data?.response ?? res.data;
    const recurrings = (result?.recurrings ?? []) as Record<string, unknown>[];
    console.log('count:', recurrings.length);
    for (const rp of recurrings) {
      console.log(
        JSON.stringify(
          {
            id: rp.id ?? rp.recurringid,
            invoice_number_prefix: rp.invoice_number,
            status: rp.status ?? rp.v3_status,
            amount: rp.amount,
            frequency: rp.frequency,
            occurrences: rp.occurrences,
            create_date: rp.create_date,
            next_issue: rp.next_issue ?? rp.issue_date,
            end_date: rp.end_date,
            auto_bill: rp.auto_bill,
            lines: rp.lines,
          },
          null,
          2,
        ),
      );
    }
  } catch (err: any) {
    console.log(
      'Could not fetch recurring profiles:',
      err?.response?.status,
      err?.response?.data ? JSON.stringify(err.response.data) : err?.message,
    );
  }

  // Local DB view for cross-reference.
  const local = await prisma.client.findFirst({
    where: { email },
    select: {
      id: true, status: true, gpswoxUserId: true, isUnlimited: true,
      lastPaymentAt: true, accessExpiresAt: true, freshbooksClientId: true,
    },
  });
  console.log('\n=== Local DB row ===');
  console.log(local ?? 'No local row.');
}

main()
  .catch((err) => {
    console.error('lookup failed:', err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
