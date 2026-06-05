import 'dotenv/config';
import { freshbooksService } from '../services/freshbooks.service';
import { loadTokens } from '../services/freshbooks-token.service';

const STATUS: Record<string, string> = {
  '0': 'disputed', '1': 'draft', '2': 'sent', '3': 'viewed',
  '4': 'paid', '5': 'auto-paid', '6': 'retry', '7': 'failed',
  '8': 'partial', '9': 'paid', '10': 'overdue',
};

async function main() {
  const fbClientId = process.argv[2] ?? '1366857';
  await loadTokens();
  const invs = await freshbooksService.listInvoicesForClient(fbClientId);
  invs.sort((a, b) => (a.issuedDate?.getTime() ?? 0) - (b.issuedDate?.getTime() ?? 0));

  console.log('\nnumber   issued       due          amount        status   balance');
  for (const i of invs) {
    console.log(
      [
        (i.invoiceNumber ?? '').padEnd(8),
        (i.issuedDate?.toISOString().slice(0, 10) ?? '').padEnd(12),
        (i.dueDate?.toISOString().slice(0, 10) ?? '').padEnd(12),
        (i.amount.toFixed(2) + ' ' + i.currency).padEnd(13),
        (STATUS[i.status] ?? i.status).padEnd(8),
        i.balance.toFixed(2),
      ].join(' '),
    );
  }

  const total = invs.length;
  const unpaid = invs.filter((i) => i.balance.toNumber() > 0);
  const amounts = new Set(invs.map((i) => i.amount.toFixed(2) + ' ' + i.currency));
  const days = invs.map((i) => i.issuedDate?.getUTCDate()).filter(Boolean);
  console.log('\n--- summary ---');
  console.log('total invoices :', total);
  console.log('distinct amounts:', [...amounts].join(', '));
  console.log('issue day(s) of month:', [...new Set(days)].sort((a, b) => (a! - b!)).join(', '));
  console.log('first issued   :', invs[0]?.issuedDate?.toISOString().slice(0, 10));
  console.log('last issued    :', invs[total - 1]?.issuedDate?.toISOString().slice(0, 10));
  console.log('unpaid count   :', unpaid.length,
    unpaid.length ? '=> ' + unpaid.map((i) => i.invoiceNumber).join(', ') : '');
}
main().finally(() => process.exit(0));
