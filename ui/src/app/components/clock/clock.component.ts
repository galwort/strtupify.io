import { Component, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, onSnapshot, DocumentData, DocumentSnapshot, collection, onSnapshot as onColSnapshot, QuerySnapshot, updateDoc } from 'firebase/firestore';
import { environment } from 'src/environments/environment';

const fbApp = getApps().length ? getApps()[0] : initializeApp(environment.firebase);
const db = getFirestore(fbApp);

@Component({
  selector: 'app-clock',
  standalone: true,
  templateUrl: './clock.component.html',
  styleUrls: ['./clock.component.scss'],
  imports: [CommonModule],
})
export class ClockComponent implements OnChanges, OnDestroy {
  @Input() companyId: string | null = null;

  displayDate = '';
  displayTime = '';

  private simTime = Date.now();
  private speed = 8;
  private readonly tickMs = 150;
  private unsub: (() => void) | null = null;
  private unsubItems: (() => void) | null = null;
  private intervalId: any;
  private readonly saveEveryMs = 1000;
  private elapsedSinceSave = 0;
  private readonly minuteScheduleSec = [60, 50, 40, 30, 20, 10, 1];
  private scheduleIdx = 0;
  private simMsIntoStep = 0;
  private items: Array<{
    id: string;
    status: string;
    started_at: number;
    estimated_hours: number;
    work_start_hour?: number;
    work_end_hour?: number;
    assignee_id?: string;
  }> = [];
  private completedIds = new Set<string>();

  ngOnChanges(changes: SimpleChanges): void {
    if ('companyId' in changes) {
      this.resubscribe();
    }
  }

  ngOnDestroy(): void {
    if (this.unsub) this.unsub();
    if (this.intervalId) clearInterval(this.intervalId);
  }

  private resubscribe(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.unsubItems) {
      this.unsubItems();
      this.unsubItems = null;
    }
    if (!this.companyId) return;
    const ref = doc(db, `companies/${this.companyId}`);
    this.unsub = onSnapshot(ref, (snap: DocumentSnapshot<DocumentData>) => {
      const data = (snap && (snap.data() as any)) || {};
      const st = Number(data.simTime || Date.now());
      const sp = Number(data.speed || 8);
      this.simTime = Number.isFinite(st) ? st : Date.now();
      this.speed = Number.isFinite(sp) && sp > 0 ? sp : 1;
      this.updateDisplay();
      this.checkAutoComplete();
      this.startClock();
    });


    const itemsRef = collection(db, `companies/${this.companyId}/workitems`);
    this.unsubItems = onColSnapshot(itemsRef, (snap: QuerySnapshot<DocumentData>) => {
      this.items = snap.docs.map((d) => {
        const x = d.data() as any;
        return {
          id: d.id,
          status: String(x.status || ''),
          started_at: Number(x.started_at || 0),
          estimated_hours: Number(x.estimated_hours || 0),
          work_start_hour: Number(x.work_start_hour || 10),
          work_end_hour: Number(x.work_end_hour || 20),
          assignee_id: String(x.assignee_id || ''),
        };
      });

      this.completedIds.clear();

      this.checkAutoComplete();
    });
  }

  private startClock(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Initialize schedule from current speed
    const currentSecPerMin = 60 / (this.speed || 1);
    const idx = this.minuteScheduleSec.findIndex((s) => Math.abs(s - currentSecPerMin) < 1e-6);
    this.scheduleIdx = idx >= 0 ? idx : this.minuteScheduleSec.length - 1;
    this.simMsIntoStep = 0;

    const ref = doc(db, `companies/${this.companyId}`);
    this.intervalId = setInterval(async () => {
      const advance = this.speed * this.tickMs;
      this.simTime += advance;
      this.simMsIntoStep += advance;

      while (this.simMsIntoStep >= 60_000) {
        this.simMsIntoStep -= 60_000;
        if (this.scheduleIdx < this.minuteScheduleSec.length - 1) {
          this.scheduleIdx += 1;
          this.speed = 60 / this.minuteScheduleSec[this.scheduleIdx];
        } else {
          this.scheduleIdx = this.minuteScheduleSec.length - 1;
          this.speed = 60 / this.minuteScheduleSec[this.scheduleIdx];
        }
      }

      this.updateDisplay();
      this.checkAutoComplete();

      this.elapsedSinceSave += this.tickMs;
      if (this.elapsedSinceSave >= this.saveEveryMs) {
        this.elapsedSinceSave = 0;
        if (this.companyId) {
          try { await updateDoc(ref, { simTime: this.simTime, speed: this.speed }); } catch {}
        }
      }
    }, this.tickMs);
  }

  private updateDisplay(): void {
    const d = new Date(this.simTime);
    this.displayDate = d.toLocaleDateString();
    this.displayTime = d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  private checkAutoComplete(): void {
    if (!this.companyId || !this.items.length) return;
    for (const it of this.items) {
      if (it.status === 'done') continue;
      if (it.status !== 'doing') continue;
      if (!it.assignee_id) continue;
      if (!it.started_at || !it.estimated_hours) continue;
      const pct = this.progressFor(it);
      if (pct >= 100 && !this.completedIds.has(it.id)) {
        this.completedIds.add(it.id);
        const ref = doc(db, `companies/${this.companyId}/workitems/${it.id}`);
        updateDoc(ref, { status: 'done', completed_at: this.simTime }).catch(() => {
          this.completedIds.delete(it.id);
        });
      }
    }
  }

  private progressFor(it: {
    started_at: number;
    estimated_hours: number;
    work_start_hour?: number;
    work_end_hour?: number;
  }): number {
    const now = new Date(this.simTime);
    const started = new Date(it.started_at);
    const startH = Number(it.work_start_hour ?? 10);
    const endH = Number(it.work_end_hour ?? 20);
    const hours = this.workingHoursBetween(started, now, startH, endH);
    const pct = Math.min(100, Math.max(0, (hours / it.estimated_hours) * 100));
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
      const from = x > dayStart ? x : dayStart;
      const to = b < dayEnd ? b : dayEnd;
      if (to > from) total += (to.getTime() - from.getTime()) / 3600000;
      x.setHours(24, 0, 0, 0);
    }
    return total;
  }
}

