import { Component, OnInit, OnDestroy, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { InboxService, Email } from '../../services/inbox.service';
import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';

const fbApp = getApps().length ? getApps()[0] : initializeApp(environment.firebase);
const db = getFirestore(fbApp);

@Component({
  selector: 'app-inbox',
  templateUrl: './inbox.component.html',
  styleUrls: ['./inbox.component.scss'],
  imports: [CommonModule]
})
export class InboxComponent implements OnInit, OnDestroy {
  @Input() companyId = '';

  inbox: Email[] = [];
  selectedEmail: Email | null = null;

  displayDate = '';
  displayTime = '';

  private simDate = new Date();
  private speed = 1;
  private readonly maxSpeed = 240;
  private readonly tickMs = 250;
  private readonly accelPerTick = 0.1;
  private readonly realPhaseMs = 5 * 60_000;
  private readonly saveEveryMs = 5000;
  private elapsedSinceStart = 0;
  private elapsedSinceSave = 0;
  private intervalId: any;

  constructor(
    private route: ActivatedRoute,
    private inboxService: InboxService
  ) {}

  async ngOnInit(): Promise<void> {
    if (!this.companyId) return;

    await this.loadClockState();
    this.startClock();

    this.inboxService.ensureWelcomeEmail(this.companyId).finally(() => {
      this.inboxService.getInbox(this.companyId).subscribe((emails) => {
        this.inbox = emails;
        if (!this.selectedEmail && emails.length) this.selectedEmail = emails[0];
      });
    });
  }

  ngOnDestroy(): void {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  selectEmail(email: Email): void {
    this.selectedEmail = email;
  }

  deleteSelected(): void {
    if (!this.selectedEmail) return;
    this.inboxService.deleteEmail(this.companyId, this.selectedEmail.id);
    this.selectedEmail = null;
  }

  private async loadClockState(): Promise<void> {
    const ref = doc(db, `companies/${this.companyId}`);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data() as { simTime?: number; speed?: number };
      if (data.simTime !== undefined) this.simDate = new Date(data.simTime);
      if (data.speed !== undefined) this.speed = data.speed;
    } else {
      await setDoc(ref, {
        simTime: this.simDate.getTime(),
        speed: this.speed
      });
    }
    this.updateDisplay();
  }

  private startClock(): void {
    const ref = doc(db, `companies/${this.companyId}`);

    this.intervalId = setInterval(async () => {
      this.simDate = new Date(this.simDate.getTime() + this.speed * this.tickMs);
      this.elapsedSinceStart += this.tickMs;
      if (this.elapsedSinceStart >= this.realPhaseMs && this.speed < this.maxSpeed) {
        this.speed = Math.min(this.speed + this.accelPerTick, this.maxSpeed);
      }
      this.updateDisplay();

      this.elapsedSinceSave += this.tickMs;
      if (this.elapsedSinceSave >= this.saveEveryMs) {
        this.elapsedSinceSave = 0;
        await updateDoc(ref, {
          simTime: this.simDate.getTime(),
          speed: this.speed
        });
      }
    }, this.tickMs);
  }

  private updateDisplay(): void {
    this.displayDate = this.simDate.toLocaleDateString();
    this.displayTime = this.simDate.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }
}
