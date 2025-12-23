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
  groupId: string;
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
  filteredRows: LedgerRow[] = [];
  searchTerm = '';
  totalPayroll = 0;
  currentBalance = 0;
  filteredTotal = 0;
  private unsub: (() => void) | null = null;
  private groupSeq = 0;

  get hasActiveFilter(): boolean {
    return this.searchTerm.trim().length > 0;
  }

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
      where('category', 'in', ['bank', 'supereats', 'mom-gift', 'cadabra']),
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
          if (category === 'mom-gift') {
            const total = this.parseMomGiftAmount(x);
            if (!isFinite(total) || total <= 0) return null;
            const memo = this.parseMomGiftMemo(x);
            return {
              ts,
              kind: 'mom-gift' as const,
              total,
              memo,
            };
          }
          if (category === 'cadabra') {
            const total = this.parseCadabraTotal(x);
            if (!isFinite(total) || total <= 0) return null;
            const memo = this.parseCadabraMemo(x);
            return {
              ts,
              kind: 'cadabra' as const,
              total,
              memo,
            };
          }
          return null;
        })
        .filter((entry): entry is
          | { ts: string; kind: 'bank'; total: number; lines: { name: string; amount: number }[] }
          | { ts: string; kind: 'supereats'; total: number; memo: string }
          | { ts: string; kind: 'mom-gift'; total: number; memo: string }
          | { ts: string; kind: 'cadabra'; total: number; memo: string } => !!entry)
        .sort((a, b) => this.compareTimestamp(a.ts, b.ts));

      const rows: LedgerRow[] = [];
      this.groupSeq = 0;
      let running = this.openingCredit;
      const openingGroup = this.nextGroupId();
      rows.push({
        date: this.formatDate(data?.founded_at || new Date().toISOString()),
        description: 'Loan funded',
        payee: 'Fifth Fourth Bank',
        amount: this.openingCredit,
        balance: running,
        groupId: openingGroup,
      });

      let payrollTotal = 0;
      for (const entry of entries) {
        if (entry.kind === 'bank') {
          const total = entry.total;
          if (!total) continue;
          const groupId = this.nextGroupId();
          payrollTotal += total;
          running -= total;
          rows.push({
            date: this.formatDate(entry.ts),
            description: 'Payroll batch withdrawal',
            payee: 'Fifth Fourth Bank',
            amount: -total,
            balance: running,
            groupId,
          });
          for (const li of entry.lines) {
            rows.push({
              date: '',
              description: 'Payroll',
              payee: li.name,
              amount: -li.amount,
              balance: null,
              groupId,
              sub: true,
            });
          }
        } else if (entry.kind === 'supereats') {
          const total = entry.total;
          const groupId = this.nextGroupId();
          running -= total;
          rows.push({
            date: this.formatDate(entry.ts),
            description: 'Super Eats order',
            payee: 'Super Eats',
            amount: -total,
            balance: running,
            groupId,
          });
          if (entry.memo) {
            rows.push({
              date: '',
              description: entry.memo,
              payee: '',
              amount: 0,
              balance: null,
              groupId,
              sub: true,
            });
          }
        } else if (entry.kind === 'cadabra') {
          const total = entry.total;
          const groupId = this.nextGroupId();
          running -= total;
          rows.push({
            date: this.formatDate(entry.ts),
            description: 'Cadabra order',
            payee: 'Cadabra',
            amount: -total,
            balance: running,
            groupId,
          });
          if (entry.memo) {
            rows.push({
              date: '',
              description: entry.memo,
              payee: '',
              amount: 0,
              balance: null,
              groupId,
              sub: true,
            });
          }
        } else if (entry.kind === 'mom-gift') {
          const total = entry.total;
          const groupId = this.nextGroupId();
          running += total;
          rows.push({
            date: this.formatDate(entry.ts),
            description: 'Gift from Mom',
            payee: 'Mom',
            amount: total,
            balance: running,
            groupId,
          });
          if (entry.memo) {
            rows.push({
              date: '',
              description: entry.memo,
              payee: '',
              amount: 0,
              balance: null,
              groupId,
              sub: true,
            });
          }
        }
      }
      this.totalPayroll = payrollTotal;
      this.rows = rows;
      this.applyFilter();
      this.currentBalance = running;
      this.loading = false;
    });
  }

  ngOnDestroy(): void {
    try { if (this.unsub) this.unsub(); } catch {}
    this.unsub = null;
  }

  onSearch(term: string) {
    this.searchTerm = String(term || '');
    this.applyFilter();
  }

  private applyFilter() {
    const term = this.searchTerm.trim().toLowerCase();
    if (!term) {
      this.filteredRows = this.rows;
      this.filteredTotal = this.computeTotal(this.filteredRows);
      return;
    }
    const parentIndexByGroup = new Map<string, number>();
    this.rows.forEach((row, idx) => {
      if (!row.sub && row.groupId && !parentIndexByGroup.has(row.groupId)) {
        parentIndexByGroup.set(row.groupId, idx);
      }
    });

    const matchedIndexes = new Set<number>();
    this.rows.forEach((row, idx) => {
      const desc = (row.description || '').toLowerCase();
      const payee = (row.payee || '').toLowerCase();
      if (desc.includes(term) || payee.includes(term)) {
        matchedIndexes.add(idx);
        if (row.sub) {
          const parentIdx = parentIndexByGroup.get(row.groupId);
          if (parentIdx !== undefined) matchedIndexes.add(parentIdx);
        }
      }
    });

    this.filteredRows = this.rows.filter((_, idx) => matchedIndexes.has(idx));
    this.filteredTotal = this.computeTotal(this.filteredRows);
  }

  private computeTotal(rows: LedgerRow[]): number {
    const parentsInView = new Set(rows.filter((row) => !row.sub).map((row) => row.groupId));
    return rows.reduce((sum, row) => {
      const shouldSkipSub = row.sub && parentsInView.has(row.groupId);
      if (shouldSkipSub) return sum;
      const amt = Number(row.amount);
      return isFinite(amt) ? sum + amt : sum;
    }, 0);
  }

  private nextGroupId(): string {
    this.groupSeq += 1;
    return `gl-${this.groupSeq}`;
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

  private parseCadabraTotal(x: any): number {
    const candidates = [
      x?.ledgerAmount,
      x?.cadabraTotal,
      x?.cadabra?.total,
      x?.ledger?.amount,
    ];
    for (const raw of candidates) {
      const n = Number(raw);
      if (isFinite(n) && n > 0) return n;
    }
    const msg = String(x?.message || '');
    const match =
      msg.match(/Order total:\s*\$([0-9,.]+)/i) ||
      msg.match(/\$([0-9,.]+)\s+(order\s+total|total)/i);
    if (match && match[1]) {
      const n = Number(match[1].replace(/,/g, ''));
      if (isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  private parseCadabraMemo(x: any): string {
    const direct = String(x?.ledgerMemo || x?.ledger?.memo || '').trim();
    if (direct) return direct;
    const qty = Number(x?.cadabra?.quantity || 0);
    const item = String(x?.cadabra?.item || '').trim();
    if (qty > 0 && item) return `${qty}x ${item}`;
    return 'Company card purchase';
  }

  private parseMomGiftAmount(x: any): number {
    const candidates = [x?.ledgerAmount, x?.momGiftAmount, x?.ledger?.amount];
    for (const raw of candidates) {
      const n = Number(raw);
      if (isFinite(n) && n > 0) return n;
    }
    const msg = String(x?.message || '');
    const match = msg.match(/\$([0-9,.]+)\s*(gift|wire|sent)/i);
    if (match && match[1]) {
      const n = Number(match[1].replace(/,/g, ''));
      if (isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  private parseMomGiftMemo(x: any): string {
    const direct = String(x?.ledgerMemo || x?.ledger?.memo || '').trim();
    if (direct) return direct;
    const tag = String(x?.momGiftNote || '').trim();
    if (tag) return tag;
    return 'Parental gift';
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
