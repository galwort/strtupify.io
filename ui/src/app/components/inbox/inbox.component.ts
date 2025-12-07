import { Component, OnInit, OnDestroy, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { InboxService, Email } from '../../services/inbox.service';
import { ReplyRouterService } from '../../services/reply-router.service';
import { Subscription } from 'rxjs';
import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  collection,
  query,
  where,
  limit,
  runTransaction,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { EndgameService, EndgameStatus } from '../../services/endgame.service';
import { UiStateService } from '../../services/ui-state.service';

const fbApp = getApps().length
  ? getApps()[0]
  : initializeApp(environment.firebase);
const db = getFirestore(fbApp);
const kickoffUrl = 'https://fa-strtupifyio.azurewebsites.net/api/kickoff_email';
const momUrl = 'https://fa-strtupifyio.azurewebsites.net/api/mom_email';
const cadabraUrl = 'https://fa-strtupifyio.azurewebsites.net/api/order';

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

  showReplyBox = false;
  replyText = '';
  sendingReply = false;
  clickedSend = false;
  showComposeBox = false;
  composeTo = '';
  composeSubject = '';
  composeBody = '';
  sendingCompose = false;
  composeClicked = false;
  composeError = '';
  private pendingReplyTimers: any[] = [];
  private readonly replyDelayMinMs = 3000;
  private readonly replyDelayMaxMs = 12000;
  private readonly kickoffDelayMs = 5 * 60_000;
  get replySubject(): string {
    const base = this.selectedEmail?.subject || '';
    return base.startsWith('Re:') ? base : `Re: ${base}`;
  }

  get threadMessages(): Email[] {
    if (!this.selectedEmail) return [];
    const tid = (this.selectedEmail as any).threadId || this.selectedEmail.id;
    const selectedTs = new Date(this.selectedEmail.timestamp || '').getTime();
    const isValidTs = Number.isFinite(selectedTs);
    const list = this.allEmails.filter((e) => {
      const sameThread = ((e as any).threadId || e.id) === tid;
      if (!sameThread) return false;
      if (e.id === this.selectedEmail?.id) return false;
      if (!isValidTs) return false;
      const ts = new Date(e.timestamp || '').getTime();
      return Number.isFinite(ts) && ts < selectedTs;
    });
    return list
      .slice()
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
  }

  renderEmailBody(text: string | undefined | null): string {
    if (!text) return '';
    return this.simpleMarkdown(text);
  }

  private simpleMarkdown(src: string): string {
    const escape = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const formatInline = (s: string) => {
      let out = escape(s);

      out = out.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
      );

      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

      out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

      out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
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
        html += '</ul>';
        inList = false;
      }
      if (line.trim().length === 0) {
        html += '<br>';
      } else {
        html += formatInline(line) + '<br>';
      }
    }
    if (inList) html += '</ul>';
    return html;
  }

  private parseEmailTemplate(text: string): {
    from?: string;
    subject?: string;
    banner?: boolean;
    deleted?: boolean;
    body: string;
  } {
    const lines = (text || '').split(/\r?\n/);
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

  displayDate = '';
  displayTime = '';

  private readonly speedMultiplier = 10;
  private readonly baseSpeed = this.speedMultiplier;
  private simDate = new Date();
  private speed = this.baseSpeed;
  private readonly maxSpeed = 240 * this.speedMultiplier;
  private readonly tickMs = 250;
  private readonly tickMinDelayMs = 8000;
  private readonly tickMaxDelayMs = 13000;
  private readonly accelPerTick = 0.1 * this.speedMultiplier;
  private readonly realPhaseMs = (5 * 60_000) / this.speedMultiplier;
  private readonly saveEveryMs = 5000;
  private elapsedSinceStart = 0;
  private elapsedSinceSave = 0;
  private intervalId: any;
  private tickQueue = Promise.resolve();
  private tickDelayHandle: any;
  private tickDelayResolver: (() => void) | null = null;
  private destroyed = false;
  private deleteInFlight = false;
  private suppressedIds = new Map<string, number>();
  private readonly suppressMs = 2000;
  private pendingSelectionId: string | null = null;

  private snacks: { name: string; price: string }[] = [];
  private selectedSnack: { name: string; price: string } | null = null;
  private selectedSnackName: string | null = null;
  private superEatsSendTime: number | null = null;
  private superEatsTemplate: {
    from?: string;
    banner?: boolean;
    body: string;
  } | null = null;
  private superEatsProcessing = false;

  private bankSendTime: number | null = null;
  private bankTemplate: {
    from?: string;
    subject?: string;
    banner?: boolean;
    body: string;
  } | null = null;
  private bankProcessing = false;

  private cadabraSendTime: number | null = null;
  private cadabraTemplate: {
    from?: string;
    subject?: string;
    banner?: boolean;
    body: string;
  } | null = null;
  private cadabraProcessing = false;

  private kickoffSendTime: number | null = null;
  private momSendTime: number | null = null;
  private calendarEmailAt: number | null = null;

  showDeleted = false;
  meAddress = '';
  showSent = false;
  private inboxSub: Subscription | null = null;
  private endgameStatus: EndgameStatus = 'idle';
  private endgameSub: Subscription | null = null;
  private endgameTriggeredAtMs: number | null = null;
  private inboxPreferredSub: Subscription | null = null;
  private preferredInboxEmailId: string | null = null;

  constructor(
    private route: ActivatedRoute,
    private inboxService: InboxService,
    private http: HttpClient,
    private replyRouter: ReplyRouterService,
    private endgame: EndgameService,
    private ui: UiStateService
  ) {}

  async ngOnInit(): Promise<void> {
    if (!this.companyId) return;

    this.inboxPreferredSub = this.ui.inboxPreferredEmailId$.subscribe((id) => {
      this.preferredInboxEmailId = id;
      if (id) {
        this.updateInboxView(this.allEmails, { preferredId: id });
        this.ui.setInboxPreferredEmail(null);
      }
    });

    this.endgame.setCompany(this.companyId);
    this.endgameSub = this.endgame.state$.subscribe((s) => {
      this.endgameStatus = s.status;
      const trig = Number(s.triggeredAt);
      this.endgameTriggeredAtMs = Number.isFinite(trig) ? trig : null;
      if (this.endgameStatus !== 'idle') {
        this.stopSimTimers();
      }
      this.updateInboxView(this.allEmails);
    });

    await this.loadClockState();
    {
      const ref = doc(db, `companies/${this.companyId}`);
      const unsub = (await import('firebase/firestore')).onSnapshot(
        ref,
        (snap) => {
          const d = (snap && (snap.data() as any)) || {};
          if (typeof d.simTime === 'number') {
            this.simDate = new Date(d.simTime);
            this.updateDisplay();
            this.enqueueTick();
          }
          if (d.calendarEmailSent) this.calendarEmailAt = null;
          else if (typeof d.calendarEmailAt === 'number')
            this.calendarEmailAt = d.calendarEmailAt;
        }
      );
      (this as any).__unsubInboxSim = unsub;
    }
    this.loadSnacks();
    this.loadSuperEatsTemplate();
    this.loadBankTemplate();
    this.loadCadabraTemplate();

    this.inboxService.ensureWelcomeEmail(this.companyId).finally(() => {
      this.subscribeToInbox();
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopSimTimers();
    if (this.inboxSub) {
      try {
        this.inboxSub.unsubscribe();
      } catch {}
    }
    if (this.endgameSub) {
      try {
        this.endgameSub.unsubscribe();
      } catch {}
    }
    if (this.inboxPreferredSub) {
      try {
        this.inboxPreferredSub.unsubscribe();
      } catch {}
    }
    this.suppressedIds.clear();
    for (const t of this.pendingReplyTimers) {
      try {
        clearTimeout(t);
      } catch {}
    }
  }

  selectEmail(email: Email): void {
    this.selectedEmail = email;
    this.showReplyBox = false;
    this.showComposeBox = false;
    this.composeError = '';
    this.replyText = '';
  }

  deleteSelected(): void {
    if (!this.selectedEmail || this.deleteInFlight) return;
    this.deleteInFlight = true;
    const currentId = this.selectedEmail.id;
    const nextId = this.nextSelectableId(currentId, this.inbox);
    this.pendingSelectionId = nextId;
    this.inboxService
      .deleteEmail(this.companyId, this.selectedEmail.id)
      .then(() => {})
      .finally(() => {
        if (currentId)
          this.suppressedIds.set(currentId, Date.now() + this.suppressMs);
        this.deleteInFlight = false;
      });
  }

  archiveEmails(): void {
    this.showDeleted = !this.showDeleted;
    this.showComposeBox = false;
    this.composeError = '';
    this.subscribeToInbox();
  }

  toggleDelete(): void {
    if (!this.selectedEmail || this.deleteInFlight) return;
    this.deleteInFlight = true;
    const newDeletedState = !this.showDeleted;
    const updateMethod = newDeletedState
      ? this.inboxService.deleteEmail
      : this.inboxService.undeleteEmail;

    updateMethod
      .call(this.inboxService, this.companyId, this.selectedEmail.id)
      .then(() => {
        const currentId = this.selectedEmail ? this.selectedEmail.id : null;
        const nextId = currentId
          ? this.nextSelectableId(currentId, this.inbox)
          : null;
        if (newDeletedState && currentId) {
          this.suppressedIds.set(currentId, Date.now() + this.suppressMs);
        }
        this.pendingSelectionId = nextId;
      })
      .finally(() => {
        this.deleteInFlight = false;
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
      const data = snap.data() as any;
      if (!data || !data.simStarted) {
        this.simDate = new Date();
        this.speed = this.baseSpeed;
        try {
          await updateDoc(ref, {
            simTime: this.simDate.getTime(),
            speed: this.speed,
            simStarted: true,
          });
        } catch {}
      } else {
        if (typeof data.simTime === 'number')
          this.simDate = new Date(data.simTime);
        if (typeof data.speed === 'number') {
          this.speed = data.speed;
          if (this.speed < this.baseSpeed) this.speed = this.baseSpeed;
        } else {
          this.speed = this.baseSpeed;
        }
      }
      if (data.superEatsNextAt !== undefined) {
        this.superEatsSendTime = data.superEatsNextAt;
      } else {
        const firstAt = this.computeFirstDaySuperEats(this.simDate);
        this.superEatsSendTime = firstAt.getTime();
        await updateDoc(ref, { superEatsNextAt: this.superEatsSendTime });
      }

      if (data.bankNextAt !== undefined) {
        this.bankSendTime = data.bankNextAt;
      } else {
        const firstBankAt = this.computeNextFriday5(this.simDate);
        this.bankSendTime = firstBankAt.getTime();
        await updateDoc(ref, { bankNextAt: this.bankSendTime });
      }

      if (data.cadabraNextAt !== undefined) {
        this.cadabraSendTime = data.cadabraNextAt;
      } else {
        const firstCadabraAt = this.computeNextCadabra(this.simDate);
        this.cadabraSendTime = firstCadabraAt.getTime();
        await updateDoc(ref, { cadabraNextAt: this.cadabraSendTime });
      }

      if (data.kickoffEmailSent) {
        this.kickoffSendTime = null;
      } else if (typeof data.kickoffEmailAt === 'number') {
        this.kickoffSendTime = data.kickoffEmailAt;
      } else {
        const at = this.simDate.getTime() + 5 * 60_000;
        this.kickoffSendTime = at;
        try {
          await updateDoc(ref, { kickoffEmailAt: at, kickoffEmailSent: false });
        } catch {}
      }

      if (data.momEmailSent) {
        this.momSendTime = null;
      } else if (data.momEmailAt !== undefined) {
        this.momSendTime = data.momEmailAt;
      } else {
        const { start, end } = this.computeDay2Window(this.simDate);
        const totalMinutes =
          (this.businessEndHour - this.businessStartHour) * 60 - 1;
        const offset = this.randomInt(0, totalMinutes);
        const h = this.businessStartHour + Math.floor(offset / 60);
        const m = offset % 60;
        const at = new Date(start.getTime());
        at.setHours(h, m, 0, 0);
        this.momSendTime = at.getTime();
        await updateDoc(ref, { momEmailAt: this.momSendTime });
      }
      if (data.calendarEmailSent) {
        this.calendarEmailAt = null;
      } else if (typeof data.calendarEmailAt === 'number') {
        this.calendarEmailAt = data.calendarEmailAt;
      } else {
        this.calendarEmailAt = null;
        await this.ensureCalendarScheduledFallback();
      }
      if (typeof data.snackChoice === 'string' && data.snackChoice.trim()) {
        this.selectedSnackName = data.snackChoice.trim();
      } else {
        this.selectedSnackName = null;
      }
      this.ensureSelectedSnack();
      const anyData = snap.data() as any;
      if (data.superEatsEmailInProgress) {
        try {
          await updateDoc(ref, { superEatsEmailInProgress: false });
        } catch {}
      }
      if (data.bankEmailInProgress) {
        try {
          await updateDoc(ref, { bankEmailInProgress: false });
        } catch {}
      }
      if (data.cadabraEmailInProgress) {
        try {
          await updateDoc(ref, { cadabraEmailInProgress: false });
        } catch {}
      }
      let domain = `${this.companyId}.com`;
      if (anyData && anyData.company_name) {
        domain =
          String(anyData.company_name).replace(/\s+/g, '').toLowerCase() +
          '.com';
      }
      this.meAddress = `me@${domain}`;
    } else {
      const firstAt = this.computeFirstDaySuperEats(this.simDate);
      this.superEatsSendTime = firstAt.getTime();
      const firstBankAt = this.computeNextFriday5(this.simDate);
      this.bankSendTime = firstBankAt.getTime();
      const firstCadabraAt = this.computeNextCadabra(this.simDate);
      this.cadabraSendTime = firstCadabraAt.getTime();
      const { start } = this.computeDay2Window(this.simDate);
      const totalMinutes =
        (this.businessEndHour - this.businessStartHour) * 60 - 1;
      const offset = this.randomInt(0, totalMinutes);
      const h = this.businessStartHour + Math.floor(offset / 60);
      const m = offset % 60;
      const momAt = new Date(start.getTime());
      momAt.setHours(h, m, 0, 0);
      this.momSendTime = momAt.getTime();
      this.selectedSnack = null;
      this.selectedSnackName = null;

      await setDoc(ref, {
        simTime: this.simDate.getTime(),
        speed: this.speed,
        simStarted: true,
        superEatsNextAt: this.superEatsSendTime,
        superEatsEmailInProgress: false,
        bankNextAt: this.bankSendTime,
        bankEmailInProgress: false,
        cadabraNextAt: this.cadabraSendTime,
        cadabraEmailInProgress: false,
        kickoffEmailAt: this.simDate.getTime() + 5 * 60_000,
        kickoffEmailSent: false,
        momEmailAt: this.momSendTime,
        momEmailSent: false,
        calendarEmailAt: null,
        calendarEmailSent: false,
        calendarEmailInProgress: false,
        calendarEnabled: false,
      });
      this.meAddress = `me@${this.companyId}.com`;
    }
    this.updateDisplay();
  }

  private async ensureCalendarScheduledFallback(): Promise<void> {
    try {
      const ref = doc(db, `companies/${this.companyId}`);
      const companySnap = await getDoc(ref);
      const data = (companySnap && (companySnap.data() as any)) || {};
      if (data.calendarEmailSent || typeof data.calendarEmailAt === 'number')
        return;
      const kickoffSnap = await getDocs(
        query(
          collection(db, `companies/${this.companyId}/inbox`),
          where('category', '==', 'kickoff'),
          limit(5)
        )
      );
      const hasKickoffReply = kickoffSnap.docs.some((d) => {
        const x = (d.data() as any) || {};
        return typeof x.parentId === 'string' && x.parentId.trim().length > 0;
      });
      if (!hasKickoffReply) return;
      const target = this.simDate.getTime() + 5 * 60_000;
      await updateDoc(ref, {
        calendarEmailAt: target,
        calendarEmailSent: false,
        calendarEmailInProgress: false,
        calendarEnabled: false,
      });
      this.calendarEmailAt = target;
    } catch {}
  }

  private async getCompanySimTime(): Promise<number> {
    try {
      const snap = await getDoc(doc(db, `companies/${this.companyId}`));
      const data = (snap && (snap.data() as any)) || {};
      const value = Number(data.simTime || this.simDate.getTime());
      return Number.isFinite(value) && value > 0
        ? value
        : this.simDate.getTime();
    } catch {
      return this.simDate.getTime();
    }
  }

  private startClock(): void {
    if (this.endgameStatus !== 'idle') return;
    const ref = doc(db, `companies/${this.companyId}`);

    this.intervalId = setInterval(async () => {
      if (this.endgameStatus !== 'idle') {
        this.stopSimTimers();
        return;
      }
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
      void this.checkSuperEatsEmail();
      this.checkKickoffEmail();
      this.checkCalendarEmail();
      this.checkMomEmail();
      this.checkBankEmail();
      void this.checkCadabraEmail();

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

  private stopSimTimers(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.tickDelayHandle) {
      clearTimeout(this.tickDelayHandle);
      this.tickDelayHandle = null;
    }
    if (this.tickDelayResolver) {
      this.tickDelayResolver();
      this.tickDelayResolver = null;
    }
    this.tickQueue = Promise.resolve();
  }

  private updateDisplay(): void {
    this.displayDate = this.simDate.toLocaleDateString();
    this.displayTime = this.simDate.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  private enqueueTick(): void {
    if (this.endgameStatus !== 'idle') return;
    this.tickQueue = this.tickQueue
      .then(() => this.runTickOnce())
      .catch(() => {});
  }

  private async runTickOnce(): Promise<void> {
    if (!this.companyId || this.destroyed || this.endgameStatus !== 'idle') return;
    const delay = this.randomInt(this.tickMinDelayMs, this.tickMaxDelayMs);
    await new Promise<void>((resolve) => {
      this.tickDelayResolver = resolve;
      this.tickDelayHandle = setTimeout(() => {
        this.tickDelayResolver = null;
        resolve();
      }, delay);
    });
    this.tickDelayHandle = null;
    this.tickDelayResolver = null;
    if (this.destroyed || this.endgameStatus !== 'idle') return;
    try {
      await this.checkSuperEatsEmail();
      await this.checkKickoffEmail();
      await this.checkMomEmail();
      await this.checkBankEmail();
      await this.checkCadabraEmail();
    } catch {}
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
        this.ensureSelectedSnack();
      });
  }

  private ensureSelectedSnack(): void {
    if (!this.snacks.length) return;
    if (
      this.selectedSnack &&
      this.selectedSnackName === this.selectedSnack.name
    )
      return;

    if (this.selectedSnackName) {
      const existing = this.snacks.find(
        (s) => s.name === this.selectedSnackName
      );
      if (existing) {
        this.selectedSnack = existing;
        return;
      }
      this.selectedSnackName = null;
    }

    const choice = this.snacks[Math.floor(Math.random() * this.snacks.length)];
    this.selectedSnack = choice;
    this.selectedSnackName = choice.name;
    this.persistSelectedSnack(choice.name).catch(() => {});
  }

  private async persistSelectedSnack(name: string): Promise<void> {
    if (!this.companyId) return;
    const ref = doc(db, `companies/${this.companyId}`);
    try {
      await updateDoc(ref, { snackChoice: name });
    } catch {}
  }

  private async checkSuperEatsEmail(): Promise<void> {
    if (!this.superEatsSendTime) return;
    if (this.simDate.getTime() < this.superEatsSendTime) return;
    if (!this.snacks.length) return;
    if (this.superEatsProcessing) return;
    this.superEatsProcessing = true;

    const companyRef = doc(db, `companies/${this.companyId}`);
    let proceed = false;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(companyRef);
        const d = (snap && (snap.data() as any)) || {};
        const nextAt =
          typeof d.superEatsNextAt === 'number'
            ? d.superEatsNextAt
            : this.superEatsSendTime;
        const busy = !!d.superEatsEmailInProgress;
        if (!nextAt || this.simDate.getTime() < nextAt || busy) return;
        tx.update(companyRef, { superEatsEmailInProgress: true });
        proceed = true;
        this.superEatsSendTime = nextAt;
      });
    } catch {}
    if (!proceed) {
      this.superEatsProcessing = false;
      return;
    }

    this.ensureSelectedSnack();
    const snack = this.selectedSnack;
    if (!snack) {
      this.superEatsProcessing = false;
      try {
        await updateDoc(companyRef, { superEatsEmailInProgress: false });
      } catch {}
      return;
    }
    const quantity = Math.floor(Math.random() * 4) + 2;
    const unitPrice = parseFloat(snack.price);
    const totalAmount = Number((unitPrice * quantity).toFixed(2));
    const totalPrice = totalAmount.toFixed(2);
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
    if (!(this as any).superEatsTemplate) {
      this.superEatsProcessing = false;
      try {
        await updateDoc(companyRef, { superEatsEmailInProgress: false });
      } catch {}
      return;
    }
    const tpl = (this as any).superEatsTemplate as {
      from?: string;
      banner?: boolean;
      body: string;
    };
    if (!tpl.from || tpl.banner === undefined) {
      this.superEatsProcessing = false;
      try {
        await updateDoc(companyRef, { superEatsEmailInProgress: false });
      } catch {}
      return;
    }
    const from = tpl.from;
    const banner = tpl.banner;
    const message = tpl.body
      .replace(/\{SNACK_NAME\}/g, snack.name)
      .replace(/\{QUANTITY\}/g, String(quantity))
      .replace(/\{SNACK_PRICE\}/g, snack.price)
      .replace(/\{TOTAL_PRICE\}/g, totalPrice);
    const ledgerMemo = `${quantity}x ${snack.name}`;
    const emailId = `supereats-${Date.now()}`;
    try {
      await setDoc(doc(db, `companies/${this.companyId}/inbox/${emailId}`), {
        from,
        subject,
        message,
        deleted: false,
        banner,
        timestamp: this.simDate.toISOString(),
        threadId: emailId,
        to: this.meAddress,
        category: 'supereats',
        supereatsQuantity: quantity,
        supereatsUnitPrice: unitPrice,
        supereatsTotal: totalAmount,
        ledgerAmount: totalAmount,
        ledgerMemo,
        supereats: {
          snack: snack.name,
          quantity,
          unitPrice,
          total: totalAmount,
        },
        ledger: { type: 'supereats', amount: totalAmount, memo: ledgerMemo },
      });
      const nextAt = this.computeNextSuperEats(this.simDate);
      this.superEatsSendTime = nextAt.getTime();
      await updateDoc(companyRef, {
        superEatsNextAt: this.superEatsSendTime,
        superEatsEmailInProgress: false,
      });
    } catch {
      try {
        await updateDoc(companyRef, { superEatsEmailInProgress: false });
      } catch {}
    } finally {
      this.superEatsProcessing = false;
    }
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
    this.http.get('emails/supereats.md', { responseType: 'text' }).subscribe({
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

  private async loadBankTemplate(): Promise<void> {
    this.http.get('emails/bank.md', { responseType: 'text' }).subscribe({
      next: (text) => {
        const parsed = this.parseMarkdownEmail(text);
        this.bankTemplate = {
          from: parsed.from,
          subject: parsed.subject,
          banner: parsed.banner,
          body: parsed.body,
        };
      },
      error: () => {},
    });
  }

  private loadCadabraTemplate(): void {
    this.http.get('emails/cadabra.md', { responseType: 'text' }).subscribe({
      next: (text) => {
        const parsed = this.parseMarkdownEmail(text);
        this.cadabraTemplate = {
          from: parsed.from,
          subject: parsed.subject,
          banner: parsed.banner,
          body: parsed.body,
        };
      },
      error: () => {},
    });
  }

  openReply(): void {
    if (!this.selectedEmail) return;
    this.showComposeBox = false;
    this.composeError = '';
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

  openCompose(): void {
    this.showReplyBox = false;
    this.composeError = '';
    this.selectedEmail = null;
    this.composeTo = '';
    this.composeSubject = '';
    this.composeBody = '';
    this.sendingCompose = false;
    this.composeClicked = false;
    this.showComposeBox = true;
  }

  closeCompose(): void {
    this.showComposeBox = false;
    if (!this.sendingCompose) {
      this.composeTo = '';
      this.composeSubject = '';
      this.composeBody = '';
    }
    this.composeClicked = false;
    this.composeError = '';
  }

  onComposeKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || (event as any).metaKey) && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      this.sendCompose();
    }
  }

  async sendCompose(): Promise<void> {
    if (this.sendingCompose) return;
    const to = (this.composeTo || '').trim();
    const subject = (this.composeSubject || '').trim();
    const message = (this.composeBody || '').trim();
    this.composeError = '';
    if (!to) {
      this.composeError = 'Recipient is required.';
      return;
    }
    if (!this.isValidEmailAddress(to)) {
      this.composeError = 'Please enter a valid email address.';
      return;
    }
    if (!message) {
      this.composeError = 'Message body cannot be empty.';
      return;
    }
    this.sendingCompose = true;
    this.composeClicked = true;
    setTimeout(() => (this.composeClicked = false), 300);
    const resolvedSubject = subject || '(no subject)';
    const threadId = this.createThreadId('outbound');
    const timestamp = this.simDate.toISOString();
    try {
      const category = this.resolveRecipientCategory(to);
      const emailId = await this.inboxService.sendEmail(this.companyId, {
        threadId,
        subject: resolvedSubject,
        message,
        from: this.meAddress,
        to,
        category,
        timestamp,
      });
      await this.replyRouter.handleOutbound({
        companyId: this.companyId,
        to,
        subject: resolvedSubject,
        message,
        threadId,
        parentId: emailId,
        timestamp,
      });
      this.showComposeBox = false;
      this.composeTo = '';
      this.composeSubject = '';
      this.composeBody = '';
      this.composeError = '';
      this.selectedEmail = null;
    } catch (err) {
      console.error('Failed to send email', err);
      this.composeError = 'We could not send your message. Please try again.';
    } finally {
      this.sendingCompose = false;
    }
  }

  toggleSent(): void {
    this.showSent = !this.showSent;
    this.showComposeBox = false;
    this.composeError = '';
    this.updateInboxView(this.allEmails);
  }

  async sendReply(): Promise<void> {
    if (!this.selectedEmail || !this.replyText.trim()) return;
    if (this.sendingReply) return;
    this.sendingReply = true;
    this.clickedSend = true;
    setTimeout(() => (this.clickedSend = false), 300);
    const baseSubject = this.selectedEmail.subject || '';
    const subject = baseSubject.startsWith('Re:')
      ? baseSubject
      : `Re: ${baseSubject}`;
    const threadId =
      (this.selectedEmail as any).threadId || this.selectedEmail.id;
    try {
      const to = this.selectedEmail.sender || '';
      let category = (this.selectedEmail as any).category || '';
      if (!category) {
        const tid = String(threadId);
        if (tid === 'vlad-welcome' || tid.includes('vlad')) category = 'vlad';
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

      const delay = this.randomInt(this.replyDelayMinMs, this.replyDelayMaxMs);
      const timer = setTimeout(() => {
        this.replyRouter
          .handleReply({
            companyId: this.companyId,
            category,
            threadId,
            subject,
            parentId: replyId,
            timestamp: this.simDate.toISOString(),
          })
          .catch(() => {});
      }, delay);
      this.pendingReplyTimers.push(timer);
      if (category === 'kickoff') {
        await this.scheduleCalendarAfterKickoffReply();
      }
      try {
        const ref = doc(db, `companies/${this.companyId}`);
        const snap = await getDoc(ref);
        const data = snap.data() as any;
        if (!data || !data.founded_at) {
          await updateDoc(ref, { founded_at: this.simDate.toISOString() });
        }
      } catch {}
      this.showReplyBox = false;
      this.replyText = '';
      this.sendingReply = false;
    } catch (e) {
      console.error('Failed to send reply', e);
      this.sendingReply = false;
    }
  }

  private resolveRecipientCategory(address: string): string {
    const normalized = (address || '').trim().toLowerCase();
    if (normalized === 'vlad@strtupify.io') {
      return 'vlad';
    }
    if (normalized === 'mom@altavista.net') {
      return 'mom';
    }
    return 'outbound';
  }

  private isValidEmailAddress(address: string): boolean {
    if (!address) return false;
    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    return emailRegex.test(address);
  }

  private createThreadId(prefix: string): string {
    const seed = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${Date.now()}-${seed}`;
  }

  private async sendCalendarEmailNow(simTimestamp: number): Promise<void> {
    const ref = doc(db, `companies/${this.companyId}`);
    const alreadySent = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = (snap && (snap.data() as any)) || {};
      if (data.calendarEmailSent || data.calendarEmailInProgress) return true;
      tx.update(ref, { calendarEmailInProgress: true });
      return false;
    }).catch(() => true);
    if (alreadySent) return;
    const parsed = await this.loadCalendarTemplate();
    const emailId = `calendar-${Date.now()}`;
    const timestampIso = new Date(simTimestamp).toISOString();
    try {
      await setDoc(doc(db, `companies/${this.companyId}/inbox/${emailId}`), {
        from: parsed.from || 'vlad@strtupify.io',
        subject: parsed.subject || 'New calendar feature',
        message: parsed.body,
        deleted: parsed.deleted ?? false,
        banner: parsed.banner ?? false,
        timestamp: timestampIso,
        threadId: emailId,
        to: this.meAddress,
        category: 'calendar',
      });
      await updateDoc(ref, {
        calendarEmailSent: true,
        calendarEmailInProgress: false,
        calendarEnabled: true,
        calendarEmailAt: simTimestamp,
      });
      this.calendarEmailAt = null;
    } catch {
      try {
        await updateDoc(ref, { calendarEmailInProgress: false });
      } catch {}
    }
  }

  private async loadCalendarTemplate(): Promise<{
    from?: string;
    subject?: string;
    banner?: boolean;
    deleted?: boolean;
    body: string;
  }> {
    try {
      const text = await this.http
        .get('emails/vlad-calendar.md', { responseType: 'text' })
        .toPromise();
      const parsed = this.parseEmailTemplate(text || '');
      if (parsed.body) return parsed;
    } catch {}
    const fallback = this.parseEmailTemplate(
      [
        'From: vlad@strtupify.io',
        'Subject: New calendar feature',
        'Banner: false',
        'Deleted: false',
        '',
        'Hello End User,',
        '',
        'This is Vlad from IT. I added a calendar for next week so you can shuffle meetings. Your meetings are white with colored dots for attendees; teammates show up in their own color. Try to stack meetings together to leave big empty blocks for focus time, and submit when you are done. I am very busy so nothing else happens.',
        '',
        'Thank you!',
        'Vlad',
        'IT Support',
        'strtupify.io',
      ].join('\n')
    );
    return fallback;
  }

  private async scheduleCalendarAfterKickoffReply(): Promise<void> {
    try {
      const simNow = await this.getCompanySimTime();
      const target = simNow + this.kickoffDelayMs;
      const realDelay = Math.max(
        250,
        Math.floor(this.kickoffDelayMs / Math.max(1, this.speed))
      );
      const ref = doc(db, `companies/${this.companyId}`);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const data = (snap && (snap.data() as any)) || {};
        if (data.calendarEmailSent) return;
        const existing =
          typeof data.calendarEmailAt === 'number'
            ? data.calendarEmailAt
            : null;
        if (existing && simNow <= existing + this.kickoffDelayMs) {
          this.calendarEmailAt = existing;
          return;
        }
        tx.set(
          ref,
          {
            calendarEmailAt: target,
            calendarEmailSent: false,
            calendarEmailInProgress: false,
            calendarEnabled: false,
          },
          { merge: true }
        );
        this.calendarEmailAt = target;
      });
      setTimeout(() => {
        void this.sendCalendarEmailNow(target);
      }, realDelay);
    } catch {}
  }

  private filteredEmails(emails: Email[]): Email[] {
    const endgameEngaged = this.endgameStatus !== 'idle';
    const allowEndgameEmail = (e: Email): boolean => {
      const category = ((e as any).category || '').toLowerCase();
      const id = String(e.id || '');
      if (id.startsWith('vlad-reset-')) return true;
      if (category === 'kickoff-outcome') return true;
      if (category === 'calendar') return true;
      return false;
    };
    const cutoff = this.endgameTriggeredAtMs;
    const shouldHideForEndgame = (e: Email): boolean => {
      if (allowEndgameEmail(e)) return false;
      if (this.isEndgameFlagged(e)) return true;
      if (cutoff !== null) {
        const ts = this.emailTimestampMs(e);
        if (ts > 0 && ts < cutoff) return true;
      }
      return false;
    };

    let base = emails;
    if (endgameEngaged || cutoff !== null) {
      base = base.filter((e) => !shouldHideForEndgame(e));
    }

    if (this.showDeleted) base = base.filter((e) => !!e.deleted);
    else base = base.filter((e) => !e.deleted);

    if (this.showSent) {
      base = base.filter((e) => (e as any).sender === this.meAddress);
    } else {
      base = base.filter((e) => (e as any).sender !== this.meAddress);
    }

    return base;
  }

  private nextSelectableId(
    currentId: string | null,
    list: Email[]
  ): string | null {
    if (!currentId || !list.length) return null;
    const idx = list.findIndex((e) => e.id === currentId);
    if (idx === -1) return null;
    if (idx + 1 < list.length) return list[idx + 1].id;
    if (idx - 1 >= 0) return list[idx - 1].id;
    return null;
  }

  private emailTimestampMs(email: Email): number {
    const raw: any = (email as any)?.timestamp;
    const ts = raw ? new Date(raw).getTime() : NaN;
    return Number.isFinite(ts) ? ts : 0;
  }

  private isEndgameFlagged(email: Email): boolean {
    const flag = (email as any)?.endgame;
    if (flag === true) return true;
    if (flag === 1) return true;
    if (typeof flag === 'string' && flag.toLowerCase() === 'true') return true;
    const category = ((email as any).category || '').toLowerCase();
    return category === 'endgame' || category.includes('endgame');
  }

  private updateInboxView(
    emails: Email[],
    opts?: { preferredId?: string | null; avoidIds?: Array<string | null> }
  ): void {
    this.pruneSuppressed();
    this.allEmails = emails;
    this.inbox = this.sortEmails(this.filteredEmails(this.allEmails));
    const avoid = new Set<string>();
    (opts?.avoidIds || [])
      .filter((x): x is string => !!x)
      .forEach((x) => avoid.add(x));
    this.suppressedIds.forEach((exp, id) => {
      if (exp > Date.now()) avoid.add(id);
    });

    const preferredFromState = this.preferredInboxEmailId;
    let desiredId =
      opts?.preferredId ??
      preferredFromState ??
      this.pendingSelectionId ??
      this.selectedEmail?.id ??
      null;
    if (desiredId && !avoid.has(desiredId)) {
      const found = this.inbox.find((e) => e.id === desiredId);
      if (found) {
        this.selectedEmail = found;
        this.pendingSelectionId = null;
        this.preferredInboxEmailId = null;
        return;
      }
    }
    const first = this.inbox.find((e) => !avoid.has(e.id));
    this.selectedEmail = first || null;
    this.pendingSelectionId = null;
    this.preferredInboxEmailId = null;
  }

  private pruneSuppressed(): void {
    const now = Date.now();
    for (const [id, exp] of this.suppressedIds.entries()) {
      if (exp <= now) this.suppressedIds.delete(id);
    }
  }

  private subscribeToInbox(): void {
    if (this.inboxSub) {
      try {
        this.inboxSub.unsubscribe();
      } catch {}
    }
    this.inboxSub = this.inboxService
      .getInbox(this.companyId, this.showDeleted)
      .subscribe((emails) => this.updateInboxView(emails));
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
  private readonly cadabraMinDays = 7;
  private readonly cadabraMaxDays = 21;

  private startOfDay(d: Date): Date {
    const x = new Date(d.getTime());
    x.setHours(0, 0, 0, 0);
    return x;
  }

  private randomInt(minInclusive: number, maxInclusive: number): number {
    return (
      Math.floor(Math.random() * (maxInclusive - minInclusive + 1)) +
      minInclusive
    );
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
      const totalMinutes =
        (this.businessEndHour - this.businessStartHour) * 60 - 1;
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
    const offsetMin =
      this.randomInt(Math.max(minutesNow + 1, startMin), endMin) - startMin;
    const h = this.businessStartHour + Math.floor(offsetMin / 60);
    const m = offsetMin % 60;
    const t = new Date(windowStart.getTime());
    t.setHours(h, m, 0, 0);
    return t;
  }

  private computeNextSuperEats(after: Date): Date {
    const deltaDays =
      this.nextMinDays + Math.random() * (this.nextMaxDays - this.nextMinDays);
    const base = new Date(after.getTime() + deltaDays * 24 * 60 * 60 * 1000);
    const totalMinutes =
      (this.businessEndHour - this.businessStartHour) * 60 - 1;
    const offset = this.randomInt(0, totalMinutes);
    const h = this.businessStartHour + Math.floor(offset / 60);
    const m = offset % 60;
    const d = this.startOfDay(base);
    d.setHours(h, m, 0, 0);
    return d;
  }

  private computeNextCadabra(after: Date): Date {
    const deltaDays =
      this.cadabraMinDays +
      Math.random() * (this.cadabraMaxDays - this.cadabraMinDays);
    const base = new Date(after.getTime() + deltaDays * 24 * 60 * 60 * 1000);
    const totalMinutes =
      (this.businessEndHour - this.businessStartHour) * 60 - 1;
    const offset = this.randomInt(0, totalMinutes);
    const h = this.businessStartHour + Math.floor(offset / 60);
    const m = offset % 60;
    const d = this.startOfDay(base);
    d.setHours(h, m, 0, 0);
    return d;
  }

  private computeNextFriday5(after: Date): Date {
    const d = new Date(after.getTime());
    d.setSeconds(0, 0);
    const day = d.getDay();
    const hour = d.getHours();
    const minute = d.getMinutes();
    let daysUntilFriday = (5 - day + 7) % 7;
    let target = new Date(this.startOfDay(d).getTime());
    target.setDate(target.getDate() + daysUntilFriday);
    target.setHours(5, 0, 0, 0);
    if (daysUntilFriday === 0 && (hour > 5 || (hour === 5 && minute >= 0))) {
      target = new Date(target.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
    return target;
  }

  private formatCurrency(amount: number): string {
    const safe = Number.isFinite(amount) ? amount : 0;
    return safe.toFixed(2);
  }

  private generateCadabraOrderNumber(): string {
    const mid = this.randomInt(1000000, 9999999);
    const tail = this.randomInt(1000000, 9999999);
    return `${this.randomInt(100, 999)}-${mid}-${tail}`;
  }

  private computeCadabraEta(from: Date): string {
    const days = this.randomInt(2, 6);
    const eta = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
    return eta.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
  }

  private parseCadabraOrder(resp: any): {
    item: string;
    quantity: number;
    unitPrice: number;
    itemSubtotal: number;
    total: number;
  } {
    const fallback = { item: 'Bulk AA Batteries', quantity: 1, unitPrice: 14.99 };
    const item =
      String(
        resp?.item ||
          resp?.product ||
          resp?.order?.product ||
          resp?.order?.item ||
          ''
      ).trim() || fallback.item;
    const rawQty = Number(resp?.quantity ?? resp?.order?.quantity);
    let quantity =
      Number.isInteger(rawQty) && rawQty > 0 ? rawQty : fallback.quantity;
    quantity = Math.min(25, Math.max(1, quantity));

    const pickNumber = (...candidates: any[]): number => {
      for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return Number.NaN;
    };

    let unitPrice = pickNumber(
      resp?.unit_price,
      resp?.price,
      resp?.cost,
      resp?.order?.unit_price,
      resp?.order?.cost,
      resp?.order?.price
    );
    const totalCandidate = pickNumber(resp?.total, resp?.order?.total);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      if (Number.isFinite(totalCandidate) && totalCandidate > 0 && quantity > 0) {
        unitPrice = totalCandidate / quantity;
      }
    }
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) unitPrice = fallback.unitPrice;

    let total = Number.isFinite(totalCandidate)
      ? totalCandidate
      : unitPrice * quantity;
    if (!Number.isFinite(total) || total <= 0) total = unitPrice * quantity;

    if (total < 3) {
      total = 3.25;
      unitPrice = total / quantity;
    } else if (total > 999.99) {
      total = 999.99;
      unitPrice = total / quantity;
    }

    const unit = Number(unitPrice.toFixed(2));
    const itemSubtotal = Number((unit * quantity).toFixed(2));
    const grandTotal = Number(
      (Number.isFinite(total) ? total : itemSubtotal).toFixed(2)
    );

    return {
      item,
      quantity,
      unitPrice: unit,
      itemSubtotal,
      total: grandTotal > 0 ? grandTotal : itemSubtotal,
    };
  }

  private async checkCadabraEmail(): Promise<void> {
    if (!this.cadabraSendTime || !this.cadabraTemplate) return;
    if (this.simDate.getTime() < this.cadabraSendTime) return;
    if (this.cadabraProcessing) return;
    this.cadabraProcessing = true;

    const companyRef = doc(db, `companies/${this.companyId}`);
    let proceed = false;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(companyRef);
        const d = (snap && (snap.data() as any)) || {};
        const nextAt =
          typeof d.cadabraNextAt === 'number'
            ? d.cadabraNextAt
            : this.cadabraSendTime;
        const busy = !!d.cadabraEmailInProgress;
        if (!nextAt || this.simDate.getTime() < nextAt || busy) return;
        tx.update(companyRef, { cadabraEmailInProgress: true });
        proceed = true;
        this.cadabraSendTime = nextAt;
      });
    } catch {}
    if (!proceed) {
      this.cadabraProcessing = false;
      return;
    }

    const tpl = this.cadabraTemplate;
    let orderDetails = this.parseCadabraOrder(null);
    try {
      const resp = await this.http
        .post<any>(cadabraUrl, { name: this.companyId })
        .toPromise();
      orderDetails = this.parseCadabraOrder(resp);
    } catch {}

    const orderNumber = this.generateCadabraOrderNumber();
    const eta = this.computeCadabraEta(this.simDate);
    const orderDate = this.simDate.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const subjectTpl = tpl.subject || 'Ordered: "{ITEM}"';
    const subject = subjectTpl.replace(/\{ITEM\}/g, orderDetails.item);
    const message = tpl.body
      .replace(/\{ITEM\}/g, orderDetails.item)
      .replace(/\{QUANTITY\}/g, String(orderDetails.quantity))
      .replace(/\{UNIT_PRICE\}/g, this.formatCurrency(orderDetails.unitPrice))
      .replace(/\{ITEM_SUBTOTAL\}/g, this.formatCurrency(orderDetails.itemSubtotal))
      .replace(/\{TOTAL_PRICE\}/g, this.formatCurrency(orderDetails.total))
      .replace(/\{ORDER_NUMBER\}/g, orderNumber)
      .replace(/\{DELIVERY_ESTIMATE\}/g, eta)
      .replace(/\{ORDER_DATE\}/g, orderDate);

    const emailId = `cadabra-${Date.now()}`;
    const ledgerMemo = `${orderDetails.quantity}x ${orderDetails.item}`;
    try {
      await setDoc(doc(db, `companies/${this.companyId}/inbox/${emailId}`), {
        from: tpl.from || 'updates@cadabra.com',
        subject,
        message,
        deleted: false,
        banner: tpl.banner ?? true,
        timestamp: this.simDate.toISOString(),
        threadId: emailId,
        to: this.meAddress,
        category: 'cadabra',
        cadabra: {
          item: orderDetails.item,
          quantity: orderDetails.quantity,
          unitPrice: orderDetails.unitPrice,
          total: orderDetails.total,
          orderNumber,
          eta,
        },
        ledgerAmount: orderDetails.total,
        ledgerMemo,
        ledger: { type: 'cadabra', amount: orderDetails.total, memo: ledgerMemo },
      });
      const nextAt = this.computeNextCadabra(this.simDate);
      this.cadabraSendTime = nextAt.getTime();
      await updateDoc(companyRef, {
        cadabraNextAt: this.cadabraSendTime,
        cadabraEmailInProgress: false,
      });
    } catch {
      try {
        await updateDoc(companyRef, { cadabraEmailInProgress: false });
      } catch {}
    } finally {
      this.cadabraProcessing = false;
    }
  }

  private async checkBankEmail(): Promise<void> {
    if (!this.bankSendTime) return;
    if (this.simDate.getTime() < this.bankSendTime) return;
    if (!this.bankTemplate) return;
    if (this.bankProcessing) return;
    this.bankProcessing = true;

    let proceed = false;
    const companyRef = doc(db, `companies/${this.companyId}`);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(companyRef);
        const d = (snap && (snap.data() as any)) || {};
        const nextAt =
          typeof d.bankNextAt === 'number' ? d.bankNextAt : this.bankSendTime;
        const busy = !!d.bankEmailInProgress;
        if (!nextAt || this.simDate.getTime() < nextAt || busy) return;
        tx.update(companyRef, { bankEmailInProgress: true });
        proceed = true;
        this.bankSendTime = nextAt;
      });
    } catch {}
    if (!proceed) {
      this.bankProcessing = false;
      return;
    }

    let employees: { name: string; salary: number }[] = [];
    try {
      const empsRef = collection(db, `companies/${this.companyId}/employees`);
      const q = query(empsRef, where('hired', '==', true));
      const snap = await getDocs(q);
      employees = snap.docs
        .map((d) => d.data() as any)
        .map((e) => ({
          name: String(e.name || ''),
          salary: Number(e.salary || 0),
        }))
        .filter((e) => e.name);
    } catch {}

    if (!employees.length) {
      const nextAt = this.computeNextFriday5(this.simDate);
      this.bankSendTime = nextAt.getTime();
      const ref = doc(db, `companies/${this.companyId}`);
      await updateDoc(ref, { bankNextAt: this.bankSendTime });
      this.bankProcessing = false;
      return;
    }

    const weekly = employees.map((e) => ({
      name: e.name,
      amt: Math.ceil((e.salary / 52) * 100) / 100,
    }));
    const total = weekly.reduce((s, w) => s + w.amt, 0);
    const totalStr = `$${total.toFixed(2)}`;
    const breakdown = weekly
      .map((w) => `$${w.amt.toFixed(2)} - Payment for ${w.name}`)
      .join('\n');

    const tpl = this.bankTemplate as {
      from?: string;
      subject?: string;
      banner?: boolean;
      body: string;
    };
    const from = tpl.from || 'noreply@54.com';
    const subject = tpl.subject || 'Payroll Batch Withdrawal Processed';
    const banner = tpl.banner ?? true;
    const message = tpl.body
      .replace(/\{TOTAL_AMOUNT\}/g, totalStr)
      .replace(/\{BREAKDOWN\}/g, breakdown);
    const emailId = `bank-${Date.now()}`;
    await setDoc(doc(db, `companies/${this.companyId}/inbox/${emailId}`), {
      from,
      subject,
      message,
      deleted: false,
      banner,
      timestamp: this.simDate.toISOString(),
      threadId: emailId,
      to: this.meAddress,
      category: 'bank',
      payrollTotal: total,
      payrollLines: weekly.map((w) => ({ name: w.name, amount: w.amt })),
    });
    const nextAt = this.computeNextFriday5(this.simDate);
    this.bankSendTime = nextAt.getTime();
    const ref = companyRef;
    try {
      await updateDoc(ref, {
        bankNextAt: this.bankSendTime,
        ledgerEnabled: true,
        bankEmailInProgress: false,
      });
    } catch {
      try {
        await updateDoc(ref, { bankEmailInProgress: false });
      } catch {}
    }
    this.bankProcessing = false;
  }

  private async checkCalendarEmail(): Promise<void> {
    if (!this.calendarEmailAt) return;
    if (this.simDate.getTime() < this.calendarEmailAt) return;
    const ref = doc(db, `companies/${this.companyId}`);
    let proceed = false;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const d = (snap && (snap.data() as any)) || {};
        if (d.calendarEmailSent || d.calendarEmailInProgress) return;
        const at =
          typeof d.calendarEmailAt === 'number'
            ? d.calendarEmailAt
            : this.calendarEmailAt;
        if (!at || this.simDate.getTime() < at) return;
        tx.update(ref, { calendarEmailInProgress: true });
        proceed = true;
      });
    } catch {}
    if (!proceed) return;
    let parsed: {
      from?: string;
      subject?: string;
      banner?: boolean;
      deleted?: boolean;
      body: string;
    } = {
      body: '',
    };
    try {
      const text = await this.http
        .get('emails/vlad-calendar.md', { responseType: 'text' })
        .toPromise();
      parsed = this.parseEmailTemplate(text || '');
    } catch {
      parsed = this.parseEmailTemplate('');
    }
    const fallbackBody =
      'Hello End User,\n\nThis is Vlad from IT. I added a calendar for next week so you can shuffle meetings. Your meetings are white with colored dots for attendees; teammates show up in their own color. Try to stack meetings together to leave big empty blocks for focus time, and submit when you are done. I am very busy so nothing else happens.\n\nThank you!\nVlad\nIT Support\nstrtupify.io';
    if (!parsed.body) parsed.body = fallbackBody;
    if (!parsed.subject) parsed.subject = 'New calendar feature';
    const emailId = `calendar-${Date.now()}`;
    try {
      await setDoc(doc(db, `companies/${this.companyId}/inbox/${emailId}`), {
        from: parsed.from || 'vlad@strtupify.io',
        subject: parsed.subject || 'New calendar feature',
        message: parsed.body,
        deleted: parsed.deleted ?? false,
        banner: parsed.banner ?? false,
        timestamp: this.simDate.toISOString(),
        threadId: emailId,
        to: this.meAddress,
        category: 'calendar',
      });
      await updateDoc(ref, {
        calendarEmailSent: true,
        calendarEmailInProgress: false,
        calendarEnabled: true,
      });
      this.calendarEmailAt = null;
    } catch {
      try {
        await updateDoc(ref, { calendarEmailInProgress: false });
      } catch {}
    }
  }

  private async checkKickoffEmail(): Promise<void> {
    if (!this.kickoffSendTime) return;
    if (this.simDate.getTime() < this.kickoffSendTime) return;
    const ref = doc(db, `companies/${this.companyId}`);
    let proceed = false;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const d = (snap && (snap.data() as any)) || {};
        if (d.kickoffEmailSent || d.kickoffEmailInProgress) return;
        const at =
          typeof d.kickoffEmailAt === 'number'
            ? d.kickoffEmailAt
            : this.kickoffSendTime;
        if (!at || this.simDate.getTime() < at) return;
        tx.update(ref, { kickoffEmailInProgress: true });
        proceed = true;
      });
    } catch {}
    if (!proceed) return;
    this.http.post<any>(kickoffUrl, { name: this.companyId }).subscribe({
      next: async (email) => {
        const emailId = `kickoff-${Date.now()}`;
        try {
          await setDoc(
            doc(db, `companies/${this.companyId}/inbox/${emailId}`),
            {
              from: email.from,
              subject: email.subject,
              message: email.body,
              deleted: false,
              banner: false,
              timestamp: this.simDate.toISOString(),
              threadId: emailId,
              to: this.meAddress,
              category: 'kickoff',
            }
          );
          await updateDoc(ref, {
            kickoffEmailSent: true,
            kickoffEmailInProgress: false,
          });
        } catch {
          try {
            await updateDoc(ref, { kickoffEmailInProgress: false });
          } catch {}
        }
      },
      error: async () => {
        try {
          await updateDoc(ref, { kickoffEmailInProgress: false });
        } catch {}
      },
    });
  }

  private async checkMomEmail(): Promise<void> {
    if (!this.momSendTime) return;
    if (this.simDate.getTime() < this.momSendTime) return;
    const ref = doc(db, `companies/${this.companyId}`);
    const proceed = await runTransaction<boolean>(db, async (tx) => {
      const snap = await tx.get(ref);
      const d = (snap && (snap.data() as any)) || {};
      if (d.momEmailSent || d.momEmailInProgress) return false;
      const at =
        typeof d.momEmailAt === 'number' ? d.momEmailAt : this.momSendTime;
      if (!at || this.simDate.getTime() < at) return false;
      tx.update(ref, { momEmailInProgress: true });
      return true;
    }).catch(() => false);
    if (!proceed) return;
    this.ensureSelectedSnack();
    if (!this.selectedSnack) return;
    const snackName = this.selectedSnack.name;
    this.http
      .post<any>(momUrl, { name: this.companyId, snack: snackName })
      .subscribe({
        next: async (email) => {
          const emailId = `mom-${Date.now()}`;
          try {
            await setDoc(
              doc(db, `companies/${this.companyId}/inbox/${emailId}`),
              {
                from: email.from,
                subject: email.subject,
                message: email.body,
                deleted: false,
                banner: false,
                timestamp: this.simDate.toISOString(),
                threadId: emailId,
                to: this.meAddress,
                category: 'mom',
              }
            );
            await updateDoc(ref, {
              momEmailSent: true,
              momEmailInProgress: false,
            });
          } catch {
            try {
              await updateDoc(ref, { momEmailInProgress: false });
            } catch {}
          }
        },
        error: async () => {
          try {
            await updateDoc(ref, { momEmailInProgress: false });
          } catch {}
        },
      });
  }
}
