import { Component, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, onSnapshot, DocumentData, DocumentSnapshot } from 'firebase/firestore';
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
  private speed = 1;
  private readonly tickMs = 250;
  private unsub: (() => void) | null = null;
  private intervalId: any;

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
    if (!this.companyId) return;
    const ref = doc(db, `companies/${this.companyId}`);
    this.unsub = onSnapshot(ref, (snap: DocumentSnapshot<DocumentData>) => {
      const data = (snap && (snap.data() as any)) || {};
      const st = Number(data.simTime || Date.now());
      const sp = Number(data.speed || 1);
      this.simTime = Number.isFinite(st) ? st : Date.now();
      this.speed = Number.isFinite(sp) && sp > 0 ? sp : 1;
      this.updateDisplay();
      this.startClock();
    });
  }

  private startClock(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => {
      this.simTime = this.simTime + this.speed * this.tickMs;
      this.updateDisplay();
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
}
