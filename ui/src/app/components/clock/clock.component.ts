import { Component, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  doc,
  onSnapshot,
  DocumentData,
  DocumentSnapshot,
  collection,
  onSnapshot as onColSnapshot,
  QuerySnapshot,
  updateDoc,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { getStressMultiplier, isBurnedOut } from '../../services/stress.service';

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

  private readonly speedMultiplier = 10;
  private readonly baseSpeed = this.speedMultiplier;
  private readonly minSpeed = 1;
  private readonly maxSpeed = 240 * this.speedMultiplier;
  private readonly accelPerTick = 0.1 * this.speedMultiplier;
  private readonly realPhaseMs = (5 * 60_000) / this.speedMultiplier;
  private simTime = Date.now();
  private displaySimMs = this.simTime;
  private speed = this.baseSpeed;
  private readonly tickMs = 250;
  private readonly tickMinDelayMs = 8000;
  private readonly tickMaxDelayMs = 13000;
  private readonly minDisplayAnimMs = 200;
  private readonly maxDisplayAnimMs = 1500;
  private unsub: (() => void) | null = null;
  private unsubItems: (() => void) | null = null;
  private tickTimer: any;
  private tickInFlight = false;
  private clockActive = false;
  private readonly saveEveryMs = 1000;
  private elapsedSinceSave = 0;
  private elapsedSinceStart = 0;
  private lastTickWall = Date.now();
  private displayAnimFrame: number | null = null;
  private displayAnimCancelAt: number | null = null;
  private items: Array<{
    id: string;
    status: string;
    started_at: number;
    estimated_hours: number;
    assignee_id?: string;
  }> = [];
  private completedIds = new Set<string>();
  private unsubEmployees: (() => void) | null = null;
  private employeeStress = new Map<
    string,
    { stress: number; status: 'Active' | 'Burnout'; multiplier: number }
  >();

  ngOnChanges(changes: SimpleChanges): void {
    if ('companyId' in changes) {
      this.resubscribe();
    }
  }

  ngOnDestroy(): void {
    if (this.unsub) this.unsub();
    this.clockActive = false;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.displayAnimFrame !== null) {
      cancelAnimationFrame(this.displayAnimFrame);
      this.displayAnimFrame = null;
    }
    this.displayAnimCancelAt = null;
    if (this.unsubItems) this.unsubItems();
    if (this.unsubEmployees) this.unsubEmployees();
  }

  private resubscribe(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    this.cancelDisplayWind();
    this.tickInFlight = false;
    this.clockActive = false;
    if (this.unsubItems) {
      this.unsubItems();
      this.unsubItems = null;
    }
    if (this.unsubEmployees) {
      this.unsubEmployees();
      this.unsubEmployees = null;
    }
    if (!this.companyId) return;
    const ref = doc(db, `companies/${this.companyId}`);
    this.unsub = onSnapshot(ref, (snap: DocumentSnapshot<DocumentData>) => {
      const data = (snap && (snap.data() as any)) || {};
      const st = Number(data.simTime || Date.now());
      const sp = Number(data.speed);
      this.simTime = Number.isFinite(st) ? st : Date.now();
      this.speed = Number.isFinite(sp) ? this.clampSpeed(sp) : this.baseSpeed;
      this.setDisplayTime(this.simTime, false);
      // Only run the clock after Inbox has started the simulation
      if (!data.simStarted) {
        if (this.tickTimer) {
          clearTimeout(this.tickTimer);
          this.tickTimer = null;
        }
        this.tickInFlight = false;
        this.clockActive = false;
        this.cancelDisplayWind();
        return;
      }
      this.clockActive = true;
      this.checkAutoComplete();
      if (!this.tickTimer && !this.tickInFlight) {
        this.startClock();
      }
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
          assignee_id: String(x.assignee_id || ''),
        };
      });

      this.completedIds.clear();

      this.checkAutoComplete();
    });

    const employeesRef = collection(db, `companies/${this.companyId}/employees`);
    this.unsubEmployees = onColSnapshot(employeesRef, (snap: QuerySnapshot<DocumentData>) => {
      this.employeeStress.clear();
      snap.docs.forEach((d) => {
        const data = (d.data() as any) || {};
        const stress = Number(data.stress || 0);
        const status: 'Active' | 'Burnout' = String(data.status || 'Active') === 'Burnout' ? 'Burnout' : 'Active';
        const multiplier = getStressMultiplier(stress, status);
        this.employeeStress.set(d.id, { stress, status, multiplier });
      });
    });
  }

  private startClock(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    this.cancelDisplayWind();
    this.tickInFlight = false;
    this.clockActive = true;
    this.speed = this.clampSpeed(this.speed || this.baseSpeed);
    this.elapsedSinceStart = 0;
    this.elapsedSinceSave = 0;
    this.lastTickWall = Date.now();
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (!this.companyId || this.tickInFlight || !this.clockActive) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    const delay = this.randomInt(this.tickMinDelayMs, this.tickMaxDelayMs);
    this.startDisplayWind(delay);
    this.tickTimer = setTimeout(() => this.runTick(), delay);
  }

  private async runTick(): Promise<void> {
    if (!this.companyId) {
      this.tickInFlight = false;
      return;
    }
    this.tickInFlight = true;
    const now = Date.now();
    const realElapsed = Math.max(0, now - this.lastTickWall);
    this.lastTickWall = now;
    const virtualTicks = Math.max(1, realElapsed / this.tickMs);
    const advance = this.speed * realElapsed;
    this.simTime += advance;
    this.elapsedSinceStart += realElapsed;
    if (this.elapsedSinceStart >= this.realPhaseMs) {
      const speedDelta = this.accelPerTick * virtualTicks;
      const direction = Math.random() < 0.5 ? -1 : 1;
      const nextSpeed = this.speed + direction * speedDelta;
      this.speed = this.clampSpeed(nextSpeed);
    }

    this.setDisplayTime(this.simTime, false);
    this.checkAutoComplete();

    this.elapsedSinceSave += realElapsed;
    if (this.elapsedSinceSave >= this.saveEveryMs) {
      this.elapsedSinceSave = 0;
      const ref = doc(db, `companies/${this.companyId}`);
      try {
        await updateDoc(ref, { simTime: this.simTime, speed: this.speed });
      } catch {}
    }
    this.tickInFlight = false;
    if (this.clockActive) this.scheduleNextTick();
  }

  private setDisplayTime(targetMs: number, animate: boolean): void {
    if (this.displayAnimFrame !== null) {
      cancelAnimationFrame(this.displayAnimFrame);
      this.displayAnimFrame = null;
    }
    this.displayAnimCancelAt = null;
    if (!animate) {
      this.displaySimMs = targetMs;
      this.applyDisplay();
      return;
    }
    const startVal = this.displaySimMs;
    const delta = targetMs - startVal;
    if (Math.abs(delta) < 1) {
      this.displaySimMs = targetMs;
      this.applyDisplay();
      return;
    }
    const duration = this.computeDisplayDuration(Math.abs(delta));
    const start = performance.now();
    const step = () => {
      const now = performance.now();
      const t = Math.min(1, (now - start) / duration);
      this.displaySimMs = startVal + delta * t;
      this.applyDisplay();
      if (t < 1) {
        this.displayAnimFrame = requestAnimationFrame(step);
      } else {
        this.displayAnimFrame = null;
      }
    };
    this.displayAnimFrame = requestAnimationFrame(step);
  }

  private startDisplayWind(durationMs: number): void {
    if (!durationMs || durationMs <= 0) return;
    const target = this.simTime + this.speed * durationMs;
    this.cancelDisplayWind();
    const startVal = this.displaySimMs;
    const delta = target - startVal;
    const start = performance.now();
    const plannedEnd = start + durationMs;
    this.displayAnimCancelAt = plannedEnd;
    const animate = () => {
      if (!this.clockActive || this.displayAnimCancelAt === null) {
        this.displayAnimFrame = null;
        return;
      }
      const now = performance.now();
      const t = Math.min(1, (now - start) / durationMs);
      this.displaySimMs = startVal + delta * t;
      this.applyDisplay();
      if (t < 1 && now < this.displayAnimCancelAt) {
        this.displayAnimFrame = requestAnimationFrame(animate);
      } else {
        this.displayAnimFrame = null;
        this.displayAnimCancelAt = null;
      }
    };
    this.displayAnimFrame = requestAnimationFrame(animate);
  }

  private cancelDisplayWind(): void {
    if (this.displayAnimFrame !== null) {
      cancelAnimationFrame(this.displayAnimFrame);
      this.displayAnimFrame = null;
    }
    this.displayAnimCancelAt = null;
  }

  private computeDisplayDuration(deltaMs: number): number {
    const scaled = deltaMs / 5000;
    return Math.min(this.maxDisplayAnimMs, Math.max(this.minDisplayAnimMs, scaled));
  }

  private applyDisplay(): void {
    const d = new Date(this.displaySimMs);
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
      const emp = this.employeeStress.get(it.assignee_id);
      if (emp && isBurnedOut(emp.status)) continue;
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
    assignee_id?: string;
  }): number {
    const now = new Date(this.simTime);
    const started = new Date(it.started_at);
    const hours = this.workingHoursBetween(started, now);
    const emp = it.assignee_id ? this.employeeStress.get(it.assignee_id) : undefined;
    if (emp && isBurnedOut(emp.status)) return 0;
    const multiplier = emp ? emp.multiplier : 1;
    const needed = it.estimated_hours * multiplier;
    if (!needed || !isFinite(needed)) return 0;
    const pct = Math.min(100, Math.max(0, (hours / needed) * 100));
    return Math.round(pct);
  }

  private readonly workdayStartHour = 9;
  private readonly workdayEndHour = 17;

  private workingHoursBetween(a: Date, b: Date): number {
    if (b <= a) return 0;
    let total = 0;
    const x = new Date(a.getTime());
    while (x < b) {
      const dayStart = new Date(x.getTime());
      dayStart.setHours(this.workdayStartHour, 0, 0, 0);
      const dayEnd = new Date(x.getTime());
      dayEnd.setHours(this.workdayEndHour, 0, 0, 0);
      const from = x > dayStart ? x : dayStart;
      const to = b < dayEnd ? b : dayEnd;
      if (to > from) total += (to.getTime() - from.getTime()) / 3600000;
      x.setHours(24, 0, 0, 0);
    }
    return total;
  }

  private randomInt(minInclusive: number, maxInclusive: number): number {
    return Math.floor(Math.random() * (maxInclusive - minInclusive + 1)) + minInclusive;
  }

  private clampSpeed(value: number): number {
    return Math.min(this.maxSpeed, Math.max(this.minSpeed, value));
  }
}

