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
import {
  buildAvatarUrl,
  EndgameOutcome,
  normalizeOutcomeStatus,
  outcomeMood,
} from '../utils/avatar';
import { STRESS_BURNOUT_THRESHOLD } from './stress.service';

export type EndgameStatus = 'idle' | 'triggered' | 'resolved';

export interface EndgameState {
  status: EndgameStatus;
  active: boolean;
  reason?: string;
  triggeredAt?: number;
  resetAt?: number;
}

type EndgameCreditsStats = {
  companyName: string;
  outcome: EndgameOutcome;
  netProfit: number;
  companySize: number;
  tasksCompleted: { done: number; total: number };
  focusPoints: number;
  burnoutCount: number;
  supereatsSpend: number;
  jeffLevel: number | null;
  ttmMs: number;
};

type LedgerTotals = {
  payroll: number;
  supereats: number;
  cadabra: number;
  momGifts: number;
  jeffAttempts: number;
  sawJeff: boolean;
};

@Injectable({ providedIn: 'root' })
export class EndgameService implements OnDestroy {
  private readonly focusPointCost = 1000;
  private fbApp = getApps().length
    ? getApps()[0]
    : initializeApp(environment.firebase);
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
        reason:
          typeof data.endgameReason === 'string'
            ? data.endgameReason
            : undefined,
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

