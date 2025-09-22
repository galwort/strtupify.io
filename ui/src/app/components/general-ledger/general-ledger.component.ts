import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, getDoc, collection, query, where, orderBy, onSnapshot, QuerySnapshot, DocumentData } from 'firebase/firestore';
import { environment } from 'src/environments/environment';

const fbApp = getApps().length ? getApps()[0] : initializeApp(environment.firebase);
const db = getFirestore(fbApp);

type LedgerRow = {
  date: string;
  description: string;
  payee: string;
  amount: number;
  balance: number | null;
  sub?: boolean;
};

@Component({
  selector: 'app-general-ledger',
  templateUrl: './general-ledger.component.html',
  styleUrls: ['./general-ledger.component.scss'],
  standalone: true,
  imports: [CommonModule],
})
export class GeneralLedgerComponent implements OnInit, OnDestroy {
  @Input() companyId = '';

  loading = true;
  openingCredit = 0;
  rows: LedgerRow[] = [];
  totalPayroll = 0;
  currentBalance = 0;
  private unsub: (() => void) | null = null;

  async ngOnInit() {
    if (!this.companyId) return;
    const companyRef = doc(db, 'companies', this.companyId);
    const snap = await getDoc(companyRef);
    const data = (snap && (snap.data() as any)) || {};
    const funding = data?.funding || {};
    const amount = Number(funding?.amount || 0);
    const approved = !!funding?.approved;
    this.openingCredit = approved ? amount : 0;

    const inboxRef = collection(db, `companies/${this.companyId}/inbox`);
    const q = query(
      inboxRef,
      where('category', 'in', ['bank', 'supereats']),
      orderBy('timestamp', 'asc')
    );
    this.unsub = onSnapshot(q, (snap: QuerySnapshot<DocumentData>) => {
      const entries = snap.docs
        .map((d) => {
          const x = d.data() as any;
          const ts = String(x.timestamp || '');
          const category = String(x.category || '').toLowerCase();
          if (!ts || !category) return null;
          if (category === 'bank') {
            const msg = String(x.message || '');
            let total = Number(x.payrollTotal || 0);
            if (!isFinite(total) || total <= 0) total = this.parseTotalFromMessage(msg);
            const lines = this.extractLines(x) || this.parseBreakdown(msg);
            if (!isFinite(total) || total <= 0) {
              const fallbackTotal = lines.reduce((s, li) => s + (li.amount || 0), 0);
              total = isFinite(fallbackTotal) ? fallbackTotal : 0;
            }
            return {
              ts,
              kind: 'bank' as const,
              total: isFinite(total) && total > 0 ? total : 0,
              lines,
            };
          }
          if (category === 'supereats') {
            const total = this.parseSuperEatsTotal(x);
            if (!isFinite(total) || total <= 0) return null;
            const memo = this.parseSuperEatsMemo(x);
            return {
              ts,
              kind: 'supereats' as const,
              total,
              memo,
            };
          }
          return null;
        })
        .filter((entry): entry is
          | { ts: string; kind: 'bank'; total: number; lines: { name: string; amount: number }[] }
          | { ts: string; kind: 'supereats'; total: number; memo: string } => !!entry)
        .sort((a, b) => this.compareTimestamp(a.ts, b.ts));

      const rows: LedgerRow[] = [];
      let running = this.openingCredit;
      rows.push({
        date: this.formatDate(data?.founded_at || new Date().toISOString()),
        description: 'Loan funded',
        payee: 'Fifth Fourth Bank',
        amount: this.openingCredit,
        balance: running,
      });

      let payrollTotal = 0;
      for (const entry of entries) {
        if (entry.kind === 'bank') {
          const total = entry.total;
          if (!total) continue;
          payrollTotal += total;
          running -= total;
          rows.push({
            date: this.formatDate(entry.ts),
            description: 'Payroll batch withdrawal',
            payee: 'Fifth Fourth Bank',
            amount: -total,
            balance: running,
          });
          for (const li of entry.lines) {
            rows.push({
              date: '',
              description: 'Payroll',
              payee: li.name,
              amount: -li.amount,
              balance: null,
              sub: true,
            });
          }
        } else if (entry.kind === 'supereats') {
          const total = entry.total;
          running -= total;
          rows.push({
            date: this.formatDate(entry.ts),
            description: 'Super Eats order',
            payee: 'Super Eats',
            amount: -total,
            balance: running,
          });
          if (entry.memo) {
            rows.push({
              date: '',
              description: entry.memo,
              payee: '',
              amount: 0,
              balance: null,
              sub: true,
            });
          }
        }
      }
      this.totalPayroll = payrollTotal;
      this.rows = rows;
      this.currentBalance = running;
      this.loading = false;
    });
  }

