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
  updateDoc,
  getDocs,
  query,
  where,
  serverTimestamp,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';

type LlmRates = {
  rates: Record<string, number>;
  assigned_employee_id?: string;
  assigned_rate?: number;
  generated?: number;
  updated?: number;
  rate_units?: string;
  model?: string;
};

type WorkItem = {
  id: string;
  title: string;
  description: string;
  assignee_id: string;
  category: string;
  complexity: number;
  estimated_hours: number;
  rate_per_hour: number;
  status: string;
  started_at: number;
  work_start_hour?: number;
  work_end_hour?: number;
  blockers?: string[];
  tid?: number;
  completed_at?: number;
  worked_ms?: number;
  llm_rates?: LlmRates;
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
  private speed = 8;
  private tickMs = 150;
  private unsubItems: any;
  private unsubCompany: any;
  private intervalId: any;
  private draggingId: string | null = null;
  hires: { id: string; name: string; title: string; level: number }[] = [];
  private empById = new Map<string, { id: string; name: string; title: string; level: number }>();
  private titleById = new Map<string, string>();
  private rateCache = new Map<string, Record<string, number>>();
  private pendingRateRequest = false;
  private lastRateRefresh = 0;
  private rateRefreshCooldownMs = 12_000;

  ngOnInit(): void {
    if (!this.companyId) return;
    const ref = collection(db, `companies/${this.companyId}/workitems`);
    this.unsubItems = onSnapshot(ref, (snap: QuerySnapshot<DocumentData>) => {
      this.rateCache.clear();
      this.items = snap.docs.map((d) => {
        const x = d.data() as any;
        const llmRaw = x.llm_rates && typeof x.llm_rates === 'object' ? (x.llm_rates as any) : null;
        const complexityRaw = Number(x.complexity);
        const complexity = Number.isFinite(complexityRaw) && complexityRaw > 0 ? complexityRaw : 3;
        let ratesMap: Record<string, number> | undefined;
        if (llmRaw && llmRaw.rates && typeof llmRaw.rates === 'object') {
          ratesMap = {};
          for (const [empId, val] of Object.entries(llmRaw.rates as Record<string, any>)) {
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
        const assignedEmployeeId = llmRaw && typeof llmRaw.assigned_employee_id === 'string' ? llmRaw.assigned_employee_id : '';
        const assignedRateRaw = llmRaw ? Number(llmRaw.assigned_rate) : Number.NaN;
        const assignedRate = Number.isFinite(assignedRateRaw) ? assignedRateRaw : undefined;
        const llmRates: LlmRates | undefined = ratesMap || assignedEmployeeId || assignedRate
          ? {
              rates: ratesMap ? ratesMap : {},
              assigned_employee_id: assignedEmployeeId || undefined,
              assigned_rate: assignedRate,
              generated: toMillis(llmRaw?.generated),
              updated: toMillis(llmRaw?.updated),
              rate_units:
                typeof llmRaw?.rate_units === 'string' && llmRaw.rate_units ? String(llmRaw.rate_units) : undefined,
              model: typeof llmRaw?.model === 'string' && llmRaw.model ? String(llmRaw.model) : undefined,
            }
          : undefined;
        return {
          id: d.id,
          title: String(x.title || ''),
          description: String(x.description || ''),
          assignee_id: String(x.assignee_id || ''),
          category: String(x.category || ''),
          complexity,
          estimated_hours: Number(x.estimated_hours || 0),
          status: String(x.status || ''),
          started_at: Number(x.started_at || 0),
          work_start_hour: Number(x.work_start_hour || 10),
          work_end_hour: Number(x.work_end_hour || 20),
          blockers: Array.isArray(x.blockers) ? (x.blockers as string[]) : [],
          tid: Number(x.tid || 0),
          completed_at: Number(x.completed_at || 0),
          worked_ms: Number(x.worked_ms || 0),
          rate_per_hour: Number(x.rate_per_hour || 0),
          llm_rates: llmRates,
        } as WorkItem;
      });
      this.titleById.clear();
      for (const it of this.items) this.titleById.set(it.id, it.title);
      this.partition();
      this.scheduleRateGeneration();
    });
    this.unsubCompany = onDocSnapshot(doc(db, `companies/${this.companyId}`), (ds) => {
      const x = (ds && (ds.data() as any)) || {};
      this.simTime = Number(x.simTime || Date.now());
      this.speed = Number(x.speed || 8);
      if (this.speed <= 0) this.speed = 1;
      this.startLocalClock();
    });
    this.loadHires();
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
  }

  progress(it: WorkItem): number {
    if (!it.assignee_id || !it.estimated_hours) return 0;
    const totalMs = this.totalWorkedMs(it);
    if (!totalMs) return 0;
    const hours = totalMs / 3_600_000;
    const pct = Math.min(100, Math.max(0, (hours / it.estimated_hours) * 100));
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

  private workingHoursBetween(a: Date, b: Date, startHour: number, endHour: number): number {
    if (b <= a) return 0;
    let total = 0;
    const x = new Date(a.getTime());
    while (x < b) {
      const dayStart = new Date(x.getTime());
      dayStart.setHours(startHour, 0, 0, 0);
      const dayEnd = new Date(x.getTime());
      dayEnd.setHours(endHour, 0, 0, 0);
      let from = x > dayStart ? x : dayStart;
      let to = b < dayEnd ? b : dayEnd;
      if (to > from) total += (to.getTime() - from.getTime()) / 3600000;
      x.setHours(24, 0, 0, 0);
    }
    return total;
  }

  private startLocalClock() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => {
      this.simTime = this.simTime + this.speed * this.tickMs;
    }, this.tickMs);
  }

  private scheduleRateGeneration(force = false) {
    if (!this.companyId || !this.items.length || !this.hires.length) return;
    if (this.pendingRateRequest) return;
    const now = Date.now();
    if (!force && now - this.lastRateRefresh < this.rateRefreshCooldownMs) return;
    void this.requestRatesFromLlm();
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
    if (target === 'doing') {
      it.started_at = update.started_at;
    } else {
      it.started_at = 0;
    }
    this.partition();
    await updateDoc(ref, update);

    if (target === 'doing') {
      this.scheduleRateGeneration(true);
    }
  }

  private async loadHires() {
    try {
      const snap = await getDocs(query(collection(db, `companies/${this.companyId}/employees`), where('hired', '==', true)));
      const hires = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      const list: { id: string; name: string; title: string; level: number }[] = [];
      for (const h of hires) {
        const skillsSnap = await getDocs(collection(db, `companies/${this.companyId}/employees/${h.id}/skills`));
        const levels: number[] = [];
        for (const sd of skillsSnap.docs) {
          const sv = (sd.data() as any) || {};
          const lvl = Number(sv.level || 5);
          if (Number.isFinite(lvl)) levels.push(Math.max(1, Math.min(10, lvl)));
        }
        const avg = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 5;
        list.push({ id: h.id, name: String(h.name || ''), title: String(h.title || ''), level: avg });
      }
      this.hires = list;
      this.empById.clear();
      for (const e of list) this.empById.set(e.id, e);
      this.scheduleRateGeneration();
    } catch {}
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

  async reassign(it: WorkItem, assigneeId: string) {
    if (it.status === 'done') return;
    const emp = assigneeId ? this.empById.get(assigneeId) : null;
    const ref = doc(db, `companies/${this.companyId}/workitems/${it.id}`);
    if (!emp) {
      const workedMs = this.totalWorkedMs(it);
      const patch: any = {
        assignee_id: '',
        worked_ms: workedMs,
        'llm_rates.assigned_employee_id': '',
        'llm_rates.assigned_rate': null,
        'llm_rates.updated': serverTimestamp(),
      };
      if (it.status === 'doing') {
        patch.status = 'todo';
        patch.started_at = 0;
      }
      await updateDoc(ref, patch);
      it.assignee_id = '';
      it.worked_ms = workedMs;
      const existingLlm: Partial<LlmRates> = it.llm_rates || {};
      it.llm_rates = {
        rates: this.rateCache.get(it.id) || {},
        updated: Date.now(),
        generated: existingLlm.generated,
        rate_units: existingLlm.rate_units,
        model: existingLlm.model,
      };
      if (it.status === 'doing') {
        it.status = 'todo';
        it.started_at = 0;
        this.partition();
      }
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
    const assignedRate = hasLlmRate ? normalizedRate : ratePerHour;
    updatePayload['llm_rates.assigned_employee_id'] = emp.id;
    updatePayload['llm_rates.assigned_rate'] = assignedRate;
    updatePayload['llm_rates.updated'] = serverTimestamp();
    const existingRates = this.rateCache.get(it.id);
    const nextRates = existingRates ? { ...existingRates } : {};
    if (hasLlmRate) nextRates[emp.id] = normalizedRate;
    if (Object.keys(nextRates).length) {
      this.rateCache.set(it.id, nextRates);
    } else {
      this.rateCache.delete(it.id);
    }
    await updateDoc(ref, updatePayload);
    it.assignee_id = emp.id;
    it.estimated_hours = estimatedHours;
    it.rate_per_hour = ratePerHour;
    const existingLlm: Partial<LlmRates> = it.llm_rates || {};
    it.llm_rates = {
      rates: this.rateCache.get(it.id) || {},
      assigned_employee_id: emp.id,
      assigned_rate: assignedRate,
      updated: Date.now(),
      generated: existingLlm.generated,
      rate_units: existingLlm.rate_units,
      model: existingLlm.model,
    };

    if (!hasLlmRate) {
      this.scheduleRateGeneration(true);
    }
  }
}


