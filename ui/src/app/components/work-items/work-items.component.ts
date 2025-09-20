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
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';

type WorkItem = {
  id: string;
  title: string;
  description: string;
  assignee_id: string;
  assignee_name: string;
  assignee_title: string;
  category: string;
  complexity: number;
  estimated_hours: number;
  status: string;
  started_at: number;
  work_start_hour?: number;
  work_end_hour?: number;
  blockers?: string[];
  tid?: number;
  completed_at?: number;
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

  ngOnInit(): void {
    if (!this.companyId) return;
    const ref = collection(db, `companies/${this.companyId}/workitems`);
    this.unsubItems = onSnapshot(ref, (snap: QuerySnapshot<DocumentData>) => {
      this.items = snap.docs.map((d) => {
        const x = d.data() as any;
        return {
          id: d.id,
          title: String(x.title || ''),
          description: String(x.description || ''),
          assignee_id: String(x.assignee_id || ''),
          assignee_name: String(x.assignee_name || ''),
          assignee_title: String(x.assignee_title || ''),
          category: String(x.category || ''),
          complexity: Number(x.complexity || 0),
          estimated_hours: Number(x.estimated_hours || 0),
          status: String(x.status || ''),
          started_at: Number(x.started_at || 0),
          work_start_hour: Number(x.work_start_hour || 10),
          work_end_hour: Number(x.work_end_hour || 20),
          blockers: Array.isArray(x.blockers) ? (x.blockers as string[]) : [],
          tid: Number(x.tid || 0),
          completed_at: Number(x.completed_at || 0),
        } as WorkItem;
      });
      this.titleById.clear();
      for (const it of this.items) this.titleById.set(it.id, it.title);
      this.partition();
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
    if (!it.assignee_id) return 0;
    if (!it.started_at || !it.estimated_hours) return 0;
    const now = new Date(this.simTime);
    const started = new Date(it.started_at);
    const h = this.workingHoursBetween(started, now, it.work_start_hour || 10, it.work_end_hour || 20);
    const pct = Math.min(100, Math.max(0, (h / it.estimated_hours) * 100));
    return Math.round(pct);
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
    // Disallow any manual moves into or out of DONE
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
    const update: any = { status: target };
    if (target === 'doing' && it.status !== 'doing') {
      update.started_at = this.simTime;
    }
    if (target !== 'doing') {
      update.started_at = update.started_at || it.started_at || 0;
    }
    if (target === 'todo') {
      update.started_at = 0;
    }
    await updateDoc(ref, update);
    // If the item just moved into DOING, request an LLM-based estimate asynchronously
    if (target === 'doing') {
      try {
        await this.requestLlmEstimate(id);
      } catch {}
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
    } catch {}
  }

  private estimateHours(complexity: number, empLevel: number): number {
    const cx = Math.max(1, Math.min(5, Math.floor(Number(complexity) || 1)));
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
    const emp = assigneeId ? this.empById.get(assigneeId) : null;
    const ref = doc(db, `companies/${this.companyId}/workitems/${it.id}`);
    if (!emp) {
      const patch: any = {
        assignee_id: '',
        assignee_name: '',
        assignee_title: '',
      };
      if (it.status === 'doing') {
        patch.status = 'todo';
        patch.started_at = 0;
      }
      await updateDoc(ref, patch);
      it.assignee_id = '';
      it.assignee_name = '';
      it.assignee_title = '';
      if (it.status === 'doing') {
        it.status = 'todo';
        it.started_at = 0;
        this.partition();
      }
      return;
    }
    const name = emp.name;
    const title = emp.title;
    const level = emp.level;
    const est = this.estimateHours(it.complexity, level);
    const rate = Math.round((100.0 / Math.max(1, est)) * 10000) / 10000;
    await updateDoc(ref, {
      assignee_id: emp.id,
      assignee_name: name,
      assignee_title: title,
      estimated_hours: est,
      rate_per_hour: rate,
    });
    it.assignee_id = emp.id;
    it.assignee_name = name;
    it.assignee_title = title;
    it.estimated_hours = est;
    // If already DOING, request an LLM-based estimate for better fit
    if (it.status === 'doing') {
      try {
        await this.requestLlmEstimate(it.id);
      } catch {}
    }
  }

  private async requestLlmEstimate(workitemId: string) {
    if (!this.companyId || !workitemId) return;
    const url = 'https://fa-strtupifyio.azurewebsites.net/api/estimate';
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company: this.companyId, workitem_id: workitemId }),
      });
    } catch {
      // Non-blocking; keep baseline if request fails
    }
  }
}