  ngOnDestroy(): void {
    try { if (this.unsub) this.unsub(); } catch {}
    this.unsub = null;
  }



  private compareTimestamp(a: string, b: string): number {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    const safeTa = isFinite(ta) ? ta : -Infinity;
    const safeTb = isFinite(tb) ? tb : -Infinity;
    if (safeTa === safeTb) return 0;
    return safeTa < safeTb ? -1 : 1;
  }

  private parseSuperEatsTotal(x: any): number {
    const candidates = [
      x?.ledgerAmount,
      x?.supereatsTotal,
      x?.supereats?.total,
      x?.ledger?.amount,
    ];
    for (const raw of candidates) {
      const n = Number(raw);
      if (isFinite(n) && n > 0) return n;
    }
    const msg = String(x?.message || '');
    const match = msg.match(/Total:\s*\$([0-9,.]+)/i) || msg.match(/\$([0-9,.]+)\s+total/i);
    if (match && match[1]) {
      const n = Number(match[1].replace(/,/g, ''));
      if (isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  private parseSuperEatsMemo(x: any): string {
    const direct = String(x?.ledgerMemo || x?.ledger?.memo || '').trim();
    if (direct) return direct;
    const qty = Number(x?.supereatsQuantity || x?.supereats?.quantity || 0);
    const snack = String(x?.supereats?.snack || '').trim();
    if (qty > 0 && snack) return `${qty}x ${snack}`;
    return '';
  }

  private parseBreakdown(msg: string): { name: string; amount: number }[] {
    const out: { name: string; amount: number }[] = [];
    const pattern = /^\s*\$([0-9,.]+)\s+[\u2013\u2014-]\s+Payment for\s+(.+)\s*$/i;
    for (const line of msg.split(/\r?\n/)) {
      const m = line.match(pattern);
      if (m && m[1] && m[2]) {
        const amt = Number(m[1].replace(/,/g, ''));
        const name = m[2].trim();
        if (!isNaN(amt) && name) out.push({ name, amount: amt });
      }
    }
    return out;
  }

  private parseTotalFromMessage(msg: string): number {
    const m = msg.match(/withdrawal of \$([0-9,.]+)/i);
    if (m && m[1]) {
      const n = Number(m[1].replace(/,/g, ''));
      if (!isNaN(n)) return n;
    }
    return 0;
  }

  private parseBreakdownLines(msg: string): { name: string; amount: number }[] {
    const lines: { name: string; amount: number }[] = [];
    for (const line of msg.split(/\r?\n/)) {
      const m = line.match(/^\s*\$([0-9,.]+)\s+[–-]\s+Payment for\s+(.+)\s*$/i);
      if (m && m[1] && m[2]) {
        const amt = Number(m[1].replace(/,/g, ''));
        const name = m[2].trim();
        if (!isNaN(amt) && name) lines.push({ name, amount: amt });
      }
    }
    return lines;
  }

  private extractLines(x: any): { name: string; amount: number }[] | null {
    try {
      const arr = (x && x.payrollLines) || [];
      const out = arr
        .map((v: any) => ({ name: String(v.name || ''), amount: Number(v.amount || 0) }))
        .filter((y: any) => y.name && isFinite(y.amount) && y.amount > 0);
      return out;
    } catch {
      return null;
    }
  }

  private formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleString();
    } catch {
      return '';
    }
  }
}
