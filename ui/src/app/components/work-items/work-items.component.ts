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
  grouped: { assignee: string; title: string; items: WorkItem[] }[] = [];
  simTime = Date.now();
  private speed = 1;
  private tickMs = 250;
  private unsubItems: any;
  private unsubCompany: any;
  private intervalId: any;

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
        } as WorkItem;
      });
      this.groupItems();
    });
    this.unsubCompany = onDocSnapshot(doc(db, `companies/${this.companyId}`), (ds) => {
      const x = (ds && (ds.data() as any)) || {};
      this.simTime = Number(x.simTime || Date.now());
      this.speed = Number(x.speed || 1);
      if (this.speed <= 0) this.speed = 1;
      this.startLocalClock();
    });
  }

  ngOnDestroy(): void {
    if (this.unsubItems) this.unsubItems();
    if (this.unsubCompany) this.unsubCompany();
    if (this.intervalId) clearInterval(this.intervalId);
  }

  private groupItems() {
    const by: { [k: string]: { title: string; list: WorkItem[] } } = {};
    for (const it of this.items) {
      const key = it.assignee_name || 'Unassigned';
      if (!by[key]) by[key] = { title: it.assignee_title || '', list: [] };
      by[key].list.push(it);
    }
    this.grouped = Object.keys(by)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => ({ assignee: k, title: by[k].title, items: by[k].list }));
  }

  progress(it: WorkItem): number {
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
}
