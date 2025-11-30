import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { initializeApp, getApps } from 'firebase/app';
import {
  collection,
  doc,
  getDocs,
  getDoc,
  getFirestore,
  limit,
  onSnapshot,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  Unsubscribe,
  where,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';

export type EndgameStatus = 'idle' | 'triggered' | 'resolved';

export interface EndgameState {
  status: EndgameStatus;
  active: boolean;
  reason?: string;
  triggeredAt?: number;
  resetAt?: number;
}

@Injectable({ providedIn: 'root' })
export class EndgameService implements OnDestroy {
  private fbApp = getApps().length ? getApps()[0] : initializeApp(environment.firebase);
  private db = getFirestore(this.fbApp);
  private companyId = '';
  private unsub: Unsubscribe | null = null;
  private emailInFlight = false;

  private stateSubject = new BehaviorSubject<EndgameState>({
    status: 'idle',
    active: false,
  });
  readonly state$ = this.stateSubject.asObservable();

  constructor(private http: HttpClient) {}

  setCompany(companyId: string): void {
    if (companyId === this.companyId) return;
    this.cleanup();
    this.companyId = companyId || '';
    if (!this.companyId) {
      this.stateSubject.next({ status: 'idle', active: false });
      return;
    }
    const ref = doc(this.db, 'companies', this.companyId);
    this.unsub = onSnapshot(ref, (snap) => {
      const data = (snap && (snap.data() as any)) || {};
      const triggered = !!data.endgameTriggered;
      const resolved = !!data.endgameResolved;
      const state: EndgameState = {
        status: resolved ? 'resolved' : triggered ? 'triggered' : 'idle',
        active: triggered && !resolved,
        reason: typeof data.endgameReason === 'string' ? data.endgameReason : undefined,
        triggeredAt: this.parseTime(data.endgameTriggeredAt),
        resetAt: this.parseTime(data.endgameResetAt),
      };
      this.stateSubject.next(state);
    });
  }

  async triggerEndgame(reason: string, simTime?: number): Promise<boolean> {
    if (!this.companyId) return false;
    const ref = doc(this.db, 'companies', this.companyId);
    const now = simTime || Date.now();
    try {
      const result = await runTransaction(this.db, async (tx) => {
        const snap = await tx.get(ref);
        const data = (snap && (snap.data() as any)) || {};
        if (data.endgameTriggered || data.endgameResolved) {
          return false;
        }
        tx.set(
          ref,
          {
            endgameTriggered: true,
            endgameResolved: false,
            endgameTriggeredAt: now,
            endgameReason: reason || 'all-workitems-complete',
            endgameEmailsSent: !!data.endgameEmailsSent,
          },
          { merge: true }
        );
        return true;
      });
      return !!result;
    } catch {
      return false;
    }
  }

  async resolveEndgame(simTime?: number): Promise<boolean> {
    if (!this.companyId) return false;
    const ref = doc(this.db, 'companies', this.companyId);
    const now = simTime || Date.now();
    try {
      const result = await runTransaction(this.db, async (tx) => {
        const snap = await tx.get(ref);
        const data = (snap && (snap.data() as any)) || {};
        if (!data.endgameTriggered || data.endgameResolved) {
          return false;
        }
        tx.set(
          ref,
          {
            endgameResolved: true,
            endgameResetAt: now,
          },
          { merge: true }
        );
        return true;
      });
      return !!result;
    } catch {
      return false;
    }
  }

  async completeResetFlow(monthsHint = 6): Promise<void> {
    if (!this.companyId) return;
    const simTime = await this.getCompanySimTime();
    await this.resolveEndgame(simTime);
    await this.dispatchPostResetEmails(simTime, monthsHint);
  }

  async getCompanySimTime(): Promise<number> {
    if (!this.companyId) return Date.now();
    try {
      const snap = await getDoc(doc(this.db, 'companies', this.companyId));
      const data = (snap && (snap.data() as any)) || {};
      const ts = this.parseTime(data.simTime);
      return ts || Date.now();
    } catch {
      return Date.now();
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  private async dispatchPostResetEmails(simTime?: number, monthsHint: number = 6): Promise<void> {
    if (!this.companyId || this.emailInFlight) return;
    this.emailInFlight = true;
    const ref = doc(this.db, 'companies', this.companyId);
    try {
      const snap = await getDoc(ref);
      const data = (snap && (snap.data() as any)) || {};
      if (data.endgameEmailsSent) return;

      const triggeredAt = this.parseTime(data.endgameTriggeredAt);
      const resetAt = this.parseTime(data.endgameResetAt) || simTime || Date.now();
      const elapsedMs = triggeredAt ? Math.max(0, resetAt - triggeredAt) : undefined;
      const months = this.deriveMonths(elapsedMs, monthsHint);
      const meAddress = this.buildFounderAddress(data);
      const timestampIso = new Date(resetAt).toISOString();

      const vladSent = await this.sendVladResetEmail(meAddress, timestampIso, elapsedMs);
      const outcomeSent = await this.sendOutcomeEmail(meAddress, months, timestampIso, triggeredAt, resetAt);

      if (vladSent || outcomeSent) {
        await updateDoc(ref, { endgameEmailsSent: true });
      }
    } catch (err) {
      console.error('endgame email dispatch failed', err);
    } finally {
      this.emailInFlight = false;
    }
  }

  private deriveMonths(elapsedMs?: number, fallbackMonths: number = 6): number {
    if (elapsedMs && elapsedMs > 0) {
      const approx = Math.round(elapsedMs / (1000 * 60 * 60 * 24 * 30));
      if (approx >= 1) return Math.max(fallbackMonths, Math.min(approx, 24));
    }
    return fallbackMonths;
  }

  private buildFounderAddress(data: any): string {
    const source = (data && typeof data.company_name === 'string' && data.company_name.trim())
      ? data.company_name
      : this.companyId || 'strtupify';
    const normalized = source.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'strtupify';
    return `me@${normalized}.com`;
  }

  private async sendVladResetEmail(to: string, timestampIso: string, elapsedMs?: number): Promise<boolean> {
    const ctx = {
      ELAPSED: this.formatElapsedText(elapsedMs),
      ELAPSED_TIME: this.formatElapsedText(elapsedMs),
      COMPANY: this.companyId,
    };
    let tpl: { from?: string; subject?: string; banner?: boolean; body: string } = { body: '' };
    try {
      const text = await firstValueFrom(this.http.get('emails/vlad-reset.md', { responseType: 'text' }));
      tpl = this.parseMarkdownEmail(text);
    } catch {}
    const from = tpl.from || 'vlad@strtupify.io';
    const subject = this.renderTemplate(tpl.subject || 'System restored, kind of', ctx);
    const body = this.renderTemplate(
      tpl.body ||
        `Hello,\n\nIt's Vlad. The system decided to blue-screen itself after you finished everything. It's back now, after ${ctx.ELAPSED}. Please try not to complete all the work at once next time.\n\nThanks,\nVlad`,
      ctx
    );
    const emailId = `vlad-reset-${Date.now()}`;
    try {
      await setDoc(doc(this.db, `companies/${this.companyId}/inbox/${emailId}`), {
        from,
        to,
        subject,
        message: body,
        deleted: false,
        banner: tpl.banner ?? false,
        timestamp: timestampIso,
        threadId: emailId,
        category: 'vlad',
      });
      return true;
    } catch {
      return false;
    }
  }

  private async sendOutcomeEmail(
    to: string,
    months: number,
    timestampIso: string,
    triggeredAt?: number,
    resetAt?: number
  ): Promise<boolean> {
    const sender = await this.resolveKickoffSender();
    const product = await this.loadAcceptedProduct();
    const payload: any = {
      name: this.companyId,
      months,
    };
    if (triggeredAt) payload.triggeredAt = triggeredAt;
    if (resetAt) payload.resetAt = resetAt;
    if (product.name) payload.productName = product.name;
    if (product.description) payload.productDescription = product.description;

    const url = 'https://fa-strtupifyio.azurewebsites.net/api/endgame_email';
    let response: any = null;
    try {
      response = await firstValueFrom(this.http.post(url, payload));
    } catch {}

    const status = typeof response?.status === 'string' ? response.status : '';
    const estRevenueRaw = Number(response?.estimated_revenue);
    const estimatedRevenue = Number.isFinite(estRevenueRaw) ? estRevenueRaw : null;
    const summary = typeof response?.summary === 'string' ? response.summary : '';

    const subject =
      typeof response?.subject === 'string' && response.subject
        ? response.subject
        : `${product.name} – ${months}-month check-in`;
    const body =
      typeof response?.body === 'string' && response.body
        ? response.body
        : [
            `Hi, this is ${sender.name || 'your kickoff lead'}.`,
            `You went dark for about ${months} months after we shipped ${product.name}.`,
            `Quick pulse check: ${summary || 'we kept the lights on and shipped what we could.'}`,
            estimatedRevenue !== null
              ? `Ballpark revenue: ~$${estimatedRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}.`
              : 'Revenue projection: let’s call it break-even plus some snacks.',
            'The system is back up and the team is still standing. Want to weigh in or keep ghosting?',
            `– ${sender.name || sender.from}`,
          ].join('\n\n');
    const from = typeof response?.from === 'string' && response.from ? response.from : sender.from;

    const emailId = `outcome-${Date.now()}`;
    try {
      await setDoc(doc(this.db, `companies/${this.companyId}/inbox/${emailId}`), {
        from,
        to,
        subject,
        message: body,
        deleted: false,
        banner: false,
        timestamp: timestampIso,
        threadId: emailId,
        category: 'kickoff-outcome',
        outcomeStatus: status || null,
        estimatedRevenue,
        timeframeMonths: months,
        productName: product.name,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async resolveKickoffSender(): Promise<{ from: string; name: string; title: string }> {
    const fallbackDomain = this.buildFounderAddress({}).split('@')[1] || 'strtupify.io';
    let from = `kickoff@${fallbackDomain}`;
    let name = 'Kickoff Lead';
    let title = 'Product Lead';
    try {
      const inboxRef = collection(this.db, `companies/${this.companyId}/inbox`);
      const snap = await getDocs(query(inboxRef, where('category', '==', 'kickoff'), limit(1)));
      if (!snap.empty) {
        const data = (snap.docs[0].data() as any) || {};
        if (typeof data.from === 'string' && data.from.trim()) {
          from = data.from.trim();
          name = this.extractNameFromAddress(from) || name;
        }
      }
    } catch {}
    return { from, name, title };
  }

  private async loadAcceptedProduct(): Promise<{ name: string; description: string }> {
    try {
      const snap = await getDocs(
        query(
          collection(this.db, `companies/${this.companyId}/products`),
          where('accepted', '==', true),
          limit(1)
        )
      );
      if (!snap.empty) {
        const data = (snap.docs[0].data() as any) || {};
        const name = String(data.product || data.name || '').trim();
        const description = String(data.description || '').trim();
        if (name || description) {
          return {
            name: name || this.companyId || 'Flagship Product',
            description,
          };
        }
      }
    } catch {}
    return {
      name: this.companyId || 'Flagship Product',
      description: '',
    };
  }

  private parseMarkdownEmail(text: string): {
    from?: string;
    subject?: string;
    banner?: boolean;
    body: string;
  } {
    const lines = text.split(/\r?\n/);
    let i = 0;
    const meta: any = {};
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) {
        i++;
        break;
      }
      const idx = line.indexOf(':');
      if (idx > -1) {
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (key === 'from') meta.from = value;
        else if (key === 'subject') meta.subject = value;
        else if (key === 'banner') meta.banner = /^true$/i.test(value);
      } else {
        break;
      }
      i++;
    }
    const body = lines.slice(i).join('\n').trim();
    return { ...meta, body };
  }

  private renderTemplate(body: string, ctx: Record<string, string>): string {
    return (body || '').replace(/\[\[\s*([A-Za-z0-9_]+)\s*\]\]/g, (_, key: string) => {
      const normalized = key.trim().toUpperCase();
      return ctx[normalized] ?? '';
    });
  }

  private formatElapsedText(elapsedMs?: number): string {
    if (!elapsedMs || !Number.isFinite(elapsedMs)) return 'a long while';
    const days = Math.max(1, Math.round(elapsedMs / (1000 * 60 * 60 * 24)));
    if (days >= 200) return `about ${Math.round(days / 30)} months`;
    if (days >= 60) return `around ${Math.round(days / 30)} months`;
    if (days >= 14) return `${Math.round(days / 7)} weeks`;
    return `${days} days`;
  }

  private extractNameFromAddress(address: string): string {
    if (!address) return '';
    const local = address.split('@')[0] || '';
    const parts = local.split(/[.\-_]+/).filter(Boolean);
    if (!parts.length) return local;
    return parts
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  }

  private parseTime(value: any): number | undefined {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  private cleanup(): void {
    if (this.unsub) {
      try {
        this.unsub();
      } catch {}
      this.unsub = null;
    }
  }
}
