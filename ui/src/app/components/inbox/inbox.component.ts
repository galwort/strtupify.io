import { Component, OnInit, OnDestroy, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { InboxService, Email } from '../../services/inbox.service';
import { ReplyRouterService } from '../../services/reply-router.service';
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
const momUrl = 'https://fa-strtupifyio.azurewebsites.net/api/mom_email';

@Component({
  selector: 'app-inbox',
  templateUrl: './inbox.component.html',
  styleUrls: ['./inbox.component.scss'],
  standalone: true,
  imports: [CommonModule, HttpClientModule, FormsModule],
})
export class InboxComponent implements OnInit, OnDestroy {
  @Input() companyId = '';

  inbox: Email[] = [];
  private allEmails: Email[] = [];
  selectedEmail: Email | null = null;

  // Reply composer state
  showReplyBox = false;
  replyText = '';
  get replySubject(): string {
    const base = this.selectedEmail?.subject || '';
    return base.startsWith('Re:') ? base : `Re: ${base}`;
  }

  renderEmailBody(text: string | undefined | null): string {
    if (!text) return '';
    return this.simpleMarkdown(text);
  }

  private simpleMarkdown(src: string): string {
    const escape = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const formatInline = (s: string) => {
      let out = escape(s);
      // links: [text](https://...)
      out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      // bold: **text**
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1<\/strong>');
      // italics: *text* (do after bold)
      out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2<\/em>');
      // inline code: `code`
      out = out.replace(/`([^`]+)`/g, '<code>$1<\/code>');
      return out;
    };

    const lines = src.split(/\r?\n/);
    let html = '';
    let inList = false;
    for (const line of lines) {
      const listMatch = line.match(/^\s*[-*]\s+(.+)/);
      if (listMatch) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += `<li>${formatInline(listMatch[1])}<\/li>`;
        continue;
      }
      if (inList) {
        html += '<\/ul>';
        inList = false;
      }
      if (line.trim().length === 0) {
        html += '<br>';
      } else {
        html += formatInline(line) + '<br>';
      }
    }
    if (inList) html += '<\/ul>';
    return html;
  }

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
    | { from?: string; banner?: boolean; body: string }
    | null = null;

  private kickoffSendTime: number | null = null;
  private kickoffCreated = false;
  private momSendTime: number | null = null;
  private momCreated = false;

  showDeleted = false;
  private meAddress = '';
  showSent = false;

  constructor(
    private route: ActivatedRoute,
    private inboxService: InboxService,
    private http: HttpClient,
    private replyRouter: ReplyRouterService
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
          this.allEmails = emails;
          this.inbox = this.sortEmails(this.filteredEmails(this.allEmails));
          if (!this.selectedEmail && this.inbox.length) this.selectedEmail = this.inbox[0];
        });
      });
  }

  ngOnDestroy(): void {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  selectEmail(email: Email): void {
    this.selectedEmail = email;
    this.showReplyBox = false;
    this.replyText = '';
  }

  deleteSelected(): void {
    if (!this.selectedEmail) return;
    this.inboxService
      .deleteEmail(this.companyId, this.selectedEmail.id)
      .then(() => {
        const idx = this.allEmails.findIndex((e) => e.id === this.selectedEmail?.id);
        if (idx >= 0) this.allEmails[idx].deleted = true;
        this.inbox = this.sortEmails(this.filteredEmails(this.allEmails));
        this.selectedEmail = null;
      });
  }

  archiveEmails(): void {
    this.showDeleted = !this.showDeleted;
    this.inboxService
      .getInbox(this.companyId, this.showDeleted)
      .subscribe((emails) => {
        this.allEmails = emails;
        this.inbox = this.sortEmails(this.filteredEmails(this.allEmails));
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
        if (this.selectedEmail) this.selectedEmail.deleted = newDeletedState;
        const idx = this.allEmails.findIndex((e) => e.id === this.selectedEmail?.id);
        if (idx >= 0) this.allEmails[idx].deleted = newDeletedState;
        this.inbox = this.sortEmails(this.filteredEmails(this.allEmails));
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
        momEmailAt?: number;
        momEmailSent?: boolean;
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

      if (data.momEmailSent) {
        this.momSendTime = null;
      } else if (data.momEmailAt !== undefined) {
        this.momSendTime = data.momEmailAt;
      } else {
        const { start, end } = this.computeDay2Window(this.simDate);
        const totalMinutes = (this.businessEndHour - this.businessStartHour) * 60 - 1;
        const offset = this.randomInt(0, totalMinutes);
        const h = this.businessStartHour + Math.floor(offset / 60);
        const m = offset % 60;
        const at = new Date(start.getTime());
        at.setHours(h, m, 0, 0);
        this.momSendTime = at.getTime();
        await updateDoc(ref, { momEmailAt: this.momSendTime });
      }
      const anyData = snap.data() as any;
      let domain = `${this.companyId}.com`;
      if (anyData && anyData.company_name) {
        domain = String(anyData.company_name).replace(/\s+/g, '').toLowerCase() + '.com';
      }
      this.meAddress = `me@${domain}`;
    } else {
      const firstAt = this.computeFirstDaySuperEats(this.simDate);
      this.superEatsSendTime = firstAt.getTime();
      const { start } = this.computeDay2Window(this.simDate);
      const totalMinutes = (this.businessEndHour - this.businessStartHour) * 60 - 1;
      const offset = this.randomInt(0, totalMinutes);
      const h = this.businessStartHour + Math.floor(offset / 60);
      const m = offset % 60;
      const momAt = new Date(start.getTime());
      momAt.setHours(h, m, 0, 0);
      this.momSendTime = momAt.getTime();

      await setDoc(ref, {
        simTime: this.simDate.getTime(),
        speed: this.speed,
        superEatsNextAt: this.superEatsSendTime,
        momEmailAt: this.momSendTime,
        momEmailSent: false,
      });
      this.meAddress = `me@${this.companyId}.com`;
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
      this.checkMomEmail();

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
    if (!(this as any).superEatsTemplate) return;
    const tpl = (this as any).superEatsTemplate as {
      from?: string;
      banner?: boolean;
      body: string;
    };
    if (!tpl.from || tpl.banner === undefined) return;
    const from = tpl.from;
    const banner = tpl.banner;
    const message = tpl.body
      .replace(/\{SNACK_NAME\}/g, snack.name)
      .replace(/\{QUANTITY\}/g, String(quantity))
      .replace(/\{SNACK_PRICE\}/g, snack.price)
      .replace(/\{TOTAL_PRICE\}/g, totalPrice);
    const emailId = `supereats-${Date.now()}`;
    setDoc(doc(db, `companies/${this.companyId}/inbox/${emailId}`), {
      from,
      subject,
      message,
      deleted: false,
      banner,
      timestamp: this.simDate.toISOString(),
      threadId: emailId,
      to: this.meAddress,
    }).then(async () => {
      const nextAt = this.computeNextSuperEats(this.simDate);
      this.superEatsSendTime = nextAt.getTime();
      const ref = doc(db, `companies/${this.companyId}`);
      await updateDoc(ref, { superEatsNextAt: this.superEatsSendTime });
    });
  }

  private computeDay2Window(now: Date): { start: Date; end: Date } {
    const d0 = new Date(now.getTime());
    d0.setHours(0, 0, 0, 0);
    const start = new Date(d0.getTime() + 24 * 60 * 60 * 1000);
    start.setHours(this.businessStartHour, 0, 0, 0);
    const end = new Date(d0.getTime() + 24 * 60 * 60 * 1000);
    end.setHours(this.businessEndHour, 0, 0, 0);
    return { start, end };
  }

  private loadSuperEatsTemplate(): void {
    this.http
      .get('emails/supereats.md', { responseType: 'text' })
      .subscribe({
        next: (text) => {
          const parsed = this.parseMarkdownEmail(text);
          this.superEatsTemplate = {
            from: parsed.from,
            banner: parsed.banner,
            body: parsed.body,
          };
        },
        error: () => {},
      });
  }

  openReply(): void {
    if (!this.selectedEmail) return;
    this.showReplyBox = true;
    this.replyText = '';
  }

  onReplyKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || (event as any).metaKey) && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      this.sendReply();
    }
  }

  toggleSent(): void {
    this.showSent = !this.showSent;
    this.inbox = this.sortEmails(this.filteredEmails(this.allEmails));
    this.selectedEmail = null;
  }

  async sendReply(): Promise<void> {
    if (!this.selectedEmail || !this.replyText.trim()) return;
    const baseSubject = this.selectedEmail.subject || '';
    const subject = baseSubject.startsWith('Re:') ? baseSubject : `Re: ${baseSubject}`;
    const threadId = (this.selectedEmail as any).threadId || this.selectedEmail.id;
    try {
      const to = this.selectedEmail.sender || '';
      let category = (this.selectedEmail as any).category || '';
      if (!category) {
        const tid = String(threadId);
        if (tid === 'welcome-vlad' || tid.includes('vlad')) category = 'vlad';
        else if (tid.startsWith('kickoff-')) category = 'kickoff';
        else if (tid.startsWith('mom-')) category = 'mom';
        else category = 'generic';
      }
      const replyId = await this.inboxService.sendReply(this.companyId, {
        threadId,
        subject,
        message: this.replyText.trim(),
        parentId: this.selectedEmail.id,
        from: this.meAddress,
        to,
        category,
        timestamp: this.simDate.toISOString(),
      });
      await this.replyRouter.handleReply({
        companyId: this.companyId,
        category,
        threadId,
        subject,
        parentId: replyId,
        timestamp: this.simDate.toISOString(),
      });
      this.showReplyBox = false;
      this.replyText = '';
    } catch (e) {
      console.error('Failed to send reply', e);
    }
  }

  private filteredEmails(emails: Email[]): Email[] {
    if (this.showDeleted) return emails.filter((e) => !!e.deleted);
    const byInbox = emails.filter((e) => !e.deleted);
    if (this.showSent) return byInbox.filter((e) => (e as any).sender === this.meAddress);
    return byInbox.filter((e) => (e as any).sender !== this.meAddress);
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

  private readonly businessStartHour = 10;
  private readonly businessEndHour = 20;
  private readonly nextMinDays = 1.5;
  private readonly nextMaxDays = 3.5;

  private startOfDay(d: Date): Date {
    const x = new Date(d.getTime());
    x.setHours(0, 0, 0, 0);
    return x;
  }

  private randomInt(minInclusive: number, maxInclusive: number): number {
    return Math.floor(Math.random() * (maxInclusive - minInclusive + 1)) + minInclusive;
  }

  private computeFirstDaySuperEats(now: Date): Date {
    const d = new Date(now.getTime());
    const hr = d.getHours();
    const min = d.getMinutes();

    const windowStart = new Date(this.startOfDay(d).getTime());
    windowStart.setHours(this.businessStartHour, 0, 0, 0);
    const windowEnd = new Date(this.startOfDay(d).getTime());
    windowEnd.setHours(this.businessEndHour, 0, 0, 0);

    const pickRandomInWindow = (baseDay: Date): Date => {
      const totalMinutes = (this.businessEndHour - this.businessStartHour) * 60 - 1;
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
    const deltaDays = this.nextMinDays + Math.random() * (this.nextMaxDays - this.nextMinDays);
    const base = new Date(after.getTime() + deltaDays * 24 * 60 * 60 * 1000);
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
            threadId: emailId,
            to: this.meAddress,
            category: 'kickoff',
          }).catch(() => {
            this.kickoffCreated = false;
          });
        },
        error: () => {
          this.kickoffCreated = false;
        },
      });
  }

  private checkMomEmail(): void {
    if (this.momCreated) return;
    if (!this.momSendTime) return;
    if (this.simDate.getTime() < this.momSendTime) return;

    this.momCreated = true;
    const snackName = this.selectedSnack?.name || '';
    this.http
      .post<any>(momUrl, { name: this.companyId, snack: snackName })
      .subscribe({
        next: (email) => {
          const emailId = `mom-${Date.now()}`;
          setDoc(doc(db, `companies/${this.companyId}/inbox/${emailId}`), {
            from: email.from,
            subject: email.subject,
            message: email.body,
            deleted: false,
            banner: false,
            timestamp: this.simDate.toISOString(),
            threadId: emailId,
            to: this.meAddress,
            category: 'mom',
          }).then(async () => {
            const ref = doc(db, `companies/${this.companyId}`);
            await updateDoc(ref, { momEmailSent: true });
          }).catch(() => {
            this.momCreated = false;
          });
        },
        error: () => {
          this.momCreated = false;
        },
      });
  }
}
