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
  todo: WorkItem[] = [];
  doing: WorkItem[] = [];
  done: WorkItem[] = [];
  simTime = Date.now();
  private speed = 1;
  private tickMs = 250;
  private unsubItems: any;
  private unsubCompany: any;
  private intervalId: any;
  private draggingId: string | null = null;

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
      this.partition();
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

  private partition() {
    const order = (a: WorkItem, b: WorkItem) => a.title.localeCompare(b.title);
    this.todo = this.items.filter((i) => (i.status || 'todo') === 'todo').sort(order);
    this.doing = this.items
      .filter((i) => i.status === 'doing' || i.status === 'in_progress')
      .sort(order);
    this.done = this.items.filter((i) => i.status === 'done').sort(order);
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
    if (target === 'done') {
      update.completed_at = this.simTime;
    }
    await updateDoc(ref, update);
  }
}
