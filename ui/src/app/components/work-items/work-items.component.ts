import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { initializeApp, getApps } from 'firebase/app';
import { Subscription } from 'rxjs';
import {
  getFirestore,
  collection,
  onSnapshot,
  DocumentData,
  QuerySnapshot,
  doc,
  onSnapshot as onDocSnapshot,
  setDoc,
  updateDoc,
  getDocs,
  query,
  where,
  limit,
  serverTimestamp,
  getDoc,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { UiStateService } from '../../services/ui-state.service';
import {
  computeStressMetrics,
  getStressMultiplier,
  isBurnedOut,
  StressMetrics,
} from '../../services/stress.service';
import { EndgameService, EndgameStatus } from '../../services/endgame.service';
import { AvatarMood, buildAvatarUrl, burnoutMood, normalizeAvatarMood } from '../../utils/avatar';
import { fallbackEmployeeColor, normalizeEmployeeColor } from '../../utils/employee-colors';
import { EmailCounterService } from '../../services/email-counter.service';

type WorkItem = {
  id: string;
  title: string;
  description: string;
  assignee_id: string;
  complexity: number;
  estimated_hours: number;
  rate_per_hour: number;
  status: string;
  started_at: number;
  blockers?: string[];
  completed_at?: number;
  worked_ms?: number;
  rates?: Record<string, number>;
  assist_status?: string;
  assist_last_sent_at?: number;
  assist_trigger_pct?: number;
};

type HireSummary = {
  id: string;
  name: string;
  title: string;
  level: number;
  stress: number;
  status: 'Active' | 'Burnout';
  load: number;
  multiplier: number;
  stressBase: number;
  stressPerTask: number;
  offHoursAllowed: boolean;
  avatarUrl?: string;
  avatarName?: string;
  avatarMood?: AvatarMood;
  burnout?: boolean;
  initials: string;
  color?: string;
};

type ProductInfo = {
  name: string;
  description: string;
};

const fbApp = getApps().length ? getApps()[0] : initializeApp(environment.firebase);
const db = getFirestore(fbApp);

@Component({
  selector: 'app-work-items',
  templateUrl: './work-items.component.html',
  styleUrls: ['./work-items.component.scss'],
  standalone: true,
  imports: [CommonModule],
})
export class WorkItemsComponent implements OnInit, OnDestroy {
  @Input() companyId = '';

  items: WorkItem[] = [];
  todo: WorkItem[] = [];
  doing: WorkItem[] = [];
  done: WorkItem[] = [];
  simTime: number | null = null;
  hires: HireSummary[] = [];
  hiresLoading = true;

  private speed = 8;
  private tickMs = 150;
  private unsubItems: (() => void) | null = null;
  private unsubCompany: (() => void) | null = null;
  private intervalId: any;
  private draggingId: string | null = null;
  private empById = new Map<string, HireSummary>();
  private titleById = new Map<string, string>();
  private rateCache = new Map<string, Record<string, number>>();
  private lastPersistedStress = new Map<string, { stress: number; status: 'Active' | 'Burnout' }>();
  private hrActivated = false;
  private companyName = '';
  private companyDomain = '';
  private productInfo: ProductInfo | null = null;
  private productInfoLoaded = false;
  private lastAssistCheckWall = 0;
  private assistCheckCooldownMs = 3000;
  private assistProgressCeiling = 85;
  private assistInFlight = new Set<string>();
  private assistFailedAt = new Map<string, number>();
  private assistFailureCooldownMs = 5 * 60 * 1000;
  private assistStartedSim = new Map<string, number>();
  private assistMinSimMs = 20_000;
  private assistTriggerById = new Map<string, number | null>();
  private endgameStatus: EndgameStatus = 'idle';
  private endgameSub: Subscription | null = null;
  private companySnapshotSeen = false;
  private avatarColorCache = new Map<string, string>();
  private pendingAvatarFetches = new Map<string, Promise<void>>();
  private unsubEmployees: (() => void) | null = null;
  private readonly workdayStartHour = 8;
  private readonly workdayEndHour = 17;
  dragHoverColumn: 'todo' | 'doing' | 'done' | null = null;
  private blockerNoticeTimer: any = null;

  constructor(
    private ui: UiStateService,
    private endgame: EndgameService,
    private emailCounter: EmailCounterService
  ) {}

  ngOnInit(): void {
    if (!this.companyId) return;

    this.endgame.setCompany(this.companyId);
    this.endgameSub = this.endgame.state$.subscribe((state) => {
      this.endgameStatus = state.status;
      this.handleEndgameState();
    });

    const itemsRef = collection(db, `companies/${this.companyId}/workitems`);
    this.unsubItems = onSnapshot(itemsRef, (snap: QuerySnapshot<DocumentData>) => {
      this.rateCache.clear();
      this.items = snap.docs.map((d) => {
        const x = d.data() as any;
        const complexityRaw = Number(x.complexity);
        const complexity = Number.isFinite(complexityRaw) && complexityRaw > 0 ? complexityRaw : 3;
        let ratesMap: Record<string, number> | undefined;
        if (x.rates && typeof x.rates === 'object') {
          ratesMap = {};
          for (const [empId, val] of Object.entries(x.rates as Record<string, any>)) {
            const num = Number(val);
            if (Number.isFinite(num)) ratesMap[empId] = num;
          }
          if (Object.keys(ratesMap).length === 0) ratesMap = undefined;
        } else if (x.llm_rates && typeof x.llm_rates === 'object' && (x.llm_rates as any).rates) {
          ratesMap = {};
          for (const [empId, val] of Object.entries((x.llm_rates as any).rates as Record<string, any>)) {
            const num = Number(val);
            if (Number.isFinite(num)) ratesMap[empId] = num;
          }
          if (Object.keys(ratesMap).length === 0) ratesMap = undefined;
        }
        if (ratesMap) this.rateCache.set(d.id, ratesMap);
        const toMillis = (value: any): number | undefined => {
          if (!value) return undefined;
          if (typeof value.toMillis === 'function') return value.toMillis();
          if (value instanceof Date) return value.getTime();
          const num = Number(value);
          return Number.isFinite(num) ? num : undefined;
        };
        const assistStatus = typeof x.assist_status === 'string' ? String(x.assist_status) : '';
        const assistLastSent = toMillis(x.assist_last_sent_at);
        const assistTrigger = this.parseAssistTrigger(x.assist_trigger_pct);
        return {
          id: d.id,
          title: String(x.title || ''),
          description: String(x.description || ''),
          assignee_id: String(x.assignee_id || ''),
          complexity,
          estimated_hours: Number(x.estimated_hours || 0),
          status: String(x.status || ''),
          started_at: Number(x.started_at || 0),
          blockers: Array.isArray(x.blockers) ? (x.blockers as string[]) : [],
          completed_at: Number(x.completed_at || 0),
          worked_ms: Number(x.worked_ms || 0),
          rate_per_hour: Number(x.rate_per_hour || 0),
          rates: ratesMap,
          assist_status: assistStatus,
          assist_last_sent_at: assistLastSent,
          assist_trigger_pct: assistTrigger ?? undefined,
        } as WorkItem;
      });
      this.titleById.clear();
      for (const it of this.items) this.titleById.set(it.id, it.title);
      this.partition();
      this.recomputeStress();
      this.checkEndgameCondition();
      void this.checkAssistanceNeeds();
    });

    this.unsubCompany = onDocSnapshot(doc(db, `companies/${this.companyId}`), (snapshot) => {
      const x = (snapshot && (snapshot.data() as any)) || {};
      this.companySnapshotSeen = true;
      const incomingSimRaw = x.simTime;
      const incomingSim = Number(incomingSimRaw);
      const hasSimTime = Number.isFinite(incomingSim);
      if ((!Number.isFinite(this.simTime) || !this.intervalId) && hasSimTime) {
        this.simTime = incomingSim;
      } else if (hasSimTime && this.simTime !== null && incomingSim > this.simTime) {
        this.simTime = incomingSim;
      }
      this.speed = Number(x.speed || 8);
      if (this.speed <= 0) this.speed = 1;
      if (typeof x.company_name === 'string' && x.company_name.trim().length) {
        this.companyName = x.company_name;
        this.companyDomain = this.normalizeDomain(this.companyName);
      }
      if (!this.companyDomain) {
        this.companyDomain = this.normalizeDomain(this.companyId);
      }
      if (Number.isFinite(this.simTime)) {
        this.partition();
      }
      this.startLocalClock();
    });

    this.subscribeToHires();
    void this.ensureProductInfo();
  }

  ngOnDestroy(): void {
    if (this.unsubItems) this.unsubItems();
    if (this.unsubCompany) this.unsubCompany();
    if (this.unsubEmployees) this.unsubEmployees();
    this.stopLocalClock();
    if (this.blockerNoticeTimer) {
      clearTimeout(this.blockerNoticeTimer);
      this.blockerNoticeTimer = null;
    }
    this.ui.clearBlockerNotice();
    if (this.endgameSub) {
      try {
        this.endgameSub.unsubscribe();
      } catch {}
      this.endgameSub = null;
    }
  }

  private partition() {
    const order = (a: WorkItem, b: WorkItem) => a.title.localeCompare(b.title);
    this.todo = this.items.filter((i) => (i.status || 'todo') === 'todo').sort(order);
    this.doing = this.items
      .filter((i) => i.status === 'doing' || i.status === 'in_progress')
      .sort(order);
    this.done = this.items.filter((i) => i.status === 'done').sort(order);
    const doingIds = new Set(this.doing.map((x) => x.id));
    const nowSim = this.simTime;
    for (const id of doingIds) {
      if (
        !this.assistStartedSim.has(id) &&
        typeof nowSim === 'number' &&
        Number.isFinite(nowSim)
      ) {
        this.assistStartedSim.set(id, nowSim);
      }
    }
    for (const id of Array.from(this.assistStartedSim.keys())) {
      if (!doingIds.has(id)) this.assistStartedSim.delete(id);
    }
    this.pruneAssistTracking();
    this.checkEndgameCondition();
  }

  private checkEndgameCondition(): void {
    if (!this.companyId) return;
    if (this.endgameStatus === 'triggered' || this.endgameStatus === 'resolved') return;
    if (!this.items.length) return;
    const nowSim = this.simTime;
    if (typeof nowSim !== 'number' || !Number.isFinite(nowSim)) return;
    const allDone = this.items.every((it) => (it.status || '').toLowerCase() === 'done');
    if (!allDone) return;
    void this.endgame.triggerEndgame('all-workitems-complete', nowSim);
  }

  private parseAssistTrigger(value: any): number | null | undefined {
    if (value === null || value === undefined) return undefined;
    const num = Number(value);
    if (num === 0) return null;
    if (!Number.isFinite(num)) return undefined;
    const rounded = Math.round(num);
    if (rounded < 1 || rounded > this.assistProgressCeiling) return undefined;
    return rounded;
  }

  private getAssistTriggerPct(it: WorkItem): number | null {
    if (!it || !it.id) return null;
    const stored = this.parseAssistTrigger((it as any).assist_trigger_pct);
    if (stored !== undefined) {
      this.assistTriggerById.set(it.id, stored);
      return stored;
    }
    if (this.assistTriggerById.has(it.id)) {
      const cached = this.assistTriggerById.get(it.id);
      return cached === undefined ? null : cached;
    }
    const derived = this.deriveAssistTrigger(it.id);
    this.assistTriggerById.set(it.id, derived);
    return derived;
  }

  private deriveAssistTrigger(workitemId: string): number | null {
    if (!workitemId) return null;
    const hash = this.simpleHash(workitemId);
    const pct = (hash % this.assistProgressCeiling) + 1;
    return pct;
  }

  private simpleHash(value: string): number {
    let h = 0;
    for (let i = 0; i < value.length; i++) {
      h = (h * 31 + value.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  progress(it: WorkItem): number {
    if (!it.assignee_id || !it.estimated_hours) return 0;
    const emp = this.empById.get(it.assignee_id);
    const burnedOut = emp ? isBurnedOut(emp.status) : false;
    const totalMs = this.totalWorkedMs(it, emp || undefined);
    if (!totalMs) return 0;
    const hours = totalMs / 3_600_000;
    const multiplier = emp ? (burnedOut ? 1 : emp.multiplier) : 1;
    const adjustedHoursNeeded = it.estimated_hours * multiplier;
    if (!adjustedHoursNeeded || !isFinite(adjustedHoursNeeded)) return 0;
    const pct = Math.min(100, Math.max(0, (hours / adjustedHoursNeeded) * 100));
    return Math.round(pct);
  }

  private totalWorkedMs(it: WorkItem, emp?: HireSummary | null): number {
    const base = Number(it.worked_ms || 0);
    const worker = emp || (it.assignee_id ? this.empById.get(it.assignee_id) : null);
    const burnedOut = worker ? isBurnedOut(worker.status) : false;
    const allowOffHours = worker ? !!worker.offHoursAllowed : false;
    const nowSim = this.simTime;
    if (
      !burnedOut &&
      it.status === 'doing' &&
      it.started_at &&
      typeof nowSim === 'number' &&
      Number.isFinite(nowSim)
    ) {
      const delta = this.workingMillisBetween(it.started_at, nowSim, allowOffHours);
      return base + delta;
    }
    return base;
  }

  private workingMillisBetween(startMs: number, endMs: number, allowOffHours = false): number {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return 0;
    }
    if (allowOffHours) {
      return Math.max(0, endMs - startMs);
    }
    const startHour = this.workdayStartHour;
    const endHour = this.workdayEndHour;
    let total = 0;
    let cursor = startMs;
    while (cursor < endMs) {
      const d = new Date(cursor);
      const dayStart = new Date(d.getTime());
      dayStart.setHours(startHour, 0, 0, 0);
      const dayEnd = new Date(d.getTime());
      dayEnd.setHours(endHour, 0, 0, 0);
      const day = d.getDay();
      const isWorkday = day >= 1 && day <= 5;
      if (!isWorkday || cursor >= dayEnd.getTime()) {
        const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
        cursor = nextDay.getTime();
        continue;
      }
      if (cursor < dayStart.getTime()) {
        cursor = dayStart.getTime();
        continue;
      }
      const sliceEnd = Math.min(endMs, dayEnd.getTime());
      if (sliceEnd > cursor) {
        total += sliceEnd - cursor;
        cursor = sliceEnd;
      } else {
        cursor = sliceEnd;
      }
    }
    return total;
  }

  private startLocalClock() {
    if (this.intervalId) return;
    if (this.endgameStatus !== 'idle') return;
    if (!this.companySnapshotSeen) return;
    if (typeof this.simTime !== 'number' || !Number.isFinite(this.simTime)) return;
    let assistTick = 0;
    this.intervalId = setInterval(() => {
      if (typeof this.simTime !== 'number' || !Number.isFinite(this.simTime)) return;
      this.simTime = this.simTime + this.speed * this.tickMs;
      assistTick++;
      if (assistTick % 8 === 0) {
        void this.checkAssistanceNeeds();
      }
    }, this.tickMs);
  }

  private stopLocalClock(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private handleEndgameState(): void {
    const paused = this.endgameStatus !== 'idle';
    if (paused) {
      this.stopLocalClock();
    } else {
      this.startLocalClock();
    }
  }

  private normalizeDomain(source: string): string {
    const normalized = (source || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const base = normalized || this.companyId.toLowerCase();
    return `${base}.com`;
  }

  private getFounderAddress(): string {
    if (!this.companyDomain) {
      this.companyDomain = this.normalizeDomain(this.companyName || this.companyId);
    }
    return `me@${this.companyDomain}`;
  }

  private buildWorkerAddress(name: string): string {
    const normalized = (name || 'teammate').toLowerCase().replace(/[^a-z0-9]+/g, '.');
    const localPart = normalized.replace(/^\.+|\.+$/g, '') || 'teammate';
    const domain = this.companyDomain || this.normalizeDomain(this.companyName || this.companyId);
    return `${localPart}@${domain}`;
  }

  private async ensureProductInfo(): Promise<void> {
    if (!this.companyId) return;
    if (this.productInfo || this.productInfoLoaded) return;
    try {
      const productsRef = collection(db, `companies/${this.companyId}/products`);
      const snap = await getDocs(query(productsRef, where('accepted', '==', true), limit(1)));
      if (!snap.empty) {
        const docSnap = snap.docs[0];
        const data = (docSnap.data() as any) || {};
        const name = String(data.product || data.name || '').trim();
        const description = String(data.description || '').trim();
        if (name && description) {
          this.productInfo = { name, description };
        }
      }
    } catch (err) {
      console.error('Failed to load product info', err);
    } finally {
      if (!this.productInfo) {
        const fallbackName = this.companyName || this.companyId || 'Flagship Product';
        this.productInfo = {
          name: fallbackName,
          description: `Key initiative the team is building at ${fallbackName}.`,
        };
      }
      this.productInfoLoaded = true;
    }
  }

  private createAssistThreadId(workitemId: string): string {
    const seed = Math.random().toString(36).slice(2, 8);
    return `assist-${workitemId}-${Date.now()}-${seed}`;
  }

  private isWorkday(date: Date): boolean {
    const day = date.getDay();
    return day >= 1 && day <= 5;
  }

  private isWithinWorkHours(date: Date): boolean {
    const minutes = date.getHours() * 60 + date.getMinutes();
    return minutes >= this.workdayStartHour * 60 && minutes <= this.workdayEndHour * 60;
  }

  private nextWorkSimTime(baseMs: number): number {
    let cursor = new Date(baseMs);
    while (true) {
      const dayStart = new Date(cursor);
      dayStart.setHours(this.workdayStartHour, 0, 0, 0);
      const dayEnd = new Date(cursor);
      dayEnd.setHours(this.workdayEndHour, 0, 0, 0);
      const isWorkday = this.isWorkday(cursor);
      if (isWorkday && baseMs <= dayEnd.getTime()) {
        if (baseMs < dayStart.getTime()) return dayStart.getTime();
        return baseMs;
      }
      cursor = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  private async getCompanySimState(): Promise<{ simTime: number; speed: number }> {
    if (!this.companyId) return { simTime: Date.now(), speed: 1 };
    try {
      const snap = await getDoc(doc(db, `companies/${this.companyId}`));
      const data = (snap && (snap.data() as any)) || {};
      const simTime = Number(data.simTime || Date.now());
      const speed = Number(data.speed || this.speed || 1);
      return {
        simTime: Number.isFinite(simTime) ? simTime : Date.now(),
        speed: Number.isFinite(speed) && speed > 0 ? speed : 1,
      };
    } catch {
      return { simTime: Date.now(), speed: 1 };
    }
  }

  private async waitForSimTime(targetSimMs: number, currentSimMs: number, speed: number): Promise<void> {
    const lag = Math.max(0, targetSimMs - currentSimMs);
    if (lag <= 0) return;
    const waitMs = Math.max(0, Math.round(lag / Math.max(1, speed)));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  private shouldTriggerAssistance(it: WorkItem): boolean {
    const nowSim = this.simTime;
    if (typeof nowSim !== 'number' || !Number.isFinite(nowSim)) return false;
    if (!it || it.status !== 'doing') return false;
    if (!it.assignee_id) return false;
    if (this.assistInFlight.has(it.id)) return false;
    const lastFailure = this.assistFailedAt.get(it.id);
    if (lastFailure) {
      if (Date.now() - lastFailure < this.assistFailureCooldownMs) return false;
      this.assistFailedAt.delete(it.id);
    }
    const status = String(it.assist_status || '').toLowerCase();
    if (status === 'pending' || status === 'awaiting_reply') return false;
    if (it.assist_last_sent_at) return false;
    const startedAt = Number(it.started_at || 0);
    if (!startedAt) return false;

    const startedSim = this.assistStartedSim.get(it.id);
    if (!startedSim) return false;
    if (nowSim - startedSim < this.assistMinSimMs) return false;

    const assignee = it.assignee_id ? this.empById.get(it.assignee_id) : null;
    const allowOffHours = assignee ? !!assignee.offHoursAllowed : false;
    if (!allowOffHours) {
      const now = new Date(nowSim);
      if (!this.isWorkday(now) || !this.isWithinWorkHours(now)) return false;
    }

    const targetPct = this.getAssistTriggerPct(it);
    if (targetPct === null) return false;

    const progressPct = this.progress(it);
    if (progressPct < targetPct) return false;

    return true;
  }

  private async checkAssistanceNeeds(force = false): Promise<void> {
    if (this.endgameStatus !== 'idle') return;
    if (!this.companyId || !this.doing.length) return;
    if (typeof this.simTime !== 'number' || !Number.isFinite(this.simTime)) return;
    if (!this.productInfo) await this.ensureProductInfo();
    if (!this.productInfo) return;
    const now = Date.now();
    if (!force && now - this.lastAssistCheckWall < this.assistCheckCooldownMs) return;
    this.lastAssistCheckWall = now;
    for (const it of this.doing) {
      if (!this.shouldTriggerAssistance(it)) continue;
      await this.triggerAssistanceEmail(it);
      break;
    }
  }

  private async triggerAssistanceEmail(it: WorkItem): Promise<void> {
    const nowSim = this.simTime;
    if (!this.companyId || !this.productInfo) return;
    if (typeof nowSim !== 'number' || !Number.isFinite(nowSim)) return;
    const assignee = it.assignee_id ? this.empById.get(it.assignee_id) : null;
    if (!assignee) return;
    const allowOffHours = !!assignee.offHoursAllowed;
    const assigneeName = (assignee.name || '').trim();
    const assigneeTitle = (assignee.title || '').trim();
    if (!assigneeName || !assigneeTitle) {
      console.warn('Skipping assistance email due to missing assignee identity', assignee);
      this.assistTriggerById.set(it.id, null);
      this.assistFailedAt.set(it.id, Date.now());
      return;
    }
    const workTitle = (it.title || '').trim();
    const workDescription = (it.description || '').trim();
    if (!workTitle || workDescription.length < 5) {
      console.warn('Skipping assistance email due to missing work item details', {
        id: it.id,
        title: workTitle,
        descriptionLength: workDescription.length,
      });
      this.assistTriggerById.set(it.id, null);
      this.assistFailedAt.set(it.id, Date.now());
      return;
    }
    if (!this.productInfo.name || !this.productInfo.description) {
      console.warn('Skipping assistance email due to missing product info', this.productInfo);
      this.assistFailedAt.set(it.id, Date.now());
      return;
    }
    this.assistInFlight.add(it.id);
    const simState = await this.getCompanySimState();
    const baseSim = Number.isFinite(simState.simTime) ? simState.simTime : nowSim;
    const speed = Number.isFinite(simState.speed) && simState.speed > 0 ? simState.speed : 1;
    let sendSimMs = allowOffHours ? nowSim : this.nextWorkSimTime(nowSim);
    if (!Number.isFinite(sendSimMs)) sendSimMs = baseSim;
    sendSimMs = Math.max(sendSimMs, baseSim);
    if (sendSimMs > baseSim) {
      await this.waitForSimTime(sendSimMs, baseSim, speed);
      const refreshed = await this.getCompanySimState();
      const refreshedSim = Number.isFinite(refreshed.simTime) ? refreshed.simTime : sendSimMs;
      sendSimMs = Math.max(sendSimMs, refreshedSim);
    }
    const latest = this.items.find((x) => x.id === it.id);
    if (!latest || latest.status !== 'doing' || latest.assist_last_sent_at) {
      this.assistInFlight.delete(it.id);
      return;
    }
    const totalWorked = this.totalWorkedMs(it);
    const payload = {
      company: this.companyId,
      product: this.productInfo,
      workitem: {
        id: it.id,
        title: workTitle,
        description: workDescription,
        assignee: { name: assigneeName, title: assigneeTitle },
      },
    };
    try {
      const resp = await fetch('https://fa-strtupifyio.azurewebsites.net/api/workitem_assist_email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error('Assist email failed', resp.status, errText || resp.statusText);
        this.assistFailedAt.set(it.id, Date.now());
        return;
      }
      let data: any;
      try {
        data = await resp.json();
      } catch (parseErr) {
        console.error('Assist email response parse failed', parseErr);
        this.assistFailedAt.set(it.id, Date.now());
        return;
      }
      const email = (data?.email || {}) as any;
      const senderName = typeof email.sender_name === 'string' && email.sender_name ? email.sender_name : assigneeName;
      const senderTitle =
        typeof email.sender_title === 'string' && email.sender_title ? email.sender_title : assigneeTitle;
      const fromAddress = typeof email.from === 'string' && email.from ? email.from : this.buildWorkerAddress(senderName);
      const subject = typeof email.subject === 'string' && email.subject ? email.subject : `Need input on ${it.title}`;
      const body = typeof email.body === 'string' && email.body ? email.body : `${senderName} paused work on ${it.title} and needs your guidance.`;
      const question = typeof email.question === 'string' ? email.question : '';
      const summary = typeof data?.summary === 'string' ? data.summary : '';
      const pauseReason = typeof email.pause_reason === 'string' ? email.pause_reason : '';
      const confidenceRaw = Number(email.confidence);
      const timestampIso = new Date(sendSimMs).toISOString();
      const threadId = this.createAssistThreadId(it.id);
      const emailId = `${threadId}-email`;

      await setDoc(doc(db, `companies/${this.companyId}/inbox/${emailId}`), {
        from: fromAddress,
        to: this.getFounderAddress(),
        subject,
        message: body,
        deleted: false,
        banner: false,
        timestamp: timestampIso,
        threadId,
        category: 'workitem-help',
        workitemId: it.id,
        assistId: threadId,
        assistQuestion: question,
        assistSummary: summary,
        assistPauseReason: pauseReason,
        assistConfidence: Number.isFinite(confidenceRaw) ? confidenceRaw : null,
        senderName,
        senderTitle,
        assistWorkitemTitle: it.title,
        assistWorkitemDescription: it.description,
        productName: this.productInfo?.name,
        productDescription: this.productInfo?.description,
        offHoursAllowed: allowOffHours,
      });
      await this.emailCounter.recordInbound();

      const targetPct = this.getAssistTriggerPct(it);
      const updatePayload: Record<string, any> = {
        assist_status: 'pending',
        assist_last_sent_at: sendSimMs,
        worked_ms: totalWorked,
        started_at: 0,
        updated: serverTimestamp(),
      };
      if (targetPct !== null) {
        updatePayload['assist_trigger_pct'] = targetPct;
      }
      await updateDoc(doc(db, `companies/${this.companyId}/workitems/${it.id}`), updatePayload);

      it.assist_status = 'pending';
      it.assist_last_sent_at = sendSimMs;
      it.started_at = 0;
      it.worked_ms = totalWorked;
      this.partition();
      if (targetPct !== null) this.assistTriggerById.set(it.id, targetPct);
      this.assistFailedAt.delete(it.id);
      this.assistStartedSim.delete(it.id);
    } catch (err) {
      console.error('Failed to create assistance email', err);
      this.assistFailedAt.set(it.id, Date.now());
    } finally {
      this.assistInFlight.delete(it.id);
    }
  }

  private pruneAssistTracking() {
    const activeIds = new Set(this.doing.map((x) => x.id));
    for (const id of Array.from(this.assistFailedAt.keys())) {
      if (!activeIds.has(id)) this.assistFailedAt.delete(id);
    }
    for (const id of Array.from(this.assistStartedSim.keys())) {
      if (!activeIds.has(id)) this.assistStartedSim.delete(id);
    }
    for (const id of Array.from(this.assistTriggerById.keys())) {
      if (!activeIds.has(id)) this.assistTriggerById.delete(id);
    }
  }

  onDragStart(ev: DragEvent, it: WorkItem) {
    this.draggingId = it.id;
    this.dragHoverColumn = null;
    if (ev.dataTransfer) ev.dataTransfer.setData('text/plain', it.id);
  }

  onDragOver(ev: DragEvent, target: 'todo' | 'doing' | 'done') {
    ev.preventDefault();
    if (!this.draggingId) {
      this.dragHoverColumn = null;
      return;
    }
    const it = this.items.find((x) => x.id === this.draggingId);
    if (!it) {
      this.dragHoverColumn = null;
      return;
    }
    const reason = this.dropBlockReason(it, target);
    if (!reason) {
      this.dragHoverColumn = target;
    } else if (this.dragHoverColumn === target) {
      this.dragHoverColumn = null;
    }
  }

  onDragLeave(target: 'todo' | 'doing' | 'done') {
    if (this.dragHoverColumn === target) this.dragHoverColumn = null;
  }

  onDragEnd() {
    this.draggingId = null;
    this.dragHoverColumn = null;
  }

  private dropBlockReason(it: WorkItem, target: 'todo' | 'doing' | 'done'): string | null {
    if (!it || !target) return 'Invalid move.';
    if (target === 'done' || it.status === 'done') return 'Completed items cannot be moved.';
    if (target === it.status) return 'Already in this column.';
    if (target === 'doing') {
      if (!it.assignee_id) return 'Assign this task before starting.';
      const emp = this.empById.get(it.assignee_id);
      if (emp && isBurnedOut(emp.status)) return 'Assignee is burned out.';
      const blockers = this.unresolvedBlockerTitles(it);
      if (blockers.length) {
        return blockers.length === 1
          ? `Blocked by ${blockers[0]}.`
          : `Blocked by ${blockers.join(', ')}.`;
      }
    }
    return null;
  }

  private canDrop(it: WorkItem, target: 'todo' | 'doing' | 'done'): boolean {
    return !this.dropBlockReason(it, target);
  }

  async onDrop(ev: DragEvent, target: 'todo' | 'doing' | 'done') {
    ev.preventDefault();
    const id = (ev.dataTransfer && ev.dataTransfer.getData('text/plain')) || this.draggingId;
    this.draggingId = null;
    this.dragHoverColumn = null;
    if (!id) return;
    const it = this.items.find((x) => x.id === id);
    if (!it) return;
    const blockReason = this.dropBlockReason(it, target);
    if (blockReason) {
      if (target === 'doing') {
        const blockers = this.unresolvedBlockerTitles(it);
        if (blockers.length) {
          const msg = blockers.join('\n');
          this.showBlockerNotice(msg);
        }
      }
      return;
    }
    if (typeof this.simTime !== 'number' || !Number.isFinite(this.simTime)) return;
    const simTime = this.simTime;
    const ref = doc(db, `companies/${this.companyId}/workitems/${id}`);
    const workedMs = this.totalWorkedMs(it);
    const update: any = { status: target, worked_ms: workedMs };
    if (target === 'doing') {
      update.started_at = it.status === 'doing' && it.started_at ? it.started_at : simTime;
    } else {
      update.started_at = 0;
      this.assistStartedSim.delete(it.id);
    }
    it.worked_ms = workedMs;
    it.status = target;
    it.started_at = update.started_at;
    this.partition();
    await updateDoc(ref, update);
    this.recomputeStress();

    if (target === 'doing') {
      void this.checkAssistanceNeeds(true);
    }
  }

  async reassign(it: WorkItem, assigneeId: string) {
    if (it.status === 'done') return;
    const emp = assigneeId ? this.empById.get(assigneeId) : null;
    const ref = doc(db, `companies/${this.companyId}/workitems/${it.id}`);
    if (!emp) {
      const workedMs = this.totalWorkedMs(it);
      const patch: any = {
        assignee_id: '',
        worked_ms: workedMs,
        rates: this.rateCache.get(it.id) || {},
      };
      if (it.status === 'doing') {
        patch.status = 'todo';
        patch.started_at = 0;
      }
      await updateDoc(ref, patch);
      it.assignee_id = '';
      it.worked_ms = workedMs;
      it.rates = this.rateCache.get(it.id) || undefined;
      if (it.status === 'doing') {
        it.status = 'todo';
        it.started_at = 0;
        this.partition();
      }
      this.recomputeStress();
      return;
    }

    if (isBurnedOut(emp.status)) {
      return;
    }

    const rateMap = this.rateCache.get(it.id);
    const llmRateRaw = rateMap ? Number(rateMap[emp.id]) : Number.NaN;
    const hasLlmRate = Number.isFinite(llmRateRaw) && llmRateRaw > 0;
    if (!hasLlmRate) {
      return;
    }
    const normalizedRate = Math.max(0.1, Math.min(5, llmRateRaw));
    const estimatedHours = Math.max(1, Math.round(100 / normalizedRate));
    const ratePerHour = Math.round(normalizedRate * 10000) / 10000;
    const updatePayload: Record<string, any> = {
      assignee_id: emp.id,
      estimated_hours: estimatedHours,
      rate_per_hour: ratePerHour,
    };
    const existingRates = this.rateCache.get(it.id);
    const nextRates = existingRates ? { ...existingRates } : {};
    if (hasLlmRate) nextRates[emp.id] = normalizedRate;
    else if (ratePerHour > 0) nextRates[emp.id] = ratePerHour;
    if (Object.keys(nextRates).length) {
      this.rateCache.set(it.id, nextRates);
      updatePayload['rates'] = nextRates;
    } else {
      this.rateCache.delete(it.id);
      updatePayload['rates'] = {};
    }
    await updateDoc(ref, updatePayload);
    it.assignee_id = emp.id;
    it.estimated_hours = estimatedHours;
    it.rate_per_hour = ratePerHour;
    it.rates = this.rateCache.get(it.id) || undefined;

    this.recomputeStress();
  }

  private subscribeToHires(): void {
    if (!this.companyId) return;
    if (this.unsubEmployees) {
      this.unsubEmployees();
      this.unsubEmployees = null;
    }
    this.hiresLoading = true;
    const ref = query(collection(db, `companies/${this.companyId}/employees`), where('hired', '==', true));
    this.unsubEmployees = onSnapshot(ref, (snap: QuerySnapshot<DocumentData>) => {
      void this.hydrateHiresFromSnapshot(snap);
    });
  }

  private async hydrateHiresFromSnapshot(snap: QuerySnapshot<DocumentData>): Promise<void> {
    this.hiresLoading = true;
    if (!this.companyId) {
      this.hiresLoading = false;
      return;
    }
    try {
      const hires = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      const list: HireSummary[] = [];
      for (const h of hires) {
        const skillsSnap = await getDocs(collection(db, `companies/${this.companyId}/employees/${h.id}/skills`));
        const levels: number[] = [];
        for (const sd of skillsSnap.docs) {
          const sv = (sd.data() as any) || {};
          const lvl = Number(sv.level || 5);
          if (Number.isFinite(lvl)) levels.push(Math.max(1, Math.min(10, lvl)));
        }
        const avg = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 5;
        const persistedStress = Number(h.stress || 0);
        const statusRaw = String(h.status || 'Active');
        const status: 'Active' | 'Burnout' = statusRaw === 'Burnout' ? 'Burnout' : 'Active';
        const directAvatarUrl = String(h.avatarUrl || h.avatar_url || '').trim();
        const avatarName = String(h.avatar || h.photo || h.photoUrl || h.image || '').trim();
        const avatarUrl = directAvatarUrl || buildAvatarUrl(avatarName, 'neutral');
        const initials = this.initialsFor(String(h.name || h.id));
        const name = String(h.name || '');
        const title = String(h.title || '');
        const color = normalizeEmployeeColor(h.calendarColor || h.color) || fallbackEmployeeColor(h.id);
        const stressBaseRaw = Number(h.stressBase ?? h.stress_base ?? 5);
        const stressBase = Number.isFinite(stressBaseRaw) ? Math.max(0, Math.min(100, stressBaseRaw)) : 5;
        const stressPerTaskRaw = Number(h.stressPerTask ?? h.stress_per_task ?? 20);
        const stressPerTask = Number.isFinite(stressPerTaskRaw) ? Math.max(1, Math.min(100, stressPerTaskRaw)) : 20;
        const offHoursAllowed = !!(h.offHoursAllowed ?? h.off_hours_allowed);
        const multiplier = getStressMultiplier(persistedStress, status);
        const base: HireSummary = {
          id: h.id,
          name,
          title,
          level: avg,
          stress: persistedStress,
          status,
          load: Number(h.load || 0),
          multiplier,
          avatarName,
          avatarUrl,
          initials,
          color,
          stressBase,
          stressPerTask,
          offHoursAllowed,
        };
        // Defer recoloring until the new hires list is installed to avoid losing cached avatars.
        list.push(this.applyHireAvatarMood(base, false));
        this.lastPersistedStress.set(h.id, { stress: persistedStress, status });
      }
      this.hires = list;
      this.empById.clear();
      for (const e of list) this.empById.set(e.id, e);
      this.recomputeStress();
    } catch (err) {
      console.error('Failed to load hires', err);
    } finally {
      this.hiresLoading = false;
    }
  }

  private async recomputeStress() {
    if (!this.hires.length) return;

    const loadByEmployee = new Map<string, number>();
    for (const it of this.items) {
      if (!it.assignee_id) continue;
      if (it.status !== 'doing') continue;
      const current = loadByEmployee.get(it.assignee_id) || 0;
      loadByEmployee.set(it.assignee_id, current + 1);
    }

    let anyLoad = false;
    const updates: Array<Promise<void>> = [];

    for (const hire of this.hires) {
      const metrics: StressMetrics = computeStressMetrics(loadByEmployee.get(hire.id) || 0, {
        baseStress: hire.stressBase,
        stressPerTask: hire.stressPerTask,
      });
      anyLoad = anyLoad || metrics.load > 0;
      const wasBurnedOut = hire.status === 'Burnout';
      const nowBurnedOut = metrics.status === 'Burnout';
      if (nowBurnedOut && !wasBurnedOut) {
        void this.pauseWorkitemsForAssignee(hire.id);
      } else if (!nowBurnedOut && wasBurnedOut) {
        void this.resumeWorkitemsForAssignee(hire.id);
      }
      const changed =
        hire.stress !== metrics.stress ||
        hire.status !== metrics.status ||
        hire.load !== metrics.load;

      hire.stress = metrics.stress;
      hire.status = metrics.status;
      hire.load = metrics.load;
      hire.multiplier = isBurnedOut(metrics.status) ? Number.POSITIVE_INFINITY : metrics.multiplier;
      const updated = this.applyHireAvatarMood({ ...hire });
      Object.assign(hire, updated);
      this.empById.set(hire.id, { ...hire });

      const last = this.lastPersistedStress.get(hire.id);
      const needsPersist =
        !last || last.stress !== metrics.stress || last.status !== metrics.status;

      if (needsPersist || changed) {
        updates.push(
          updateDoc(doc(db, `companies/${this.companyId}/employees/${hire.id}`), {
            stress: metrics.stress,
            status: metrics.status,
            load: metrics.load,
          })
            .then(() => {
              this.lastPersistedStress.set(hire.id, {
                stress: metrics.stress,
                status: metrics.status,
              });
            })
            .catch(() => {})
        );
      }
    }

    if (updates.length) {
      await Promise.all(updates);
    }

    if (anyLoad) {
      this.activateHrModuleOnce();
    }
  }

  private async pauseWorkitemsForAssignee(empId: string): Promise<void> {
    if (!this.companyId) return;
    const targets = this.items.filter((it) => it.assignee_id === empId && it.status === 'doing');
    if (!targets.length) return;
    const updates: Array<Promise<void>> = [];
    for (const it of targets) {
      const workedMs = this.totalWorkedMs(it, null);
      it.worked_ms = workedMs;
      it.started_at = 0;
      updates.push(
        updateDoc(doc(db, `companies/${this.companyId}/workitems/${it.id}`), {
          worked_ms: workedMs,
          started_at: 0,
        }).catch(() => {})
      );
    }
    if (updates.length) {
      await Promise.all(updates);
    }
  }

  private async resumeWorkitemsForAssignee(empId: string): Promise<void> {
    if (!this.companyId) return;
    if (typeof this.simTime !== 'number' || !Number.isFinite(this.simTime)) return;
    const simTime = this.simTime;
    const targets = this.items.filter(
      (it) => it.assignee_id === empId && it.status === 'doing' && !it.started_at
    );
    if (!targets.length) return;
    const updates: Array<Promise<void>> = [];
    for (const it of targets) {
      it.started_at = simTime;
      updates.push(
        updateDoc(doc(db, `companies/${this.companyId}/workitems/${it.id}`), {
          started_at: simTime,
        }).catch(() => {})
      );
    }
    if (updates.length) {
      await Promise.all(updates);
    }
  }

  private hireAvatarMood(hire: HireSummary): AvatarMood {
    const mood = burnoutMood(hire.stress, hire.status);
    return normalizeAvatarMood(hire.avatarName || '', mood || 'neutral');
  }

  private applyHireAvatarMood(hire: HireSummary, colorize = true): HireSummary {
    const avatarMood = this.hireAvatarMood(hire);
    const burnout = avatarMood === 'sad';
    const color = normalizeEmployeeColor(hire.color);
    const cacheKey = color ? this.avatarCacheKey(hire, avatarMood, color) : null;
    const cached = cacheKey ? this.avatarColorCache.get(cacheKey) : undefined;
    const builtUrl = hire.avatarName ? buildAvatarUrl(hire.avatarName, avatarMood) : '';
    const avatarUrl = cached || hire.avatarUrl || builtUrl || '';
    const updated: HireSummary = { ...hire, avatarMood, burnout, avatarUrl };
    if (colorize && updated.avatarName && color && !cached) void this.colorizeAvatar(updated, avatarMood);
    return updated;
  }

  private avatarCacheKey(hire: HireSummary, mood: AvatarMood, color: string): string {
    return `${hire.avatarName || ''}|${mood}|${color || ''}`;
  }

  private async colorizeAvatar(hire: HireSummary, mood: AvatarMood = 'neutral'): Promise<void> {
    const color = normalizeEmployeeColor(hire.color);
    if (!color || !hire.avatarName) return;
    const baseUrl = buildAvatarUrl(hire.avatarName, mood);
    if (!baseUrl) return;
    const cacheKey = this.avatarCacheKey(hire, mood, color);
    const cached = this.avatarColorCache.get(cacheKey);
    if (cached) {
      this.applyHireAvatarUrl(hire.id, cached);
      return;
    }
    if (this.pendingAvatarFetches.has(cacheKey)) {
      await this.pendingAvatarFetches.get(cacheKey);
      return;
    }
    const task = (async () => {
      try {
        const resp = await fetch(baseUrl);
        if (!resp.ok) throw new Error(`avatar_status_${resp.status}`);
        const svg = await resp.text();
        const updated = svg.replace(/#262E33/gi, color);
        const uri = this.svgToDataUri(updated);
        this.avatarColorCache.set(cacheKey, uri);
        this.applyHireAvatarUrl(hire.id, uri);
      } catch (err) {
        console.error('Failed to recolor avatar', err);
      } finally {
        this.pendingAvatarFetches.delete(cacheKey);
      }
    })();
    this.pendingAvatarFetches.set(cacheKey, task);
    await task;
  }

  private applyHireAvatarUrl(hireId: string, url: string): void {
    this.hires = this.hires.map((h) => (h.id === hireId ? { ...h, avatarUrl: url } : h));
    const cached = this.empById.get(hireId);
    if (cached) this.empById.set(hireId, { ...cached, avatarUrl: url });
  }

  private svgToDataUri(svg: string): string {
    const encoded = btoa(
      encodeURIComponent(svg).replace(/%([0-9A-F]{2})/g, (_m, p1) =>
        String.fromCharCode(parseInt(p1, 16))
      )
    );
    return `data:image/svg+xml;base64,${encoded}`;
  }

  private activateHrModuleOnce() {
    if (this.hrActivated) return;
    this.hrActivated = true;
    this.ui.setHrEnabled(true);
    if (this.companyId) {
      try {
        void updateDoc(doc(db, `companies/${this.companyId}`), { hrEnabled: true });
      } catch {
        // best-effort persistence
      }
    }
  }

  private unresolvedBlockerTitles(it: WorkItem): string[] {
    const ids = Array.isArray(it.blockers) ? it.blockers : [];
    if (!ids.length) return [];
    const titles: string[] = [];
    for (const id of ids) {
      const b = this.items.find((x) => x.id === id);
      if (!b || b.status === 'done') continue;
      const t = this.titleById.get(id) || b.title || id;
      titles.push(t);
    }
    return titles;
  }

  private showBlockerNotice(message: string): void {
    this.ui.showBlockerNotice(message);
    if (this.blockerNoticeTimer) clearTimeout(this.blockerNoticeTimer);
    this.blockerNoticeTimer = setTimeout(() => {
      this.ui.clearBlockerNotice();
      this.blockerNoticeTimer = null;
    }, 4000);
  }

  blockerTitle(it: WorkItem): string {
    const ids = Array.isArray(it.blockers) ? it.blockers : [];
    if (!ids.length) return 'No blockers';
    const titles: string[] = [];
    for (const id of ids) {
      const b = this.items.find((x) => x.id === id);
      if (!b || b.status === 'done') continue;
      const t = this.titleById.get(id) || id;
      titles.push(t);
    }
    return titles.length ? titles.join('\n') : 'No blockers';
  }

  remainingBlockers(it: WorkItem): number {
    const ids = Array.isArray(it.blockers) ? it.blockers : [];
    if (!ids.length) return 0;
    let n = 0;
    for (const id of ids) {
      const b = this.items.find((x) => x.id === id);
      if (b && b.status !== 'done') n++;
    }
    return n;
  }

  assigneeFor(it: WorkItem): HireSummary | null {
    if (!it.assignee_id) return null;
    return this.empById.get(it.assignee_id) || null;
  }

  private initialsFor(name: string): string {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const first = parts[0].charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return `${first}${last}`.toUpperCase() || first.toUpperCase();
  }
}
