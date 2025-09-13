import { Component, OnInit, OnDestroy, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { InboxService, Email } from '../../services/inbox.service';
import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';

const fbApp = getApps().length
  ? getApps()[0]
  : initializeApp(environment.firebase);
const db = getFirestore(fbApp);
const kickoffUrl = 'https://fa-strtupifyio.azurewebsites.net/api/kickoff_email';

@Component({
  selector: 'app-inbox',
  templateUrl: './inbox.component.html',
  styleUrls: ['./inbox.component.scss'],
  imports: [CommonModule, HttpClientModule],
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

  private snacks: { name: string; price: string }[] = [];
  private selectedSnack: { name: string; price: string } | null = null;
  private superEatsSendTime: number | null = null;
  private superEatsTemplate:
    | { from: string; banner: boolean; body: string }
    | null = null;

  private kickoffSendTime: number | null = null;
  private kickoffCreated = false;

  showDeleted = false;

  constructor(
    private route: ActivatedRoute,
    private inboxService: InboxService,
    private http: HttpClient
  ) {}

  async ngOnInit(): Promise<void> {
    if (!this.companyId) return;

    await this.loadClockState();
    this.startClock();
    this.loadSnacks();
    this.loadSuperEatsTemplate();

    this.inboxService
      .ensureWelcomeEmail(this.companyId)
      .then(() => {
        this.kickoffSendTime = this.simDate.getTime() + 5 * 60_000;
      })
      .finally(() => {
        this.inboxService.getInbox(this.companyId).subscribe((emails) => {
          this.inbox = this.sortEmails(emails);
          if (!this.selectedEmail && this.inbox.length)
            this.selectedEmail = this.inbox[0];
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
    this.inboxService
      .deleteEmail(this.companyId, this.selectedEmail.id)
      .then(() => {
        this.inbox = this.inbox.filter(
          (email) => email.id !== this.selectedEmail?.id
        );
        this.selectedEmail = null;
      });
  }

  archiveEmails(): void {
    this.showDeleted = !this.showDeleted;
    this.inboxService
      .getInbox(this.companyId, this.showDeleted)
      .subscribe((emails) => {
        this.inbox = this.sortEmails(
          emails.filter((email) => email.deleted === this.showDeleted)
        );
        this.selectedEmail = null;
      });
  }

  toggleDelete(): void {
    if (!this.selectedEmail) return;
    const newDeletedState = !this.showDeleted;
    const updateMethod = newDeletedState
      ? this.inboxService.deleteEmail
      : this.inboxService.undeleteEmail;

    updateMethod
      .call(this.inboxService, this.companyId, this.selectedEmail.id)
      .then(() => {
        if (this.selectedEmail) {
          this.selectedEmail.deleted = newDeletedState;
        }
        this.inbox = this.sortEmails(
          this.inbox.filter((email) => email.deleted === this.showDeleted)
        );
        this.selectedEmail = null;
      });
  }

  private sortEmails(emails: Email[]): Email[] {
    return emails
      .slice()
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
  }

  private async loadClockState(): Promise<void> {
    const ref = doc(db, `companies/${this.companyId}`);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data() as {
        simTime?: number;
        speed?: number;
        superEatsNextAt?: number;
      };
      if (data.simTime !== undefined) this.simDate = new Date(data.simTime);
      if (data.speed !== undefined) this.speed = data.speed;
      if (data.superEatsNextAt !== undefined) {
        this.superEatsSendTime = data.superEatsNextAt;
      } else {
        const firstAt = this.computeFirstDaySuperEats(this.simDate);
        this.superEatsSendTime = firstAt.getTime();
        await updateDoc(ref, { superEatsNextAt: this.superEatsSendTime });
      }
    } else {
      const firstAt = this.computeFirstDaySuperEats(this.simDate);
      this.superEatsSendTime = firstAt.getTime();
      await setDoc(ref, {
        simTime: this.simDate.getTime(),
        speed: this.speed,
        superEatsNextAt: this.superEatsSendTime,
      });
    }
    this.updateDisplay();
  }

  private startClock(): void {
    const ref = doc(db, `companies/${this.companyId}`);

    this.intervalId = setInterval(async () => {
      this.simDate = new Date(
        this.simDate.getTime() + this.speed * this.tickMs
      );
      this.elapsedSinceStart += this.tickMs;
      if (
        this.elapsedSinceStart >= this.realPhaseMs &&
        this.speed < this.maxSpeed
      ) {
        this.speed = Math.min(this.speed + this.accelPerTick, this.maxSpeed);
      }
      this.updateDisplay();
      this.checkSuperEatsEmail();
      this.checkKickoffEmail();

      this.elapsedSinceSave += this.tickMs;
      if (this.elapsedSinceSave >= this.saveEveryMs) {
        this.elapsedSinceSave = 0;
        await updateDoc(ref, {
          simTime: this.simDate.getTime(),
          speed: this.speed,
        });
      }
    }, this.tickMs);
  }

  private updateDisplay(): void {
    this.displayDate = this.simDate.toLocaleDateString();
    this.displayTime = this.simDate.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  private loadSnacks(): void {
    this.http
      .get('assets/snacks.txt', { responseType: 'text' })
      .subscribe((text) => {
        this.snacks = text
          .split('\n')
          .map((line) => {
            const [name, price] = line.trim().split(',');
            return { name: name.trim(), price: price.trim() };
          })
          .filter((s) => s.name && s.price);
        if (this.snacks.length)
          this.selectedSnack =
            this.snacks[Math.floor(Math.random() * this.snacks.length)];
      });
  }

  private checkSuperEatsEmail(): void {
    if (!this.superEatsSendTime) return;
    if (this.simDate.getTime() < this.superEatsSendTime) return;
    if (!this.snacks.length) return;

    if (!this.selectedSnack) {
      this.selectedSnack =
        this.snacks[Math.floor(Math.random() * this.snacks.length)];
    }

    const snack = this.selectedSnack;
    const quantity = Math.floor(Math.random() * 4) + 2;
    const totalPrice = (parseFloat(snack.price) * quantity).toFixed(2);
    const day = this.simDate.toLocaleString('en-US', { weekday: 'long' });
    const hour = this.simDate.getHours();
    const timeOfDay =
      hour >= 5 && hour < 12
        ? 'morning'
        : hour >= 12 && hour < 17
        ? 'afternoon'
        : hour >= 17 && hour < 21
        ? 'evening'
        : 'night';
    const subject = `Your ${day} ${timeOfDay} order from Super Eats`;
    let from = 'noreply@supereats.com';
    let banner = true;
    let message = '';
    // If a Markdown template was loaded, use it; else fallback to default
    if ((this as any).superEatsTemplate) {
      const tpl = (this as any).superEatsTemplate as {
        from: string;
        banner: boolean;
        body: string;
      };
      from = tpl.from || from;
      banner = tpl.banner;
      message = tpl.body
        .replace(/\{SNACK_NAME\}/g, snack.name)
        .replace(/\{QUANTITY\}/g, String(quantity))
        .replace(/\{SNACK_PRICE\}/g, snack.price)
        .replace(/\{TOTAL_PRICE\}/g, totalPrice);
    } else {
      message = `Thank you for ordering with Super Eats!\n\nOrder summary\n${snack.name} (x${quantity}): $${snack.price} each\n\nSubtotal: $${totalPrice}\nTotal: $${totalPrice}\n\nWe hope you enjoy your meal!\n\nSuper Eats`;
    }
    const emailId = `supereats-${Date.now()}`;
    setDoc(doc(db, `companies/${this.companyId}/inbox/${emailId}`), {
      from,
      subject,
      message,
      deleted: false,
      banner,
      timestamp: this.simDate.toISOString(),
    }).then(async () => {
      // After sending, schedule the next Super Eats email and persist it
      const nextAt = this.computeNextSuperEats(this.simDate);
      this.superEatsSendTime = nextAt.getTime();
      const ref = doc(db, `companies/${this.companyId}`);
      await updateDoc(ref, { superEatsNextAt: this.superEatsSendTime });
    });
  }

  private loadSuperEatsTemplate(): void {
    this.http
      .get('emails/supereats.md', { responseType: 'text' })
      .subscribe({
        next: (text) => {
          const parsed = this.parseMarkdownEmail(text);
          this.superEatsTemplate = {
            from: parsed.from || 'noreply@supereats.com',
            banner: parsed.banner ?? true,
            body: parsed.body,
          };
        },
        error: () => {
          // Ignore; will fall back to default string
        },
      });
  }

  private parseMarkdownEmail(text: string): {
    from?: string;
    subject?: string;
    banner?: boolean;
    deleted?: boolean;
    body: string;
  } {
    const lines = text.split(/\r?\n/);
    let i = 0;
    const meta: any = {};
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) {
        i++;
        break;
      }
      const idx = line.indexOf(':');
      if (idx > -1) {
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (key === 'from') meta.from = value;
        else if (key === 'subject') meta.subject = value;
        else if (key === 'banner') meta.banner = /^true$/i.test(value);
        else if (key === 'deleted') meta.deleted = /^true$/i.test(value);
      } else {
        break;
      }
      i++;
    }
    const body = lines.slice(i).join('\n').trim();
    return { ...meta, body };
  }

  // --- Super Eats scheduling helpers ---
  private readonly businessStartHour = 10; // 10:00
  private readonly businessEndHour = 20; // 20:00 (exclusive)
  private readonly nextMinDays = 1.5; // min gap 1.5 days
  private readonly nextMaxDays = 3.5; // max gap 3.5 days

  private startOfDay(d: Date): Date {
    const x = new Date(d.getTime());
    x.setHours(0, 0, 0, 0);
    return x;
  }

  private randomInt(minInclusive: number, maxInclusive: number): number {
    return Math.floor(Math.random() * (maxInclusive - minInclusive + 1)) + minInclusive;
  }

  private computeFirstDaySuperEats(now: Date): Date {
    // Schedule first send within current sim day business hours.
    // If after business hours, move to next day window.
    const d = new Date(now.getTime());
    const hr = d.getHours();
    const min = d.getMinutes();

    const windowStart = new Date(this.startOfDay(d).getTime());
    windowStart.setHours(this.businessStartHour, 0, 0, 0);
    const windowEnd = new Date(this.startOfDay(d).getTime());
    windowEnd.setHours(this.businessEndHour, 0, 0, 0);

    const pickRandomInWindow = (baseDay: Date): Date => {
      const totalMinutes = (this.businessEndHour - this.businessStartHour) * 60 - 1; // inclusive end minute
      const offset = this.randomInt(0, totalMinutes);
      const h = this.businessStartHour + Math.floor(offset / 60);
      const m = offset % 60;
      const t = new Date(baseDay.getTime());
      t.setHours(h, m, 0, 0);
      return t;
    };

    if (d < windowStart) {
      return pickRandomInWindow(windowStart);
    }
    if (d >= windowEnd) {
      const nextDay = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);
      return pickRandomInWindow(nextDay);
    }
    // Within window: pick a random minute later today; if no time left, move to tomorrow
    const minutesNow = hr * 60 + min;
    const startMin = this.businessStartHour * 60;
    const endMin = this.businessEndHour * 60 - 1;
    if (minutesNow >= endMin) {
      const nextDay = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);
      return pickRandomInWindow(nextDay);
    }
    const offsetMin = this.randomInt(Math.max(minutesNow + 1, startMin), endMin) - startMin;
    const h = this.businessStartHour + Math.floor(offsetMin / 60);
    const m = offsetMin % 60;
    const t = new Date(windowStart.getTime());
    t.setHours(h, m, 0, 0);
    return t;
  }

  private computeNextSuperEats(after: Date): Date {
    // Draw a random gap between 1.5 and 3.5 days
    const deltaDays = this.nextMinDays + Math.random() * (this.nextMaxDays - this.nextMinDays);
    const base = new Date(after.getTime() + deltaDays * 24 * 60 * 60 * 1000);
    // Choose a random time-of-day within business hours
    const totalMinutes = (this.businessEndHour - this.businessStartHour) * 60 - 1;
    const offset = this.randomInt(0, totalMinutes);
    const h = this.businessStartHour + Math.floor(offset / 60);
    const m = offset % 60;
    const d = this.startOfDay(base);
    d.setHours(h, m, 0, 0);
    return d;
  }

  private checkKickoffEmail(): void {
    if (this.kickoffCreated) return;
    if (!this.kickoffSendTime) return;
    if (this.simDate.getTime() < this.kickoffSendTime) return;

    this.kickoffCreated = true;

    this.http
      .post<any>(kickoffUrl, { name: this.companyId })
      .subscribe({
        next: (email) => {
          const emailId = `kickoff-${Date.now()}`;
          setDoc(doc(db, `companies/${this.companyId}/inbox/${emailId}`), {
            from: email.from,
            subject: email.subject,
            message: email.body,
            deleted: false,
            banner: false,
            timestamp: this.simDate.toISOString(),
          }).catch(() => {
            this.kickoffCreated = false;
          });
        },
        error: () => {
          this.kickoffCreated = false;
        },
      });
  }
}
