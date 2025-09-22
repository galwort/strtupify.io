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
    const q = query(inboxRef, where('category', '==', 'bank'), orderBy('timestamp', 'asc'));
    this.unsub = onSnapshot(q, (snap: QuerySnapshot<DocumentData>) => {
      const entries = snap.docs.map((d) => {
        const x = d.data() as any;
        const ts = String(x.timestamp || '');
        const msg = String(x.message || '');
        let total = Number(x.payrollTotal || 0);
        if (!isFinite(total) || total <= 0) total = this.parseTotalFromMessage(msg);
        const lines = this.extractLines(x) || this.parseBreakdown(msg);
        if (!isFinite(total) || total <= 0) total = 0;
        return { ts, total, lines } as { ts: string; total: number; lines: { name: string; amount: number }[] };
      });

      const rows: LedgerRow[] = [];
      let running = this.openingCredit;
      rows.push({
        date: this.formatDate(data?.founded_at || new Date().toISOString()),
        description: 'Loan funded',
        payee: 'Fifth Fourth Bank',
        amount: this.openingCredit,
        balance: running,
      });

      for (const e of entries) {
        if ((!isFinite(e.total) || e.total <= 0) && e.lines && e.lines.length) {
          e.total = e.lines.reduce((s, li) => s + (li.amount || 0), 0);
        }
        if (!e.total) continue;
        running = running - e.total;
        rows.push({
          date: this.formatDate(e.ts),
          description: 'Payroll batch withdrawal',
          payee: 'Fifth Fourth Bank',
          amount: -e.total,
          balance: running,
        });
        for (const li of e.lines) {
          rows.push({
            date: '',
            description: 'Payroll',
            payee: li.name,
            amount: -li.amount,
            balance: null,
            sub: true,
          });
        }
      }
      this.totalPayroll = entries.reduce((s, e) => s + (e.total || 0), 0);
      this.rows = rows;
      this.currentBalance = running;
      this.loading = false;
    });
  }

  ngOnDestroy(): void {
    try { if (this.unsub) this.unsub(); } catch {}
    this.unsub = null;
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
