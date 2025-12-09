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
import { AvatarMood, buildAvatarUrl } from '../../utils/avatar';
import { fallbackEmployeeColor, normalizeEmployeeColor } from '../../utils/employee-colors';

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
  avatarUrl?: string;
  avatarName?: string;
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
  simTime = Date.now();
  hires: HireSummary[] = [];

  private speed = 8;
  private tickMs = 150;
  private unsubItems: (() => void) | null = null;
  private unsubCompany: (() => void) | null = null;
  private intervalId: any;
  private draggingId: string | null = null;
  private empById = new Map<string, HireSummary>();
  private titleById = new Map<string, string>();
  private rateCache = new Map<string, Record<string, number>>();
  private pendingRateRequest = false;
  private lastRateRefresh = 0;
  private rateRefreshCooldownMs = 12_000;
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
  private assistChanceTarget = 0.2;
  private assistTriggerById = new Map<string, number | null>();
  private assistTriggerPersisted = new Set<string>();
  private endgameStatus: EndgameStatus = 'idle';
  private endgameSub: Subscription | null = null;
  private companySnapshotSeen = false;
  private avatarColorCache = new Map<string, string>();
  private pendingAvatarFetches = new Map<string, Promise<void>>();

  constructor(private ui: UiStateService, private endgame: EndgameService) {}

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
      this.scheduleRateGeneration();
      this.recomputeStress();
      this.checkEndgameCondition();
      void this.checkAssistanceNeeds();
    });

    this.unsubCompany = onDocSnapshot(doc(db, `companies/${this.companyId}`), (snapshot) => {
      const x = (snapshot && (snapshot.data() as any)) || {};
      this.companySnapshotSeen = true;
      const incomingSim = Number(x.simTime || Date.now());
      if (!Number.isFinite(this.simTime) || !this.intervalId) {
        this.simTime = Number.isFinite(incomingSim) ? incomingSim : Date.now();
      } else if (Number.isFinite(incomingSim) && incomingSim > this.simTime) {
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
      this.startLocalClock();
    });

    void this.loadHires();
    void this.ensureProductInfo();
  }

  ngOnDestroy(): void {
    if (this.unsubItems) this.unsubItems();
    if (this.unsubCompany) this.unsubCompany();
    this.stopLocalClock();
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
      if (!this.assistStartedSim.has(id)) this.assistStartedSim.set(id, nowSim);
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
    const allDone = this.items.every((it) => (it.status || '').toLowerCase() === 'done');
    if (!allDone) return;
    void this.endgame.triggerEndgame('all-workitems-complete', this.simTime);
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

  private randomFraction(): number {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return buf[0] / 0xffffffff;
    }
    return Math.random();
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
    const chance = this.randomFraction();
    if (chance >= this.assistChanceTarget) {
      this.assistTriggerById.set(it.id, null);
      void this.persistAssistSkip(it.id);
      return null;
    }
    const pct = Math.floor(this.randomFraction() * this.assistProgressCeiling) + 1;
    this.assistTriggerById.set(it.id, pct);
    void this.persistAssistTrigger(it.id, pct);
    return pct;
  }

  private async persistAssistTrigger(workitemId: string, targetPct: number): Promise<void> {
    if (!this.companyId || this.assistTriggerPersisted.has(workitemId)) return;
    this.assistTriggerPersisted.add(workitemId);
    try {
      await updateDoc(doc(db, `companies/${this.companyId}/workitems/${workitemId}`), {
        assist_trigger_pct: targetPct,
      });
    } catch {
      // best-effort; ignore failures
    }
  }

  private async persistAssistSkip(workitemId: string): Promise<void> {
    if (!this.companyId || this.assistTriggerPersisted.has(workitemId)) return;
    this.assistTriggerPersisted.add(workitemId);
    try {
      await updateDoc(doc(db, `companies/${this.companyId}/workitems/${workitemId}`), {
        assist_trigger_pct: 0,
      });
    } catch {
      // best-effort; ignore failures
    }
  }

  progress(it: WorkItem): number {
    if (!it.assignee_id || !it.estimated_hours) return 0;
    const emp = this.empById.get(it.assignee_id);
    if (emp && isBurnedOut(emp.status)) return 0;
    const totalMs = this.totalWorkedMs(it);
    if (!totalMs) return 0;
    const hours = totalMs / 3_600_000;
    const multiplier = emp ? emp.multiplier : 1;
    const adjustedHoursNeeded = it.estimated_hours * multiplier;
    if (!adjustedHoursNeeded || !isFinite(adjustedHoursNeeded)) return 0;
    const pct = Math.min(100, Math.max(0, (hours / adjustedHoursNeeded) * 100));
    return Math.round(pct);
  }

  private totalWorkedMs(it: WorkItem): number {
    const base = Number(it.worked_ms || 0);
    if (it.status === 'doing' && it.started_at) {
      const delta = Math.max(0, this.simTime - it.started_at);
      return base + delta;
    }
    return base;
  }

  private startLocalClock() {
    if (this.intervalId) return;
    if (this.endgameStatus !== 'idle') return;
    if (!this.companySnapshotSeen) return;
    let assistTick = 0;
    this.intervalId = setInterval(() => {
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

  private scheduleRateGeneration(force = false) {
    if (!this.companyId || !this.items.length || !this.hires.length) return;
    if (this.pendingRateRequest) return;
    const now = Date.now();
    if (!force && now - this.lastRateRefresh < this.rateRefreshCooldownMs) return;
    void this.requestRatesFromLlm();
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

  private shouldTriggerAssistance(it: WorkItem): boolean {
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
    if (this.simTime - startedSim < this.assistMinSimMs) return false;

    const targetPct = this.getAssistTriggerPct(it);
    if (targetPct === null) return false;

    const progressPct = this.progress(it);
    if (progressPct < targetPct) return false;

    return true;
  }

  private async checkAssistanceNeeds(force = false): Promise<void> {
    if (this.endgameStatus !== 'idle') return;
    if (!this.companyId || !this.doing.length) return;
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
    if (!this.companyId || !this.productInfo) return;
    const assignee = it.assignee_id ? this.empById.get(it.assignee_id) : null;
    if (!assignee) return;
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
      const timestampIso = new Date(this.simTime).toISOString();
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
      });

      const targetPct = this.getAssistTriggerPct(it);
      const updatePayload: Record<string, any> = {
        assist_status: 'pending',
        assist_last_sent_at: this.simTime,
        worked_ms: totalWorked,
        started_at: 0,
        updated: serverTimestamp(),
      };
      if (targetPct !== null) {
        updatePayload['assist_trigger_pct'] = targetPct;
      }
      await updateDoc(doc(db, `companies/${this.companyId}/workitems/${it.id}`), updatePayload);

      it.assist_status = 'pending';
      it.assist_last_sent_at = this.simTime;
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

  private async requestRatesFromLlm() {
    if (!this.companyId) return;
    this.pendingRateRequest = true;
    const url = 'https://fa-strtupifyio.azurewebsites.net/api/estimate';
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company: this.companyId }),
      });
      if (!resp.ok) throw new Error(`rate request failed: ${resp.status}`);
      const data = await resp.json();
      const rates = data?.rates as Record<string, any> | undefined;
      this.rateCache.clear();
      if (rates && typeof rates === 'object') {
        for (const [workId, entries] of Object.entries(rates)) {
          const normalized: Record<string, number> = {};
          if (entries && typeof entries === 'object') {
            for (const [empId, value] of Object.entries(entries as Record<string, any>)) {
              const num = Number(value);
              if (Number.isFinite(num)) normalized[empId] = num;
            }
          }
          this.rateCache.set(workId, normalized);
        }
      }
      this.lastRateRefresh = Date.now();
    } catch (err) {
      console.error('Failed to refresh LLM rates', err);
    } finally {
      this.pendingRateRequest = false;
    }
  }

  onDragStart(ev: DragEvent, it: WorkItem) {
    this.draggingId = it.id;
    if (ev.dataTransfer) ev.dataTransfer.setData('text/plain', it.id);
  }

  onDragOver(ev: DragEvent) {
    ev.preventDefault();
  }

  async onDrop(ev: DragEvent, target: 'todo' | 'doing' | 'done') {
    ev.preventDefault();
    const id = (ev.dataTransfer && ev.dataTransfer.getData('text/plain')) || this.draggingId;
    this.draggingId = null;
    if (!id) return;
    const it = this.items.find((x) => x.id === id);
    if (!it) return;
    if (it.status === target) return;

    if (target === 'done' || it.status === 'done') return;
    if (target === 'doing') {
      if (!it.assignee_id) return;
      const emp = this.empById.get(it.assignee_id);
      if (emp && isBurnedOut(emp.status)) return;
    }
    if (target === 'doing') {
      const blockers = Array.isArray(it.blockers) ? it.blockers : [];
      if (blockers.length) {
        for (const bid of blockers) {
          const b = this.items.find((x) => x.id === bid);
          if (!b || b.status !== 'done') return;
        }
      }
    }
    const ref = doc(db, `companies/${this.companyId}/workitems/${id}`);
    const workedMs = this.totalWorkedMs(it);
    const update: any = { status: target, worked_ms: workedMs };
    if (target === 'doing') {
      update.started_at = it.status === 'doing' && it.started_at ? it.started_at : this.simTime;
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
      this.scheduleRateGeneration(true);
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

    const level = emp.level;
    const rateMap = this.rateCache.get(it.id);
    const llmRateRaw = rateMap ? Number(rateMap[emp.id]) : Number.NaN;
    const hasLlmRate = Number.isFinite(llmRateRaw) && llmRateRaw > 0;
    const normalizedRate = hasLlmRate ? Math.max(0.1, Math.min(5, llmRateRaw)) : 0;
    const estimatedHours = hasLlmRate
      ? Math.max(1, Math.round(100 / normalizedRate))
      : this.fallbackEstimateHours(it.complexity, level);
    const ratePerHour = hasLlmRate
      ? Math.round(normalizedRate * 10000) / 10000
      : Math.round((100.0 / Math.max(1, estimatedHours)) * 10000) / 10000;
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

    if (!hasLlmRate) {
      this.scheduleRateGeneration(true);
    }
    this.recomputeStress();
  }

  private async loadHires() {
    try {
      const snap = await getDocs(
        query(collection(db, `companies/${this.companyId}/employees`), where('hired', '==', true))
      );
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
        const multiplier = getStressMultiplier(persistedStress, status);
        const directAvatarUrl = String(h.avatarUrl || h.avatar_url || '').trim();
        const avatarName = String(h.avatar || h.photo || h.photoUrl || h.image || '').trim();
        const avatarUrl = directAvatarUrl || buildAvatarUrl(avatarName, 'neutral');
        const initials = this.initialsFor(String(h.name || h.id));
        const name = String(h.name || '');
        const title = String(h.title || '');
        const color = normalizeEmployeeColor(h.calendarColor || h.color) || fallbackEmployeeColor(h.id);
        list.push({
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
        });
        this.lastPersistedStress.set(h.id, { stress: persistedStress, status });
      }
      this.hires = list;
      this.empById.clear();
      for (const e of list) this.empById.set(e.id, e);
      this.hires.forEach((hire) => {
        if (hire.avatarName && hire.color) void this.colorizeAvatar(hire);
      });
      this.scheduleRateGeneration();
      this.recomputeStress();
    } catch (err) {
      console.error('Failed to load hires', err);
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
      const metrics: StressMetrics = computeStressMetrics(loadByEmployee.get(hire.id) || 0);
      anyLoad = anyLoad || metrics.load > 0;
      const changed =
        hire.stress !== metrics.stress ||
        hire.status !== metrics.status ||
        hire.load !== metrics.load;

      hire.stress = metrics.stress;
      hire.status = metrics.status;
      hire.load = metrics.load;
      hire.multiplier = isBurnedOut(metrics.status) ? Number.POSITIVE_INFINITY : metrics.multiplier;
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

  private fallbackEstimateHours(complexity: number, empLevel: number): number {
    const normalized = Number.isFinite(Number(complexity)) && Number(complexity) > 0 ? Number(complexity) : 3;
    const cx = Math.max(1, Math.min(5, Math.floor(normalized)));
    const base = 6 + 8 * cx;
    const mult = Math.max(0.6, Math.min(1.4, 1.0 - (empLevel - 5) * 0.05));
    return Math.round(base * mult);
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