  private async dispatchPostResetEmails(
    simTime?: number,
    monthsHint: number = 6
  ): Promise<void> {
    if (!this.companyId || this.emailInFlight) return;
    this.emailInFlight = true;
    const ref = doc(this.db, 'companies', this.companyId);
    try {
      const snap = await getDoc(ref);
      const data = (snap && (snap.data() as any)) || {};
      if (data.endgameEmailsSent) return;

      const triggeredAt = this.parseTime(data.endgameTriggeredAt);
      const resetAt =
        this.parseTime(data.endgameResetAt) || simTime || Date.now();
      const elapsedMs = triggeredAt
        ? Math.max(0, resetAt - triggeredAt)
        : undefined;
      const months = this.deriveMonths(elapsedMs, monthsHint);
      const meAddress = this.buildFounderAddress(data);
      const emailDate = new Date(resetAt);
      emailDate.setMonth(emailDate.getMonth() + 6);
      const baseMs = emailDate.getTime();
      const vladTimestampIso = new Date(baseMs).toISOString();
      const outcomeTimestampIso = new Date(
        this.jitteredOffset(baseMs, 20_000, 45_000)
      ).toISOString();
      const creditsTimestampIso = new Date(
        this.jitteredOffset(baseMs, 45_000, 75_000)
      ).toISOString();

      const vladSent = await this.sendVladResetEmail(
        meAddress,
        vladTimestampIso,
        elapsedMs
      );
      if (vladSent) await this.delayMs(800, 1500);

      const outcomeResult = await this.sendOutcomeEmail(
        meAddress,
        months,
        outcomeTimestampIso,
        triggeredAt,
        resetAt
      );
      if (outcomeResult.sent) await this.delayMs(800, 1500);

      const creditsStats = await this.buildCreditsStats(
        data,
        outcomeResult.outcomeStatus,
        resetAt
      );
      const creditsSent = creditsStats
        ? await this.sendCreditsEmail(
            meAddress,
            creditsTimestampIso,
            creditsStats
          )
        : false;

      if (vladSent || outcomeResult.sent || creditsSent) {
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
    const source =
      data && typeof data.company_name === 'string' && data.company_name.trim()
        ? data.company_name
        : this.companyId || 'strtupify';
    const normalized =
      source.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'strtupify';
    return `me@${normalized}.com`;
  }

  private async sendVladResetEmail(
    to: string,
    timestampIso: string,
    elapsedMs?: number
  ): Promise<boolean> {
    const ctx = {
      ELAPSED: this.formatElapsedText(elapsedMs),
      ELAPSED_TIME: this.formatElapsedText(elapsedMs),
      COMPANY: this.companyId,
    };
    let tpl: {
      from?: string;
      subject?: string;
      banner?: boolean;
      body: string;
    } = { body: '' };
    try {
      const text = await firstValueFrom(
        this.http.get('emails/vlad-reset.md', { responseType: 'text' })
      );
      tpl = this.parseMarkdownEmail(text);
    } catch {}
    const from = tpl.from || 'vlad@strtupify.io';
    const subject = this.renderTemplate(
      tpl.subject || 'System restored, kind of',
      ctx
    );
    const body = this.renderTemplate(
      tpl.body ||
        `Hello,\n\nIt's Vlad. The system decided to blue-screen itself after you finished everything. It's back now, after ${ctx.ELAPSED}. Please try not to complete all the work at once next time.\n\nThanks,\nVlad`,
      ctx
    );
    const emailId = `vlad-reset-${Date.now()}`;
    try {
      await setDoc(
        doc(this.db, `companies/${this.companyId}/inbox/${emailId}`),
        {
          from,
          to,
          subject,
          message: body,
          deleted: false,
          banner: tpl.banner ?? false,
          timestamp: timestampIso,
          threadId: emailId,
          category: 'vlad',
        }
      );
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
  ): Promise<{
    sent: boolean;
    outcomeStatus: EndgameOutcome;
    estimatedRevenue: number | null;
  }> {
    const companyRef = doc(this.db, 'companies', this.companyId);
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
    const estimatedRevenue = Number.isFinite(estRevenueRaw)
      ? estRevenueRaw
      : null;
    const summary =
      typeof response?.summary === 'string' ? response.summary : '';
    const outcomeStatus = normalizeOutcomeStatus(status, estimatedRevenue);
    const outcomeAvatarMood = outcomeMood(outcomeStatus);

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
            `Quick pulse check: ${
              summary || 'we kept the lights on and shipped what we could.'
            }`,
            estimatedRevenue !== null
              ? `Ballpark revenue: ~$${estimatedRevenue.toLocaleString(
                  undefined,
                  { maximumFractionDigits: 0 }
                )}.`
              : 'Revenue projection: let’s call it break-even plus some snacks.',
            'The system is back up and the team is still standing. Want to weigh in or keep ghosting?',
            `– ${sender.name || sender.from}`,
          ].join('\n\n');
    const from =
      typeof response?.from === 'string' && response.from
        ? response.from
        : sender.from;
    const avatarName = sender.name || this.extractNameFromAddress(from) || '';
    const avatarUrl = buildAvatarUrl(avatarName, outcomeAvatarMood);

    const emailId = `outcome-${Date.now()}`;
    try {
      await setDoc(
        doc(this.db, `companies/${this.companyId}/inbox/${emailId}`),
        {
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
          avatarName: avatarName || null,
          avatarMood: outcomeAvatarMood,
          avatarUrl: avatarUrl || null,
          estimatedRevenue,
          timeframeMonths: months,
          productName: product.name,
        }
      );
      try {
        await updateDoc(companyRef, {
          endgameOutcome: outcomeStatus,
          endgameOutcomeMood: outcomeAvatarMood,
        });
      } catch {}
      return { sent: true, outcomeStatus, estimatedRevenue };
    } catch {
      return { sent: false, outcomeStatus, estimatedRevenue };
    }
  }

  private async buildCreditsStats(
    companyData: any,
    outcomeHint: EndgameOutcome,
    resetAtMs?: number
  ): Promise<EndgameCreditsStats | null> {
    if (!this.companyId) return null;
    const companyName =
      (companyData &&
        typeof companyData.company_name === 'string' &&
        companyData.company_name.trim()) ||
      this.companyId;
    const focusPointsRaw = Number(companyData?.focusPoints ?? 0);
    const focusPointsAvailable = Number.isFinite(focusPointsRaw)
      ? Math.max(0, Math.round(focusPointsRaw))
      : 0;
    const focusPointsSpentRecorded = Math.max(
      0,
      this.safeNumber(companyData?.focusPointsSpent)
    );
    const fundingApproved = !!companyData?.funding?.approved;
    const fundingAmount = fundingApproved
      ? this.safeNumber(companyData?.funding?.amount)
      : 0;

    let companySize = 0;
    let burnoutCount = 0;
    try {
      const employeesSnap = await getDocs(
        query(
          collection(this.db, `companies/${this.companyId}/employees`),
          where('hired', '==', true)
        )
      );
      for (const docSnap of employeesSnap.docs) {
        const data = (docSnap.data() as any) || {};
        companySize += 1;
        const stress = this.safeNumber(data.stress);
        const status = String(data.status || '').toLowerCase();
        const burnedOut =
          status === 'burnout' || stress >= STRESS_BURNOUT_THRESHOLD;
        if (burnedOut) burnoutCount += 1;
      }
    } catch {}
    const focusPointsSpent = Math.max(0, focusPointsSpentRecorded);
    const focusPointsTotal = Math.max(
      0,
      focusPointsAvailable + focusPointsSpent
    );

    let tasksTotal = 0;
    let tasksDone = 0;
    try {
      const workSnap = await getDocs(
        collection(this.db, `companies/${this.companyId}/workitems`)
      );
      workSnap.forEach((docSnap) => {
        const status = String(
          (docSnap.data() as any)?.status || ''
        ).toLowerCase();
        tasksTotal += 1;
        if (status === 'done') tasksDone += 1;
      });
    } catch {}

    const startMs =
      this.parseTime(companyData?.founded_at) ??
      this.parseTime(companyData?.endgameTriggeredAt) ??
      undefined;
    const resetMs = this.parseTime(resetAtMs);
    const ttmMs = startMs && resetMs ? Math.max(0, resetMs - startMs) : 0;

    const ledger = await this.loadLedgerTotals();
    const momGifts = this.safeNumber(ledger.momGifts);
    const netProfit =
      fundingAmount +
      momGifts -
      ledger.payroll -
      ledger.supereats -
      ledger.cadabra;

    const jeffCountCandidates = [
      ledger.jeffAttempts,
      this.safeInt(companyData?.cadabraReplyCount),
      this.safeInt(companyData?.cadabraJeffCount),
    ];
    const maxJeffAttempt = Math.max(
      0,
      ...jeffCountCandidates.filter((n) => Number.isFinite(n))
    );
    const sawJeff = ledger.sawJeff || maxJeffAttempt > 0;
    const jeffLevel = sawJeff
      ? Math.min(5, Math.max(1, maxJeffAttempt || 1)) * 20
      : null;

    const fallbackOutcome = normalizeOutcomeStatus(
      companyData?.endgameOutcome || companyData?.outcomeStatus || '',
      null
    );
    const outcome =
      outcomeHint && outcomeHint !== 'unknown'
        ? outcomeHint
        : fallbackOutcome !== 'unknown'
        ? fallbackOutcome
        : 'unknown';

    return {
      companyName,
      outcome,
      netProfit,
      companySize,
      tasksCompleted: { done: tasksDone, total: tasksTotal },
      focusPoints: focusPointsTotal,
      burnoutCount,
      supereatsSpend: ledger.supereats,
      jeffLevel,
      ttmMs,
    };
  }

  private async loadLedgerTotals(): Promise<LedgerTotals> {
    const totals: LedgerTotals = {
      payroll: 0,
      supereats: 0,
      cadabra: 0,
      momGifts: 0,
      jeffAttempts: 0,
      sawJeff: false,
    };
    if (!this.companyId) return totals;
    try {
      const inboxRef = collection(this.db, `companies/${this.companyId}/inbox`);
      const snap = await getDocs(
        query(
          inboxRef,
          where('category', 'in', ['bank', 'supereats', 'mom-gift', 'cadabra'])
        )
      );
      snap.forEach((docSnap) => {
        const data = (docSnap.data() as any) || {};
        const category = String(data.category || '').toLowerCase();
        if (category === 'bank') {
          totals.payroll += this.parsePayrollTotal(data);
        } else if (category === 'supereats') {
          totals.supereats += this.parseSuperEatsTotal(data);
        } else if (category === 'cadabra') {
          totals.cadabra += this.parseCadabraTotal(data);
          const attempt = this.safeInt(
            data.cadabraReplyAttempt ??
              data.cadabraAttempt ??
              data.cadabraJeffAttempt ??
              data.cadabraReplyCount
          );
          if (attempt > totals.jeffAttempts) totals.jeffAttempts = attempt;
          const from = String(data.from || '').toLowerCase();
          if (from.includes('jeff@cadabra.com')) {
            totals.sawJeff = true;
            if (totals.jeffAttempts < 1) totals.jeffAttempts = 1;
          }
        } else if (category === 'mom-gift') {
          totals.momGifts += this.parseMomGiftAmount(data);
        }
      });
    } catch {}
    totals.payroll = Math.max(0, this.safeNumber(totals.payroll));
    totals.supereats = Math.max(0, this.safeNumber(totals.supereats));
    totals.cadabra = Math.max(0, this.safeNumber(totals.cadabra));
    totals.momGifts = Math.max(0, this.safeNumber(totals.momGifts));
    return totals;
  }

  private async sendCreditsEmail(
    to: string,
    timestampIso: string,
    stats: EndgameCreditsStats
  ): Promise<boolean> {
    const subject = 'Thank you!';
    const outcomeLabel = this.formatOutcomeLabel(stats.outcome);
    const tasksCount = stats.tasksCompleted.total || stats.tasksCompleted.done;
    const tasksLabel = this.formatNumber(tasksCount);
    const lines = [
      'Hello End User,',
      '',
      'Thank you for playing my game!',
      '',
      'STATS',
      `${stats.companyName} - ${outcomeLabel}`,
      `Net Profit: ${this.formatCurrency(stats.netProfit)}`,
      `TTM: ${this.formatElapsedText(stats.ttmMs)}`,
      `Company Size: ${this.formatNumber(stats.companySize)}`,
      `Tasks Completed: ${tasksLabel}`,
      `Focus Points Earned: ${this.formatNumber(stats.focusPoints)}`,
      `Employees Burnt Out: ${this.formatNumber(stats.burnoutCount)}`,
      `Money Spent on Food Delivery: ${this.formatCurrency(
        stats.supereatsSpend
      )}`,
    ];
    if (stats.jeffLevel !== null) {
      lines.push(
        `Jeff Unhinged Level: ${Math.min(100, Math.round(stats.jeffLevel))}%`
      );
    }
    lines.push(
      '',
      'CREDITS',
      'Game Designer - Tom Gorbett',
      'Lead Programmer - Tom Gorbett',
      'UI Designer - Tom Gorbett',
      'Future development work - possibly you??? (please help me)'
    );
    const body = lines.join('\n');
    const emailId = `credits-${Date.now()}`;
    try {
      await setDoc(
        doc(this.db, `companies/${this.companyId}/inbox/${emailId}`),
        {
          from: 'hello@tomgorbett.com',
          to,
          subject,
          message: body,
          deleted: false,
          banner: false,
          timestamp: timestampIso,
          threadId: emailId,
          category: 'credits',
          avatarUrl: 'assets/profile.svg',
          stats: {
            outcome: stats.outcome,
            netProfit: stats.netProfit,
            companySize: stats.companySize,
            tasksDone: stats.tasksCompleted.done,
            tasksTotal: stats.tasksCompleted.total,
            focusPoints: stats.focusPoints,
            burnoutCount: stats.burnoutCount,
            supereatsSpend: stats.supereatsSpend,
            jeffLevel: stats.jeffLevel,
          },
        }
      );
      return true;
    } catch {
      return false;
    }
  }

  private async resolveKickoffSender(): Promise<{
    from: string;
    name: string;
    title: string;
  }> {
    const fallbackDomain =
      this.buildFounderAddress({}).split('@')[1] || 'strtupify.io';
    let from = `kickoff@${fallbackDomain}`;
    let name = 'Kickoff Lead';
    let title = 'Product Lead';
    try {
      const inboxRef = collection(this.db, `companies/${this.companyId}/inbox`);
      const snap = await getDocs(
        query(inboxRef, where('category', '==', 'kickoff'), limit(1))
      );
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

  private async loadAcceptedProduct(): Promise<{
    name: string;
    description: string;
  }> {
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

  private safeNumber(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  private safeInt(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }

  private parsePayrollTotal(entry: any): number {
    const candidates = [
      entry?.payrollTotal,
      entry?.ledgerAmount,
      entry?.ledger?.amount,
    ];
    for (const raw of candidates) {
      const n = this.safeNumber(raw);
      if (n > 0) return n;
    }
    const linesTotal = this.sumPayrollLines(entry);
    if (linesTotal > 0) return linesTotal;
    const msg = String(entry?.message || '');
    const fromMsg = this.parseTotalFromMessage(msg);
    return fromMsg > 0 ? fromMsg : 0;
  }

  private sumPayrollLines(entry: any): number {
    let total = 0;
    try {
      const arr = entry?.payrollLines || [];
      for (const line of arr) {
        const amt = this.safeNumber(line?.amount);
        if (amt > 0) total += amt;
      }
    } catch {}
    if (total > 0) return total;
    const msg = String(entry?.message || '');
    const pattern =
      /^\s*\$([0-9,.]+)\s+[\u2013\u2014-]\s+Payment for\s+(.+)\s*$/i;
    for (const line of msg.split(/\r?\n/)) {
      const match = line.match(pattern);
      if (match && match[1]) {
        const amt = this.safeNumber(match[1].replace(/,/g, ''));
        if (amt > 0) total += amt;
      }
    }
    return total;
  }

  private parseSuperEatsTotal(entry: any): number {
    const candidates = [
      entry?.ledgerAmount,
      entry?.supereatsTotal,
      entry?.supereats?.total,
      entry?.ledger?.amount,
    ];
    for (const raw of candidates) {
      const n = this.safeNumber(raw);
      if (n > 0) return n;
    }
    const msg = String(entry?.message || '');
    const match =
      msg.match(/Total:\s*\$([0-9,.]+)/i) || msg.match(/\$([0-9,.]+)\s+total/i);
    if (match && match[1]) {
      const n = this.safeNumber(match[1].replace(/,/g, ''));
      if (n > 0) return n;
    }
    return 0;
  }

  private parseCadabraTotal(entry: any): number {
    const candidates = [
      entry?.ledgerAmount,
      entry?.cadabraTotal,
      entry?.cadabra?.total,
      entry?.ledger?.amount,
    ];
    for (const raw of candidates) {
      const n = this.safeNumber(raw);
      if (n > 0) return n;
    }
    const msg = String(entry?.message || '');
    const match =
      msg.match(/Order total:\s*\$([0-9,.]+)/i) ||
      msg.match(/\$([0-9,.]+)\s+(order\s+total|total)/i);
    if (match && match[1]) {
      const n = this.safeNumber(match[1].replace(/,/g, ''));
      if (n > 0) return n;
    }
    return 0;
  }

  private parseMomGiftAmount(entry: any): number {
    const candidates = [
      entry?.ledgerAmount,
      entry?.momGiftAmount,
      entry?.ledger?.amount,
    ];
    for (const raw of candidates) {
      const n = this.safeNumber(raw);
      if (n > 0) return n;
    }
    const msg = String(entry?.message || '');
    const match = msg.match(/\$([0-9,.]+)\s*(gift|wire|sent)/i);
    if (match && match[1]) {
      const n = this.safeNumber(match[1].replace(/,/g, ''));
      if (n > 0) return n;
    }
    return 0;
  }

  private parseTotalFromMessage(msg: string): number {
    const match = msg.match(/withdrawal of \$([0-9,.]+)/i);
    if (match && match[1]) {
      const n = this.safeNumber(match[1].replace(/,/g, ''));
      if (n > 0) return n;
    }
    return 0;
  }

  private formatOutcomeLabel(outcome: EndgameOutcome): string {
    if (outcome === 'success') return 'Success!';
    if (outcome === 'failure') return 'Failure :(';
    return 'Unknown';
  }

  private formatCurrency(amount: number): string {
    const n = Number.isFinite(amount) ? amount : 0;
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    return `${sign}$${abs.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  private formatNumber(value: number): string {
    const n = Number.isFinite(value) ? value : 0;
    return n.toLocaleString();
  }

  private async sumEmployeeFocusSpend(employeeId: string): Promise<number> {
    if (!this.companyId || !employeeId) return 0;
    try {
      const snap = await getDocs(
        collection(
          this.db,
          `companies/${this.companyId}/employees/${employeeId}/skills`
        )
      );
      let spent = 0;
      snap.forEach((docSnap) => {
        const levelRaw = this.safeInt((docSnap.data() as any)?.level ?? 1);
        const level = Math.max(1, levelRaw);
        if (level > 1) spent += (level - 1) * this.focusPointCost;
      });
      return spent;
    } catch {
      return 0;
    }
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
    return (body || '').replace(
      /\[\[\s*([A-Za-z0-9_]+)\s*\]\]/g,
      (_, key: string) => {
        const normalized = key.trim().toUpperCase();
        return ctx[normalized] ?? '';
      }
    );
  }

  private formatElapsedText(elapsedMs?: number): string {
    if (!elapsedMs || !Number.isFinite(elapsedMs) || elapsedMs < 0)
      return 'a long while';
    const totalDays = Math.max(
      0,
      Math.floor(elapsedMs / (1000 * 60 * 60 * 24))
    );
    const years = Math.floor(totalDays / 365);
    const remainingAfterYears = totalDays % 365;
    const months = Math.floor(remainingAfterYears / 30);
    const days = remainingAfterYears % 30;

    const parts: string[] = [];
    if (years > 0) parts.push(`${years} year${years === 1 ? '' : 's'}`);
    if (months > 0) parts.push(`${months} month${months === 1 ? '' : 's'}`);
    if (days > 0 || parts.length === 0)
      parts.push(`${days} day${days === 1 ? '' : 's'}`);

    // If under a month, just show days.
    if (years === 0 && months === 0)
      return `${days} day${days === 1 ? '' : 's'}`;
    return parts.join(', ');
  }

  private extractNameFromAddress(address: string): string {
    if (!address) return '';
    const local = address.split('@')[0] || '';
    const parts = local.split(/[.\-_]+/).filter(Boolean);
    if (!parts.length) return local;
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }

  private parseTime(value: any): number | undefined {
    if (value === null || value === undefined) return undefined;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    if (typeof value === 'string') {
      const t = new Date(value).getTime();
      return Number.isFinite(t) ? t : undefined;
    }
    return undefined;
  }

  private jitteredOffset(
    baseMs: number,
    minOffset: number,
    maxOffset: number
  ): number {
    const min = Math.max(0, minOffset);
    const span = Math.max(0, maxOffset - min);
    const jitter = Math.floor(Math.random() * (span + 1));
    return baseMs + min + jitter;
  }

  private delayMs(minMs: number, maxMs: number): Promise<void> {
    const min = Math.max(0, minMs);
    const span = Math.max(0, maxMs - min);
    const jitter = Math.floor(Math.random() * (span + 1));
    const duration = min + jitter;
    return new Promise((resolve) => setTimeout(resolve, duration));
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
