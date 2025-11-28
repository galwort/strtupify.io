import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { initializeApp, getApps } from 'firebase/app';
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
  private assistDelayMinMs = 6 * 60 * 1000;
  private assistDelayMaxMs = 18 * 60 * 1000;
  private assistChance = 0.4;
  private assistProgressCeiling = 85;
  private assistEligibility = new Map<string, boolean>();
  private assistDelayById = new Map<string, number>();
  private assistInFlight = new Set<string>();
  private assistFailedAt = new Map<string, number>();
  private assistFailureCooldownMs = 5 * 60 * 1000;

  constructor(private ui: UiStateService) {}

  ngOnInit(): void {
    if (!this.companyId) return;

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
        } as WorkItem;
      });
      this.titleById.clear();
      for (const it of this.items) this.titleById.set(it.id, it.title);
      this.partition();
      this.scheduleRateGeneration();
      this.recomputeStress();
      void this.checkAssistanceNeeds();
    });

    this.unsubCompany = onDocSnapshot(doc(db, `companies/${this.companyId}`), (snapshot) => {
      const x = (snapshot && (snapshot.data() as any)) || {};
      this.simTime = Number(x.simTime || Date.now());
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
    if (this.intervalId) clearInterval(this.intervalId);
  }

  private partition() {
    const order = (a: WorkItem, b: WorkItem) => a.title.localeCompare(b.title);
    this.todo = this.items.filter((i) => (i.status || 'todo') === 'todo').sort(order);
    this.doing = this.items
      .filter((i) => i.status === 'doing' || i.status === 'in_progress')
      .sort(order);
    this.done = this.items.filter((i) => i.status === 'done').sort(order);
    this.pruneAssistTracking();
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
    if (this.intervalId) clearInterval(this.intervalId);
    let assistTick = 0;
    this.intervalId = setInterval(() => {
      this.simTime = this.simTime + this.speed * this.tickMs;
      assistTick++;
      if (assistTick % 8 === 0) {
        void this.checkAssistanceNeeds();
      }
    }, this.tickMs);
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

  private ensureAssistEligibility(it: WorkItem): boolean {
    if (!it || !it.id) return false;
    if (it.assist_last_sent_at) return false;
    const eligibility = this.assistEligibility.get(it.id);
    if (eligibility === false) return false;
    if (eligibility === undefined) {
      const eligible = Math.random() < this.assistChance;
      this.assistEligibility.set(it.id, eligible);
      return eligible;
    }
    return true;
  }

  private getAssistDelay(it: WorkItem): number | null {
    if (!this.ensureAssistEligibility(it)) return null;
    if (this.assistDelayById.has(it.id)) {
      return this.assistDelayById.get(it.id) ?? null;
    }
    const min = Math.max(0, this.assistDelayMinMs);
    const max = Math.max(min, this.assistDelayMaxMs);
    const delay = min === max ? min : Math.round(min + Math.random() * (max - min));
    this.assistDelayById.set(it.id, delay);
    return delay;
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

    const delayTarget = this.getAssistDelay(it);
    if (delayTarget === null) return false;

    const elapsed = Math.max(0, this.simTime - startedAt);
    if (elapsed < delayTarget) return false;

    const progressPct = this.progress(it);
    if (progressPct >= this.assistProgressCeiling) return false;

    return true;
  }

  private async checkAssistanceNeeds(force = false): Promise<void> {
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
      this.assistEligibility.set(it.id, false);
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
      this.assistEligibility.set(it.id, false);
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

      const updatePayload: Record<string, any> = {
        assist_status: 'pending',
        assist_last_sent_at: this.simTime,
        worked_ms: totalWorked,
        started_at: 0,
        updated: serverTimestamp(),
      };
      await updateDoc(doc(db, `companies/${this.companyId}/workitems/${it.id}`), updatePayload);

      it.assist_status = 'pending';
      it.assist_last_sent_at = this.simTime;
      it.started_at = 0;
      it.worked_ms = totalWorked;
      this.partition();
      this.assistDelayById.delete(it.id);
      this.assistEligibility.delete(it.id);
      this.assistFailedAt.delete(it.id);
    } catch (err) {
      console.error('Failed to create assistance email', err);
      this.assistFailedAt.set(it.id, Date.now());
    } finally {
      this.assistInFlight.delete(it.id);
    }
  }

  private pruneAssistTracking() {
    if (!this.assistDelayById.size && !this.assistEligibility.size) return;
    const activeIds = new Set(this.doing.map((x) => x.id));
    for (const id of Array.from(this.assistDelayById.keys())) {
      if (!activeIds.has(id)) this.assistDelayById.delete(id);
    }
    for (const id of Array.from(this.assistEligibility.keys())) {
      if (!activeIds.has(id)) this.assistEligibility.delete(id);
    }
    for (const id of Array.from(this.assistFailedAt.keys())) {
      if (!activeIds.has(id)) this.assistFailedAt.delete(id);
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
        list.push({
          id: h.id,
          name: String(h.name || ''),
          title: String(h.title || ''),
          level: avg,
          stress: persistedStress,
          status,
          load: Number(h.load || 0),
          multiplier,
        });
        this.lastPersistedStress.set(h.id, { stress: persistedStress, status });
      }
      this.hires = list;
      this.empById.clear();
      for (const e of list) this.empById.set(e.id, e);
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

  private activateHrModuleOnce() {
    if (this.hrActivated) return;
    this.hrActivated = true;
    this.ui.setHrEnabled(true);
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
}
