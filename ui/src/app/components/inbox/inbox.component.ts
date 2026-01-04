import { Component, HostListener, OnDestroy, OnInit, Input, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { InboxService, Email } from '../../services/inbox.service';
import { ReplyRouterService } from '../../services/reply-router.service';
import { EmailCounterService } from '../../services/email-counter.service';
import { Subscription } from 'rxjs';
import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  onSnapshot,
  collection,
  query,
  where,
  limit,
  runTransaction,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { EndgameService, EndgameStatus } from '../../services/endgame.service';
import { UiStateService } from '../../services/ui-state.service';
import {
  AvatarMood,
  buildAvatarUrl,
  burnoutMood,
  normalizeAvatarMood,
  normalizeOutcomeStatus,
  outcomeMood,
} from 'src/app/utils/avatar';
import { fallbackEmployeeColor, normalizeEmployeeColor } from 'src/app/utils/employee-colors';

const fbApp = getApps().length
  ? getApps()[0]
  : initializeApp(environment.firebase);
const db = getFirestore(fbApp);
const kickoffUrl = 'https://fa-strtupifyio.azurewebsites.net/api/kickoff_email';
const momUrl = 'https://fa-strtupifyio.azurewebsites.net/api/mom_email';
const cadabraUrl = 'https://fa-strtupifyio.azurewebsites.net/api/order';

type InboxEmail = Email & {
  displaySender?: string;
  displayRecipient?: string;
  senderInitials?: string;
  senderAvatarUrl?: string | null;
  isSeed?: boolean;
};

type EmployeeAvatarSource = {
  avatarName: string;
  directUrl: string | null;
  burnout: boolean;
  color: string | null;
};

type EmployeeAvatarRecord = EmployeeAvatarSource & {
  mood: AvatarMood;
  url: string | null;
};

@Component({
  selector: 'app-inbox',
  templateUrl: './inbox.component.html',
  styleUrls: ['./inbox.component.scss'],
  standalone: true,
  imports: [CommonModule, HttpClientModule, FormsModule],
})
export class InboxComponent implements OnInit, OnDestroy {
  @Input() companyId = '';

  inbox: InboxEmail[] = [];
  private allEmails: InboxEmail[] = [];
  selectedEmail: InboxEmail | null = null;
  @ViewChild('replyTextarea') replyTextarea?: ElementRef<HTMLTextAreaElement>;

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
  private readonly historyDivider = '----- Previous messages -----';
  private readonly historyRegex =
    /-----\s*(previous (?:messages?|emails?|repl(?:y|ies))|original (?:message|email))\s*-----/i;
  get replySubject(): string {
    const base = this.selectedEmail?.subject || '';
    return base.startsWith('Re:') ? base : `Re: ${base}`;
  }

  get threadMessages(): InboxEmail[] {
    return this.collectThreadMessages(this.selectedEmail);
  }

  get selectedEmailBody(): string {
    if (!this.selectedEmail) return '';
    return this.mergeBodyWithHistory(
      this.selectedEmail.body,
      this.selectedEmail
    );
  }

  renderEmailBody(text: string | undefined | null): string {
    if (!text) return '';
    return this.simpleMarkdown(text);
  }

  private collectThreadMessages(email: InboxEmail | null): InboxEmail[] {
    if (!email) return [];
    const tid = (email as any).threadId || email.id;
    const selectedTs = new Date(email.timestamp || '').getTime();
    const isValidTs = Number.isFinite(selectedTs);
    const list = this.allEmails.filter((e) => {
      const sameThread = ((e as any).threadId || e.id) === tid;
      if (!sameThread) return false;
      if (e.id === email.id) return false;
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

  private mergeBodyWithHistory(
    base: string | undefined | null,
    email: InboxEmail | null,
    includeCurrent: boolean = false
  ): string {
    const baseText = typeof base === 'string' ? base : '';
    const normalizedBase = this.normalizeHistoryDivider(baseText);
    if (this.hasHistoryBlock(normalizedBase)) return normalizedBase;
    const cleanedBase = this.stripQuotedHistory(normalizedBase);
    const history = this.formatThreadHistory(email, includeCurrent);
    if (!history) return cleanedBase;
    const needsGap = cleanedBase.trim().length > 0;
    return needsGap ? `${cleanedBase}\n\n${history}` : history;
  }

  private formatThreadHistory(
    email: InboxEmail | null,
    includeCurrent: boolean = false
  ): string {
    const history = this.collectThreadMessages(email);
    const sequence = includeCurrent && email ? [email, ...history] : history;
    if (!sequence.length) return '';
    const lines: string[] = [this.historyDivider];
    sequence.forEach((m) => {
      const ts = this.formatThreadTimestamp(m.timestamp);
      const sender = m.sender || m.displaySender || 'Unknown sender';
      const header = ts ? `From: ${sender} - ${ts}` : `From: ${sender}`;
      lines.push(header);
      const bodyText = this.stripQuotedHistory(m.body);
      if (bodyText.trim()) lines.push(bodyText.trim());
      lines.push('');
    });
    return lines.join('\n').trim();
  }

  private normalizeHistoryDivider(text: string): string {
    if (!text) return '';
    return text
      .replace(
        /-----\s*(original (?:message|email)|previous (?:emails?|repl(?:y|ies)))\s*-----/gi,
        this.historyDivider
      )
      .replace(
        /(^|\n)\s*-*\s*previous\s+repl(?:y|ies)\s*-*\s*(\n|$)/gi,
        (_m, prefix, suffix) => `${prefix}${this.historyDivider}${suffix}`
      );
  }

  private hasHistoryBlock(text: string): boolean {
    if (!text) return false;
    return (
      this.historyRegex.test(text) ||
      /(^|\n)\s*-*\s*previous\s+repl(?:y|ies)\s*-*\s*($|\n)/i.test(text)
    );
  }

  private stripQuotedHistory(text: string | undefined | null): string {
    if (!text) return '';
    const normalized = this.normalizeHistoryDivider(text);
    const markers = [
      normalized.search(this.historyRegex),
      normalized.search(/^[-\s]*original (message|email)\s*:/im),
      normalized.search(/^[-\s]*previous (message|messages|email|emails|reply|replies)\s*:/im),
      normalized.search(/^\s*-*\s*previous\s+repl(?:y|ies)\s*-*\s*$/im),
    ].filter((idx) => idx >= 0);
    const cutIdx = markers.length ? Math.min(...markers) : -1;
    const base = cutIdx >= 0 ? normalized.slice(0, cutIdx) : normalized;
    return base.trimEnd();
  }

  private formatThreadTimestamp(raw: string | undefined): string {
    if (!raw) return '';
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString();
  }

  private simpleMarkdown(src: string): string {
    const escape = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const formatInline = (s: string) => {
      let out = escape(s);
      out = out.replace(/&lt;(\/?u)&gt;/g, '<$1>');

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

  private startEmployeeAvatarWatch(): void {
    if (!this.companyId) return;
    if (this.employeeAvatarUnsub) {
      try {
        this.employeeAvatarUnsub();
      } catch {}
      this.employeeAvatarUnsub = null;
    }
    const ref = query(
      collection(db, `companies/${this.companyId}/employees`),
      where('hired', '==', true)
    );
    this.employeeAvatarUnsub = onSnapshot(ref, (snap) => {
      const sources = new Map<string, EmployeeAvatarSource>();
      snap.docs.forEach((d) => {
        const data = (d.data() as any) || {};
        const name = String(data.name || '').trim();
        if (!name) return;
        const directUrl = String(data.avatarUrl || data.avatar_url || '').trim();
        const avatarName = String(
          data.avatar || data.photo || data.photoUrl || data.image || ''
        ).trim();
        const stress = Math.max(0, Math.min(100, Number(data.stress || 0)));
        const status = String(data.status || '');
        const burnout = burnoutMood(stress, status) === 'sad';
        const color = normalizeEmployeeColor(data.calendarColor || data.color) || fallbackEmployeeColor(d.id);
        sources.set(this.normalizeName(name), {
          avatarName,
          directUrl: directUrl || null,
          burnout,
          color,
        });
      });
      this.employeeAvatarSources = sources;
      this.rebuildEmployeeAvatars();
    });
  }

  private startWorkitemWatch(): void {
    if (!this.companyId) return;
    if (this.workitemsUnsub) {
      try {
        this.workitemsUnsub();
      } catch {}
      this.workitemsUnsub = null;
    }
    const ref = collection(db, `companies/${this.companyId}/workitems`);
    this.workitemsUnsub = onSnapshot(ref, (snap) => {
      let total = 0;
      let done = 0;
      snap.docs.forEach((d) => {
        const data = (d.data() as any) || {};
        const status = String(data.status || '').toLowerCase();
        total++;
        if (status === 'done') done++;
      });
      this.workitemProgress = { done, total };
      void this.maybeScheduleVladWorkEmail();
      void this.maybeScheduleAIDeleteEmail();
      void this.maybeScheduleVladNightEmail();
    });
  }

  private rebuildEmployeeAvatars(): void {
    const map = new Map<string, EmployeeAvatarRecord>();
    this.employeeAvatarSources.forEach((src, key) => {
      const mood: AvatarMood = src.burnout ? 'sad' : this.endgameOutcomeMood || 'neutral';
      const record: EmployeeAvatarRecord = { ...src, mood, url: null };
      const url = this.buildAvatarUrlForRecord(key, record, mood);
      map.set(key, { ...record, url });
    });
    this.employeeAvatars = map;
    this.refreshEmailAvatars();
  }

  private avatarCacheKey(src: EmployeeAvatarSource, mood: AvatarMood, color?: string | null): string {
    return `${src.avatarName || ''}|${mood}|${color || ''}`;
  }

  private buildAvatarUrlForRecord(
    nameKey: string,
    record: EmployeeAvatarRecord,
    moodOverride?: AvatarMood | null
  ): string | null {
    const baseMood =
      this.normalizeMoodValue(moodOverride || record.mood) || this.endgameOutcomeMood || 'neutral';
    const mood: AvatarMood = record.burnout ? 'sad' : baseMood;
    const safeMood = normalizeAvatarMood(record.avatarName || '', mood);
    const color = normalizeEmployeeColor(record.color);
    const baseUrl = record.avatarName ? buildAvatarUrl(record.avatarName, safeMood) : '';
    const cacheKey = color && baseUrl ? this.avatarCacheKey(record, safeMood, color) : null;
    const cached = cacheKey ? this.avatarColorCache.get(cacheKey) : undefined;
    if (!cached && cacheKey && baseUrl && color) {
      void this.fetchAndColorAvatar(cacheKey, baseUrl, color, nameKey, safeMood);
    }
    const preferMood = record.burnout || safeMood !== 'neutral';
    const moodUrl = cached || baseUrl || null;
    const fallback = record.directUrl;
    return preferMood ? moodUrl || fallback || record.url : fallback || moodUrl || record.url;
  }

  private async fetchAndColorAvatar(
    cacheKey: string,
    baseUrl: string,
    color: string,
    nameKey: string,
    mood: AvatarMood
  ): Promise<void> {
    if (this.pendingAvatarFetches.has(cacheKey)) return this.pendingAvatarFetches.get(cacheKey)!;
    const task = (async () => {
      try {
        const resp = await fetch(baseUrl);
        if (!resp.ok) throw new Error(`avatar_status_${resp.status}`);
        const svg = await resp.text();
        const updated = svg.replace(/#262E33/gi, color);
        const uri = this.svgToDataUri(updated);
        this.avatarColorCache.set(cacheKey, uri);
        this.applyColoredAvatar(nameKey, mood, cacheKey, uri);
      } catch (err) {
        console.error('Failed to recolor avatar', err);
      } finally {
        this.pendingAvatarFetches.delete(cacheKey);
      }
    })();
    this.pendingAvatarFetches.set(cacheKey, task);
    return task;
  }

  private applyColoredAvatar(nameKey: string, mood: AvatarMood, cacheKey: string, url: string): void {
    const record = this.employeeAvatars.get(nameKey);
    if (!record) return;
    const color = normalizeEmployeeColor(record.color);
    const expectedKey = color ? this.avatarCacheKey(record, mood, color) : null;
    if (expectedKey !== cacheKey) return;
    const preferMood = record.burnout || mood !== 'neutral';
    const nextUrl = preferMood ? url || record.directUrl || record.url : record.directUrl || url || record.url;
    this.employeeAvatars.set(nameKey, { ...record, url: nextUrl, mood });
    this.refreshEmailAvatars();
  }

  private svgToDataUri(svg: string): string {
    const encoded = btoa(
      encodeURIComponent(svg).replace(/%([0-9A-F]{2})/g, (_match, p1) =>
        String.fromCharCode(parseInt(p1, 16))
      )
    );
    return `data:image/svg+xml;base64,${encoded}`;
  }

  private extractOutcomeMood(data: any): AvatarMood | null {
    const rawMood = this.normalizeMoodValue(data?.endgameOutcomeMood || data?.avatarMood);
    if (rawMood) return rawMood;
    const normalizedOutcome = normalizeOutcomeStatus(
      data?.endgameOutcome || data?.outcomeStatus || '',
      typeof data?.estimatedRevenue === 'number' ? data.estimatedRevenue : undefined
    );
    const mood = outcomeMood(normalizedOutcome);
    return mood === 'neutral' ? null : mood;
  }

  private normalizeMoodValue(value: any): AvatarMood | null {
    if (typeof value !== 'string') return null;
    const raw = value.trim().toLowerCase();
    if (raw === 'happy' || raw === 'sad' || raw === 'angry' || raw === 'neutral') return raw as AvatarMood;
    return null;
  }

  private refreshEmailAvatars(): void {
    if (!this.allEmails.length) return;
    this.allEmails = this.allEmails.map((e) => this.decorateEmail(e));
    this.updateInboxView(this.allEmails);
  }

  private decorateEmail(email: Email): InboxEmail {
    const displaySender = this.resolveSenderName(email);
    const displayRecipient = this.resolveRecipientName(email);
    const senderAvatarUrl = this.resolveSenderAvatar(email, displaySender);
    const senderInitials = this.initialsFor(displaySender || email.sender);
    return {
      ...email,
      displaySender,
      displayRecipient,
      senderAvatarUrl,
      senderInitials,
    };
  }

  private resolveSenderName(email: Email): string {
    const candidates = [
      (email as any).senderName,
      (email as any).sender_name,
      this.extractNameFromEmail(email.sender),
    ];
    for (const name of candidates) {
      const clean = String(name || '').trim();
      if (clean) return clean;
    }
    return email.sender || 'Unknown sender';
  }

  private resolveRecipientName(email: Email): string {
    const explicit =
      (email as any).recipientName ||
      (email as any).recipient_name ||
      (email as any).toName ||
      (email as any).to_name;
    if (explicit && String(explicit).trim()) return String(explicit).trim();
    const toField = (email as any).to || (email as any).recipient || '';
    const recipients = this.parseRecipients(String(toField || ''));
    const primary = recipients[0] || String(toField || '');
    const candidates = [
      this.extractNameFromEmail(primary),
      this.extractNameFromEmail(String(toField || '')),
    ];
    for (const name of candidates) {
      const clean = String(name || '').trim();
      if (clean) return clean;
    }
    const fallback = String(primary || '').trim();
    return fallback || 'Unknown recipient';
  }

  private resolveSenderAvatar(email: Email, displayName: string): string | null {
    const special = this.resolveSpecialAvatar(email);
    if (special) return special;
    const moodOverride = this.normalizeMoodValue((email as any).avatarMood);
    const names: string[] = [];
    if ((email as any).senderName) names.push(String((email as any).senderName));
    if (displayName) names.push(displayName);
    const parsed = this.extractNameFromEmail(email.sender);
    if (parsed) names.push(parsed);
    for (const name of names) {
      const burnoutMatch = this.avatarForName(name);
      if (burnoutMatch) {
        const isBurnout = this.employeeAvatars.get(this.normalizeName(name))?.burnout;
        if (isBurnout) return burnoutMatch;
      }
    }
    const direct = (email as any).avatarUrl || (email as any).avatar_url;
    if (typeof direct === 'string' && direct.trim()) {
      if (names.length) {
        const match = this.avatarForName(names[0], moodOverride);
        const record = this.employeeAvatars.get(this.normalizeName(names[0]));
        const isBurnout = match && record?.burnout;
        const wantsMood = moodOverride && moodOverride !== 'neutral';
        if (match && (isBurnout || wantsMood)) return match;
      }
      return direct;
    }
    const avatarName = (email as any).avatarName;
    if (typeof avatarName === 'string' && avatarName.trim()) {
      const built = buildAvatarUrl(avatarName.trim(), moodOverride || this.endgameOutcomeMood || 'neutral');
      if (built) return built;
    }
    for (const name of names) {
      const found = this.avatarForName(name, moodOverride);
      if (found) return found;
    }
    const existing = (email as any).senderAvatarUrl;
    if (typeof existing === 'string' && existing.trim()) return existing;
    return null;
  }

  private resolveSpecialAvatar(email: Email): string | null {
    const senderField =
      (email as any).sender || (email as any).from || email.sender || '';
    const category = (email as any).category || '';
    const normalized = this.normalizeAddress(senderField);
    if (!normalized && !category) return null;
    if (normalized === 'mom@altavista.net') return 'assets/mom.jpg';
    if (normalized === 'mailer-daemon@strtupify.io' || category === 'mailer-daemon') {
      return 'assets/rocket-launch.svg';
    }
    if (normalized === 'noreply@supereats.com' || category === 'supereats') {
      return 'assets/supereats-avatar.png';
    }
    if (
      normalized === 'noreply@54.com' ||
      normalized === 'noreply@54bank.com' ||
      category === 'bank'
    ) {
      return 'assets/fifthfourth-avatar.png';
    }
    if (
      normalized === 'jeff@cadabra.com' &&
      category === 'cadabra'
    ) {
      return 'assets/jeff.svg';
    }
    if (
      normalized === 'order-update@cadabra.com' ||
      normalized === 'updates@cadabra.com' ||
      category === 'cadabra'
    ) {
      return 'assets/cadabra-avatar.png';
    }
    if (normalized === 'vlad@strtupify.io') {
      const ts = this.emailTimestampMs(email as any as InboxEmail);
      return this.vladAvatarForTimestamp(ts);
    }
    return null;
  }

  private normalizeAddress(raw: string): string {
    const text = String(raw || '').trim().toLowerCase();
    if (!text) return '';
    const match = text.match(/<([^>]+)>/);
    const addr = match ? match[1] : text;
    return addr.trim();
  }

  private isSupereatsAddress(address: string): boolean {
    const normalized = this.normalizeAddress(address);
    if (!normalized) return false;
    return normalized === 'noreply@supereats.com' || normalized.endsWith('@supereats.com');
  }

  private isCadabraAddress(address: string): boolean {
    const normalized = this.normalizeAddress(address);
    if (!normalized) return false;
    return (
      normalized === 'order-update@cadabra.com' ||
      normalized === 'updates@cadabra.com' ||
      normalized === 'jeff@cadabra.com' ||
      normalized.endsWith('@cadabra.com')
    );
  }

  private isBankAddress(address: string): boolean {
    const normalized = this.normalizeAddress(address);
    if (!normalized) return false;
    return (
      normalized === 'noreply@54.com' ||
      normalized === 'noreply@54bank.com' ||
      normalized.endsWith('@54.com') ||
      normalized.endsWith('@54bank.com') ||
      normalized.includes('fifthfourth')
    );
  }

  private vladAvatarForTimestamp(ts: number | null): string {
    if (
      this.vladOpenToWorkAt !== null &&
      ts !== null &&
      ts >= this.vladOpenToWorkAt
    ) {
      return this.vladOpenToWorkAvatar;
    }
    if (this.vladBlitzedAt !== null) {
      const blitzStart = this.startOfDay(new Date(this.vladBlitzedAt)).getTime();
      const blitzEnd = blitzStart + 24 * 60 * 60 * 1000;
      if (ts !== null && ts >= blitzStart && ts < blitzEnd) {
        return this.vladBlitzedAvatar;
      }
    }
    return this.vladDefaultAvatar;
  }

  private extractNameFromEmail(raw: string): string {
    if (!raw) return '';
    const angle = raw.match(/^(.*)<(.+)>$/);
    if (angle) {
      const label = angle[1].trim();
      if (label) return label;
      raw = angle[2];
    }
    const local = raw.split('@')[0] || '';
    const cleaned = local.replace(/[\.\_\-]+/g, ' ').trim();
    if (!cleaned) return '';
    return cleaned
      .split(/\s+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
      .trim();
  }

  private avatarForName(name: string, moodOverride?: AvatarMood | null): string | null {
    const key = this.normalizeName(name);
    if (!key) return null;
    const record = this.employeeAvatars.get(key);
    if (!record) return null;
    return this.buildAvatarUrlForRecord(key, record, moodOverride);
  }

  private normalizeName(name: string): string {
    return (name || '').trim().toLowerCase();
  }

  private initialsFor(name: string): string {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const first = parts[0].charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    const combo = `${first}${last}`.trim();
    return (combo || first).toUpperCase();
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
  deleteInFlight = false;
  private suppressedIds = new Map<string, number>();
  private readonly suppressMs = 2000;
  private readonly vladCompletionThreshold = 0.6;
  private readonly vladDefaultAvatar = 'assets/vlad.svg';
  private readonly vladBlitzedAvatar = 'assets/vladblitzed.svg';
  private readonly vladOpenToWorkAvatar = 'assets/vladopentowork.svg';
  private readonly vladWorkDelayMs = 5000;
  private readonly aiDeleteThreshold = 0.75;
  private readonly aiDeleteStartHour = 8;
  private readonly aiDeleteEndHour = 17;
  private pendingSelectionId: string | null = null;
  private employeeAvatarSources = new Map<string, EmployeeAvatarSource>();
  private employeeAvatars = new Map<string, EmployeeAvatarRecord>();
  private avatarColorCache = new Map<string, string>();
  private pendingAvatarFetches = new Map<string, Promise<void>>();
  private employeeAvatarUnsub: (() => void) | null = null;
  private endgameOutcomeMood: AvatarMood | null = null;
  private readonly markingRead = new Set<string>();

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
  private superEatsDisabled = false;

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
  cadabraProcessing = false;

  private vladWorkSendTime: number | null = null;
  private vladWorkTemplate: {
    from?: string;
    subject?: string;
    banner?: boolean;
    deleted?: boolean;
    body: string;
  } | null = null;
  private vladNightSendTime: number | null = null;
  private vladNightTemplate: {
    from?: string;
    subject?: string;
    banner?: boolean;
    deleted?: boolean;
    body: string;
  } | null = null;
  private aiDeleteSendTime: number | null = null;
  private aiDeleteTemplate: {
    from?: string;
    subject?: string;
    banner?: boolean;
    deleted?: boolean;
    body: string;
  } | null = null;
  private aiDeleteEmailSent = false;
  private aiDeleteProcessing = false;
  private vladWorkEmailSent = false;
  private vladWorkProcessing = false;
  private vladNightEmailSent = false;
  private vladNightProcessing = false;
  private vladBlitzedAt: number | null = null;
  private vladOpenToWorkAt: number | null = null;
  private workitemsUnsub: (() => void) | null = null;
  private workitemProgress = { done: 0, total: 0 };
  private seedEmails = new Map<string, InboxEmail>();

  private kickoffSendTime: number | null = null;
  private momSendTime: number | null = null;
  private calendarEmailAt: number | null = null;

  showDeleted = false;
  meAddress = '';
  showSent = false;
  searchQuery = '';

  get aiDeleteEnabled(): boolean {
    return this.aiDeleteEmailSent;
  }

  get showInboxControls(): boolean {
    return this.endgameStatus === 'idle';
  }

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
    private ui: UiStateService,
    private emailCounter: EmailCounterService
  ) {}

  async ngOnInit(): Promise<void> {
    if (!this.companyId) return;
    void this.inboxService.ensureWelcomeEmail(this.companyId).catch(() => {});
    this.primeVladWelcomeEmail();
    this.subscribeToInbox();
    this.startEmployeeAvatarWatch();

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
    this.startWorkitemWatch();
    {
      const ref = doc(db, `companies/${this.companyId}`);
      const unsub = onSnapshot(ref, (snap) => {
        const d = (snap && (snap.data() as any)) || {};
        const nextMood = this.extractOutcomeMood(d);
        if (nextMood !== this.endgameOutcomeMood) {
          this.endgameOutcomeMood = nextMood;
          this.rebuildEmployeeAvatars();
        }
        if (typeof d.simTime === 'number') {
          this.simDate = new Date(d.simTime);
          this.updateDisplay();
          this.enqueueTick();
        }
        this.superEatsDisabled = !!d.superEatsCancelled;
        if (this.superEatsDisabled) this.superEatsSendTime = null;
        else if (d.superEatsNextAt !== undefined)
          this.superEatsSendTime = d.superEatsNextAt;
        if (d.calendarEmailSent) this.calendarEmailAt = null;
        else if (typeof d.calendarEmailAt === 'number')
          this.calendarEmailAt = d.calendarEmailAt;
        this.aiDeleteEmailSent = !!d.aiDeleteEmailSent;
        if (this.aiDeleteEmailSent) this.aiDeleteSendTime = null;
        else if (typeof d.aiDeleteEmailAt === 'number')
          this.aiDeleteSendTime = d.aiDeleteEmailAt;
        else this.aiDeleteSendTime = null;
        this.vladWorkEmailSent = !!d.vladWorkEmailSent;
        if (this.vladWorkEmailSent) this.vladWorkSendTime = null;
        else if (typeof d.vladWorkEmailAt === 'number')
          this.vladWorkSendTime = d.vladWorkEmailAt;
        else this.vladWorkSendTime = null;
        this.vladNightEmailSent = !!d.vladNightEmailSent;
        if (this.vladNightEmailSent) this.vladNightSendTime = null;
        else if (typeof d.vladNightEmailAt === 'number')
          this.vladNightSendTime = d.vladNightEmailAt;
        else this.vladNightSendTime = null;
        this.vladBlitzedAt =
          typeof d.vladBlitzedAt === 'number' ? d.vladBlitzedAt : null;
        this.vladOpenToWorkAt =
          typeof d.vladOpenToWorkAt === 'number' ? d.vladOpenToWorkAt : null;
        if (this.vladOpenToWorkAt === null && this.vladBlitzedAt !== null) {
          this.vladOpenToWorkAt =
            this.startOfDay(new Date(this.vladBlitzedAt)).getTime() +
            24 * 60 * 60 * 1000;
        }
      });
      (this as any).__unsubInboxSim = unsub;
    }
    this.loadSnacks();
    this.loadSuperEatsTemplate();
    this.loadVladNightTemplate();
    this.loadVladWorkTemplate();
    this.loadAiDeleteTemplate();
    this.loadBankTemplate();
    this.loadCadabraTemplate();
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
    if (this.workitemsUnsub) {
      try {
        this.workitemsUnsub();
      } catch {}
      this.workitemsUnsub = null;
    }
    if (this.employeeAvatarUnsub) {
      try {
        this.employeeAvatarUnsub();
      } catch {}
      this.employeeAvatarUnsub = null;
    }
    this.suppressedIds.clear();
    for (const t of this.pendingReplyTimers) {
      try {
        clearTimeout(t);
      } catch {}
    }
  }

  selectEmail(email: InboxEmail): void {
    this.selectedEmail = email;
    this.showReplyBox = false;
    this.showComposeBox = false;
    this.composeError = '';
    this.replyText = '';
    this.markEmailAsRead(email);
  }

  private markEmailAsRead(email: InboxEmail | null): void {
    if (!email || !this.companyId) return;
    if (email.isSeed) return;
    if (email.read) return;
    const alreadyMarking = this.markingRead.has(email.id);
    const readAt = new Date().toISOString();
    this.applyLocalReadState(email.id, readAt);
    if (alreadyMarking) return;
    this.markingRead.add(email.id);
    this.inboxService
      .markEmailRead(this.companyId, email.id, readAt)
      .catch(() => {})
      .finally(() => this.markingRead.delete(email.id));
  }

  private applyLocalReadState(emailId: string, readAt: string): void {
    const apply = (item: InboxEmail): InboxEmail =>
      item.id === emailId ? { ...item, read: true, readAt } : item;
    this.inbox = this.inbox.map(apply);
    this.allEmails = this.allEmails.map(apply);
    if (this.selectedEmail && this.selectedEmail.id === emailId) {
      this.selectedEmail = apply(this.selectedEmail);
    }
  }

  private shouldIgnoreHotkeyTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    return (
      el.isContentEditable ||
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      tag === 'button'
    );
  }

  @HostListener('window:keydown', ['$event'])
  handleGlobalHotkeys(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.altKey) return;
    if (event.repeat) return;
    if (!this.showInboxControls) return;
    if (this.shouldIgnoreHotkeyTarget(event.target)) return;

    const key = (event.key || '').toLowerCase();
    if (key === 'n') {
      event.preventDefault();
      event.stopPropagation();
      this.openCompose();
    } else if (key === 'r') {
      if (!this.selectedEmail) return;
      event.preventDefault();
      event.stopPropagation();
      this.openReply();
    } else if (key === 'd') {
      if (!this.selectedEmail || this.deleteInFlight) return;
      event.preventDefault();
      event.stopPropagation();
      this.toggleDelete();
    }
  }

  deleteSelected(): void {
    if (!this.selectedEmail || this.deleteInFlight) return;
    this.deleteInFlight = true;
    const currentId = this.selectedEmail.id;
    this.pendingSelectionId = null;
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

    this.pendingSelectionId = null;
    updateMethod
      .call(this.inboxService, this.companyId, this.selectedEmail.id)
      .then(() => {
        const currentId = this.selectedEmail ? this.selectedEmail.id : null;
        if (newDeletedState && currentId) {
          this.suppressedIds.set(currentId, Date.now() + this.suppressMs);
        }
      })
      .finally(() => {
        this.deleteInFlight = false;
      });
  }

  onSearchChange(): void {
    this.updateInboxView(this.allEmails, {
      preferredId: this.selectedEmail?.id ?? null,
    });
  }

  private sortEmails(emails: InboxEmail[]): InboxEmail[] {
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
      this.superEatsDisabled = !!data.superEatsCancelled;
      if (this.superEatsDisabled) {
        this.superEatsSendTime = null;
      } else if (data.superEatsNextAt !== undefined) {
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

      if (data.vladWorkEmailSent) {
        this.vladWorkEmailSent = true;
        this.vladWorkSendTime = null;
      } else {
        this.vladWorkEmailSent = false;
        this.vladWorkSendTime =
          typeof data.vladWorkEmailAt === 'number'
            ? data.vladWorkEmailAt
            : null;
      }

      if (data.vladNightEmailSent) {
        this.vladNightEmailSent = true;
        this.vladNightSendTime = null;
      } else {
        this.vladNightEmailSent = false;
        this.vladNightSendTime =
          typeof data.vladNightEmailAt === 'number'
            ? data.vladNightEmailAt
            : null;
      }
      this.vladBlitzedAt =
        typeof data.vladBlitzedAt === 'number' ? data.vladBlitzedAt : null;
      this.vladOpenToWorkAt =
        typeof data.vladOpenToWorkAt === 'number'
          ? data.vladOpenToWorkAt
          : null;
      if (this.vladOpenToWorkAt === null && this.vladBlitzedAt !== null) {
        this.vladOpenToWorkAt =
          this.startOfDay(new Date(this.vladBlitzedAt)).getTime() +
          24 * 60 * 60 * 1000;
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
      if (data.vladWorkEmailInProgress) {
        try {
          await updateDoc(ref, { vladWorkEmailInProgress: false });
        } catch {}
      }
      if (data.vladNightEmailInProgress) {
        try {
          await updateDoc(ref, { vladNightEmailInProgress: false });
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
        vladWorkEmailAt: null,
        vladWorkEmailSent: false,
        vladWorkEmailInProgress: false,
        vladNightEmailAt: null,
        vladNightEmailSent: false,
        vladNightEmailInProgress: false,
        vladBlitzedAt: null,
        vladOpenToWorkAt: null,
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

  private async maybeScheduleVladWorkEmail(): Promise<void> {
    if (!this.companyId) return;
    if (this.vladWorkEmailSent) return;
    if (this.vladWorkSendTime) return;
    const { total } = this.workitemProgress;
    if (total <= 0) return;

    const target = this.simDate.getTime() + this.vladWorkDelayMs;
    const ref = doc(db, `companies/${this.companyId}`);
    try {
      const scheduled = await runTransaction<number | null>(db, async (tx) => {
        const snap = await tx.get(ref);
        const d = (snap && (snap.data() as any)) || {};
        if (d.vladWorkEmailSent || d.vladWorkEmailInProgress) {
          const existing =
            typeof d.vladWorkEmailAt === 'number' ? d.vladWorkEmailAt : null;
          return existing;
        }
        const existing =
          typeof d.vladWorkEmailAt === 'number' ? d.vladWorkEmailAt : null;
        if (existing) return existing;
        tx.set(
          ref,
          {
            vladWorkEmailAt: target,
            vladWorkEmailSent: false,
            vladWorkEmailInProgress: false,
          },
          { merge: true }
        );
        return target;
      });
      if (scheduled) this.vladWorkSendTime = scheduled;
    } catch {}
  }

  private async maybeScheduleAIDeleteEmail(): Promise<void> {
    if (!this.companyId) return;
    if (this.aiDeleteEmailSent) return;
    if (this.aiDeleteSendTime) return;
    const { done, total } = this.workitemProgress;
    if (total <= 0) return;
    const pct = done / total;
    if (pct < this.aiDeleteThreshold) return;

    const target = this.computeNextWorkWindow(this.simDate).getTime();
    const ref = doc(db, `companies/${this.companyId}`);
    try {
      const scheduled = await runTransaction<number | null>(db, async (tx) => {
        const snap = await tx.get(ref);
        const d = (snap && (snap.data() as any)) || {};
        if (d.aiDeleteEmailSent || d.aiDeleteEmailInProgress) {
          const existing =
            typeof d.aiDeleteEmailAt === 'number' ? d.aiDeleteEmailAt : null;
          return existing;
        }
        const existing =
          typeof d.aiDeleteEmailAt === 'number' ? d.aiDeleteEmailAt : null;
        if (existing) return existing;
        tx.set(
          ref,
          {
            aiDeleteEmailAt: target,
            aiDeleteEmailSent: false,
            aiDeleteEmailInProgress: false,
          },
          { merge: true }
        );
        return target;
      });
      if (scheduled) this.aiDeleteSendTime = scheduled;
    } catch {}
  }

  private async maybeScheduleVladNightEmail(): Promise<void> {
    if (!this.companyId) return;
    if (this.vladNightEmailSent) return;
    if (this.vladNightSendTime) return;
    const { done, total } = this.workitemProgress;
    if (total <= 0) return;
    const pct = done / total;
    if (pct < this.vladCompletionThreshold) return;

    const target = this.computeNextEarlyMorning(this.simDate).getTime();
    const ref = doc(db, `companies/${this.companyId}`);
    try {
      const scheduled = await runTransaction<number | null>(db, async (tx) => {
        const snap = await tx.get(ref);
        const d = (snap && (snap.data() as any)) || {};
        if (d.vladNightEmailSent || d.vladNightEmailInProgress) {
          const existing =
            typeof d.vladNightEmailAt === 'number' ? d.vladNightEmailAt : null;
          return existing;
        }
        const existing =
          typeof d.vladNightEmailAt === 'number' ? d.vladNightEmailAt : null;
        if (existing) return existing;
        tx.set(
          ref,
          {
            vladNightEmailAt: target,
            vladNightEmailSent: false,
            vladNightEmailInProgress: false,
          },
          { merge: true }
        );
        return target;
      });
      if (scheduled) this.vladNightSendTime = scheduled;
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
      void this.checkVladWorkEmail();
      void this.checkAIDeleteEmail();
      this.checkBankEmail();
      void this.checkVladNightEmail();
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
      await this.checkVladWorkEmail();
      await this.checkAIDeleteEmail();
      await this.checkVladNightEmail();
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
    if (this.superEatsDisabled) return;
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
      await this.saveInboxEmail(emailId, {
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

  private computeNextEarlyMorning(now: Date): Date {
    const base = new Date(now.getTime());
    base.setSeconds(0, 0);
    const todayStart = this.startOfDay(base);
    const windowCutoff = new Date(todayStart.getTime());
    windowCutoff.setHours(3, 0, 0, 0);
    let windowStart = new Date(todayStart.getTime());
    if (base >= windowCutoff) {
      windowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    } else if (base > windowStart) {
      const nextMinute = new Date(base.getTime() + 60_000);
      windowStart =
        nextMinute >= windowCutoff
          ? new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)
          : nextMinute;
    }
    let windowEnd = new Date(windowStart.getTime());
    windowEnd.setHours(3, 0, 0, 0);
    if (windowEnd <= windowStart) {
      windowEnd = new Date(windowStart.getTime() + 3 * 60 * 60 * 1000);
    }
    const startMs = windowStart.getTime();
    const endMs = Math.max(startMs, windowEnd.getTime() - 60_000);
    const spanMinutes = Math.max(
      0,
      Math.floor((endMs - startMs) / 60_000)
    );
    const offsetMinutes = spanMinutes > 0 ? this.randomInt(0, spanMinutes) : 0;
    const target = new Date(startMs);
    target.setMinutes(target.getMinutes() + offsetMinutes, 0, 0);
    return target;
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

  private loadVladNightTemplate(): void {
    this.http.get('emails/vlad-night.md', { responseType: 'text' }).subscribe({
      next: (text) => {
        this.vladNightTemplate = this.parseEmailTemplate(text || '');
      },
      error: () => {
        this.vladNightTemplate = this.parseEmailTemplate('');
      },
    });
  }

  private loadVladWorkTemplate(): void {
    this.http.get('emails/vlad-work.md', { responseType: 'text' }).subscribe({
      next: (text) => {
        this.vladWorkTemplate = this.parseEmailTemplate(text || '');
      },
      error: () => {
        this.vladWorkTemplate = null;
      },
    });
  }

  private primeVladWelcomeEmail(): void {
    if (this.seedEmails.has('vlad-welcome')) return;
    const to =
      this.meAddress ||
      (this.companyId ? `me@${this.companyId}.com` : 'me@example.com');
    const timestamp = (this.simDate || new Date()).toISOString();
    this.http
      .get('emails/vlad-welcome.md', { responseType: 'text' })
      .subscribe({
        next: (text) => {
          const parsed = this.parseMarkdownEmail(text || '');
          const body = parsed.body || '';
          const seed = this.decorateEmail({
            id: 'vlad-welcome',
            sender: parsed.from || 'vlad@strtupify.io',
            subject: parsed.subject || 'How to email',
            body,
            preview: `${body.substring(0, 60)}...`,
            deleted: parsed.deleted ?? false,
            banner: parsed.banner ?? false,
            timestamp,
            threadId: 'vlad-welcome',
            to,
            category: 'vlad',
            avatarUrl: 'assets/vlad.svg',
          } as Email);
          seed.isSeed = true;
          this.seedEmails.set(seed.id, seed);
          this.updateInboxView(this.allEmails, { preferredId: seed.id });
        },
        error: () => {},
      });
  }

  private loadAiDeleteTemplate(): void {
    this.http.get('emails/vlad-ai-delete.md', { responseType: 'text' }).subscribe({
      next: (text) => {
        this.aiDeleteTemplate = this.parseMarkdownEmail(text || '');
      },
      error: () => {
        this.aiDeleteTemplate = this.parseMarkdownEmail('');
      },
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
    setTimeout(() => this.replyTextarea?.nativeElement?.focus(), 0);
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
    const toRaw = (this.composeTo || '').trim();
    const subject = (this.composeSubject || '').trim();
    const message = (this.composeBody || '').trim();
    this.composeError = '';
    if (!toRaw) {
      this.composeError = 'Recipient is required.';
      return;
    }
    const recipients = this.parseRecipients(toRaw);
    const isMultiRecipient = recipients.length > 1;
    const to = recipients[0] || toRaw;
    if (!isMultiRecipient && !this.isValidEmailAddress(to)) {
      this.composeError = 'Please enter a valid email address.';
      return;
    }
    this.sendingCompose = true;
    this.composeClicked = true;
    setTimeout(() => (this.composeClicked = false), 300);
    const resolvedSubject = subject || '(no subject)';
    const timestamp = this.simDate.toISOString();
    if (isMultiRecipient) {
      const threadId = this.createThreadId('vlad-multi');
      try {
        await this.sendMultiRecipientNotice(
          recipients,
          resolvedSubject,
          threadId,
          timestamp
        );
        this.showComposeBox = false;
        this.composeTo = '';
        this.composeSubject = '';
        this.composeBody = '';
        this.composeError = '';
        this.selectedEmail = null;
      } catch (err) {
        console.error('Failed to send multi-recipient notice', err);
        this.composeError = 'We could not send your message. Please try again.';
      } finally {
        this.sendingCompose = false;
      }
      return;
    }
    const threadId = this.createThreadId('outbound');
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
    if (!this.selectedEmail) return;
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
      const rawReply = this.replyText ?? '';
      const replyBody = rawReply.trim().length
        ? this.mergeBodyWithHistory(rawReply, this.selectedEmail, true)
        : '';
      const replyId = await this.inboxService.sendReply(this.companyId, {
        threadId,
        subject,
        message: replyBody,
        parentId: this.selectedEmail.id,
        from: this.meAddress,
        to,
        category,
        timestamp: this.simDate.toISOString(),
        ledgerIgnore: true,
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
        await this.scheduleCalendarAfterKickoffReply(this.simDate.getTime());
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
    const normalized = this.normalizeAddress(address);
    if (normalized === 'vlad@strtupify.io') {
      return 'vlad';
    }
    if (normalized === 'mom@altavista.net') {
      return 'mom';
    }
    if (this.isSupereatsAddress(normalized)) {
      return 'supereats';
    }
    if (this.isCadabraAddress(normalized)) {
      return 'cadabra';
    }
    if (this.isBankAddress(normalized)) {
      return 'bank';
    }
    return 'outbound';
  }

  private parseRecipients(address: string): string[] {
    return (address || '')
      .split(/[;\s]+/)
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  }

  private async sendMultiRecipientNotice(
    recipients: string[],
    subject: string,
    threadId: string,
    timestamp: string
  ): Promise<void> {
    const recipientList = recipients.join(', ');
    let parsed: {
      from?: string;
      subject?: string;
      banner?: boolean;
      deleted?: boolean;
      body: string;
    } = { body: '' };
    try {
      const text = await this.http
        .get('emails/vlad-multi.md', { responseType: 'text' })
        .toPromise();
      parsed = this.parseEmailTemplate(text || '');
    } catch {
      parsed = this.parseEmailTemplate('');
    }
    const fallbackBody =
      `Hello End User,\n\n` +
      `This is Vlad from IT Support at startupify.io. You tried to email multiple people (${recipientList || 'multiple people'}). ` +
      `That feature has not been added yet because leadership asked me to focus on adding more AI features instead of basic email functionality, even if your subject is "${subject || '(no subject)'}"...\n\n` +
      `Please send one email at a time until the AI learns how to count to two. I am very busy and may not immediately respond to all of your emails...\n\n` +
      `Thank you!\nVlad\nIT Support\nstrtupify.io`;
    const subjectLine =
      parsed.subject || 'Multi-recipient emails are not supported';
    const renderedSubject = subjectLine.replace(
      /\{SUBJECT\}/g,
      subject || '(no subject)'
    );
    const renderedBody = (parsed.body || fallbackBody)
      .replace(/\{RECIPIENTS\}/g, recipientList || 'multiple people')
      .replace(/\{SUBJECT\}/g, subject || '(no subject)');
    const emailId = `vlad-multi-${Date.now()}`;
    await this.saveInboxEmail(emailId, {
      from: parsed.from || 'vlad@strtupify.io',
      subject: renderedSubject,
      message: renderedBody,
      deleted: parsed.deleted ?? false,
      banner: parsed.banner ?? false,
      timestamp,
      threadId,
      to: this.meAddress,
      category: 'vlad',
      attemptedRecipients: recipientList,
    });
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
    const timestampMs = Math.max(simTimestamp, this.simDate.getTime(), Date.now());
    const timestampIso = new Date(timestampMs).toISOString();
    try {
      await this.saveInboxEmail(emailId, {
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
        calendarEmailAt: timestampMs,
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

  private async scheduleCalendarAfterKickoffReply(replyTimestampMs?: number): Promise<void> {
    try {
      const simNow = await this.getCompanySimTime();
      const replyMs = Number.isFinite(replyTimestampMs)
        ? Number(replyTimestampMs)
        : this.simDate.getTime();
      const baseMs = Math.max(replyMs, simNow, this.simDate.getTime());
      const target = baseMs + this.kickoffDelayMs;
      const ref = doc(db, `companies/${this.companyId}`);
      let nextAt = target;
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const data = (snap && (snap.data() as any)) || {};
        if (data.calendarEmailSent) return;
        const existing =
          typeof data.calendarEmailAt === 'number'
            ? data.calendarEmailAt
            : null;
        if (typeof existing === 'number') {
          if (existing >= target) {
            nextAt = existing;
          } else {
            nextAt = Math.max(existing, target);
          }
        }
        tx.set(
          ref,
          {
            calendarEmailAt: nextAt,
            calendarEmailSent: false,
            calendarEmailInProgress: false,
            calendarEnabled: false,
          },
          { merge: true }
        );
        this.calendarEmailAt = nextAt;
      });
      const realDelay = Math.max(
        250,
        Math.floor(
          Math.max(0, nextAt - this.simDate.getTime()) / Math.max(1, this.speed)
        )
      );
      setTimeout(() => {
        void this.sendCalendarEmailNow(nextAt);
      }, realDelay);
    } catch {}
  }

  private filteredEmails(emails: InboxEmail[]): InboxEmail[] {
    const endgameEngaged = this.endgameStatus !== 'idle';
    const allowEndgameEmail = (e: InboxEmail): boolean => {
      const category = ((e as any).category || '').toLowerCase();
      const id = String(e.id || '');
      if (id.startsWith('vlad-reset-')) return true;
      if (category === 'kickoff-outcome') return true;
      if (category === 'credits') return true;
      return false;
    };
    const cutoff = this.endgameTriggeredAtMs;
    const shouldHideForEndgame = (e: InboxEmail): boolean => {
      if (endgameEngaged && !allowEndgameEmail(e)) return true;
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

    const needle = this.searchQuery.trim().toLowerCase();
    if (needle) {
      base = base.filter((e) => this.emailMatchesSearch(e, needle));
    }

    return base;
  }

  private emailMatchesSearch(email: InboxEmail, needle: string): boolean {
    const fields = [
      email.subject,
      email.preview,
      email.body,
      (email as any).message,
      email.sender,
      email.to,
      email.displaySender,
      email.displayRecipient,
      (email as any).senderName,
      (email as any).senderTitle,
      (email as any).recipientName,
      (email as any).recipient,
      (email as any).toName,
    ];
    return fields
      .map((f) => String(f || '').toLowerCase())
      .some((text) => text.includes(needle));
  }

  private nextSelectableId(
    currentId: string | null,
    list: InboxEmail[]
  ): string | null {
    if (!currentId || !list.length) return null;
    const idx = list.findIndex((e) => e.id === currentId);
    if (idx === -1) return null;
    if (idx + 1 < list.length) return list[idx + 1].id;
    if (idx - 1 >= 0) return list[idx - 1].id;
    return null;
  }

  private emailTimestampMs(email: InboxEmail): number {
    const raw: any = (email as any)?.timestamp;
    const ts = raw ? new Date(raw).getTime() : NaN;
    return Number.isFinite(ts) ? ts : 0;
  }

  private isEndgameFlagged(email: InboxEmail): boolean {
    const flag = (email as any)?.endgame;
    if (flag === true) return true;
    if (flag === 1) return true;
    if (typeof flag === 'string' && flag.toLowerCase() === 'true') return true;
    const category = ((email as any).category || '').toLowerCase();
    return category === 'endgame' || category.includes('endgame');
  }

  private updateInboxView(
    emails: InboxEmail[],
    opts?: { preferredId?: string | null; avoidIds?: Array<string | null> }
  ): void {
    this.pruneSuppressed();
    const merged = this.mergeSeedEmails(emails);
    this.allEmails = merged;
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
        this.markEmailAsRead(this.selectedEmail);
        return;
      }
    }
    const first = this.inbox.find((e) => !avoid.has(e.id));
    this.selectedEmail = first || null;
    this.pendingSelectionId = null;
    this.preferredInboxEmailId = null;
    this.markEmailAsRead(this.selectedEmail);
  }

  private mergeSeedEmails(emails: InboxEmail[]): InboxEmail[] {
    const merged = emails.slice();
    const seen = new Map<string, InboxEmail>();
    merged.forEach((e) => seen.set(e.id, e));
    for (const [id, seed] of this.seedEmails.entries()) {
      const existing = seen.get(id);
      if (existing) {
        if (!existing.isSeed) {
          this.seedEmails.delete(id);
        }
        continue;
      }
      merged.push(seed);
    }
    return merged;
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
      .getInbox(this.companyId, true)
      .subscribe((emails) =>
        this.updateInboxView(emails.map((e) => this.decorateEmail(e)))
      );
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

  private computeNextWorkWindow(now: Date): Date {
    const base = new Date(now.getTime());
    base.setSeconds(0, 0);
    const windowStart = this.startOfDay(base);
    windowStart.setHours(this.aiDeleteStartHour, 0, 0, 0);
    const windowEnd = this.startOfDay(base);
    windowEnd.setHours(this.aiDeleteEndHour, 0, 0, 0);
    if (base < windowStart) return windowStart;
    if (base >= windowEnd)
      return new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);
    return base;
  }

  private isWithinAiDeleteWindow(d: Date): boolean {
    const hr = d.getHours();
    return hr >= this.aiDeleteStartHour && hr < this.aiDeleteEndHour;
  }

  private randomInt(minInclusive: number, maxInclusive: number): number {
    return (
      Math.floor(Math.random() * (maxInclusive - minInclusive + 1)) +
      minInclusive
    );
  }

  private async saveInboxEmail(emailId: string, payload: Record<string, any>): Promise<void> {
    if (!this.companyId) return;
    await setDoc(doc(db, `companies/${this.companyId}/inbox/${emailId}`), payload);
    await this.emailCounter.recordInbound();
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
      .replace(/\{TOTAL_PRICE\}/g, this.formatCurrency(orderDetails.total))
      .replace(/\{ORDER_NUMBER\}/g, orderNumber)
      .replace(/\{ORDER_DATE\}/g, orderDate);

    const emailId = `cadabra-${Date.now()}`;
    const ledgerMemo = `${orderDetails.quantity}x ${orderDetails.item}`;
    try {
      await this.saveInboxEmail(emailId, {
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
    await this.saveInboxEmail(emailId, {
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

  private async checkVladWorkEmail(): Promise<void> {
    if (!this.vladWorkSendTime) return;
    if (this.vladWorkEmailSent) return;
    if (this.vladWorkProcessing) return;
    if (this.simDate.getTime() < this.vladWorkSendTime) return;
    this.vladWorkProcessing = true;
    const ref = doc(db, `companies/${this.companyId}`);
    let sendAt = this.vladWorkSendTime;
    let proceed = false;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const d = (snap && (snap.data() as any)) || {};
        if (d.vladWorkEmailSent || d.vladWorkEmailInProgress) return;
        const at =
          typeof d.vladWorkEmailAt === 'number'
            ? d.vladWorkEmailAt
            : this.vladWorkSendTime;
        if (!at || this.simDate.getTime() < at) return;
        sendAt = at;
        tx.update(ref, { vladWorkEmailInProgress: true });
        proceed = true;
      });
    } catch {}
    if (!proceed) {
      this.vladWorkProcessing = false;
      return;
    }
    const tpl = this.vladWorkTemplate;
    if (!tpl || !tpl.body || !tpl.subject || !tpl.from) {
      try {
        await updateDoc(ref, { vladWorkEmailInProgress: false });
      } catch {}
      this.vladWorkProcessing = false;
      return;
    }
    const from = tpl.from;
    const subject = tpl.subject;
    const body = tpl.body.trim();
    const emailId = `vlad-work-${Date.now()}`;
    const timestampIso = new Date(
      Math.max(this.simDate.getTime(), sendAt || this.simDate.getTime())
    ).toISOString();
    try {
      await this.saveInboxEmail(emailId, {
        from,
        subject,
        message: body,
        deleted: tpl?.deleted ?? false,
        banner: tpl?.banner ?? false,
        timestamp: timestampIso,
        threadId: 'vlad-work',
        to: this.meAddress,
        category: 'vlad',
        avatarUrl: this.vladDefaultAvatar,
        avatarMood: 'neutral',
      });
      this.vladWorkEmailSent = true;
      this.vladWorkSendTime = null;
      await updateDoc(ref, {
        vladWorkEmailSent: true,
        vladWorkEmailInProgress: false,
        vladWorkEmailAt: sendAt,
      });
    } catch {
      try {
        await updateDoc(ref, { vladWorkEmailInProgress: false });
      } catch {}
    } finally {
      this.vladWorkProcessing = false;
    }
  }

  private async checkAIDeleteEmail(): Promise<void> {
    if (!this.aiDeleteSendTime) return;
    if (this.aiDeleteEmailSent) return;
    if (this.aiDeleteProcessing) return;
    if (this.simDate.getTime() < this.aiDeleteSendTime) return;
    const ref = doc(db, `companies/${this.companyId}`);
    if (!this.isWithinAiDeleteWindow(this.simDate)) {
      const nextAt = this.computeNextWorkWindow(this.simDate).getTime();
      if (nextAt !== this.aiDeleteSendTime) {
        this.aiDeleteSendTime = nextAt;
        try {
          await updateDoc(ref, {
            aiDeleteEmailAt: nextAt,
            aiDeleteEmailInProgress: false,
          });
        } catch {}
      }
      return;
    }
    this.aiDeleteProcessing = true;
    let proceed = false;
    let sendAt = this.aiDeleteSendTime;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const d = (snap && (snap.data() as any)) || {};
        if (d.aiDeleteEmailSent || d.aiDeleteEmailInProgress) return;
        const at =
          typeof d.aiDeleteEmailAt === 'number'
            ? d.aiDeleteEmailAt
            : this.aiDeleteSendTime;
        if (!at || this.simDate.getTime() < at) return;
        sendAt = at;
        tx.update(ref, { aiDeleteEmailInProgress: true });
        proceed = true;
      });
    } catch {}
    if (!proceed) {
      this.aiDeleteProcessing = false;
      return;
    }
    const tpl = this.aiDeleteTemplate || this.parseMarkdownEmail('');
    const from = tpl?.from || 'vlad@strtupify.io';
    const subject = tpl?.subject || 'Quick update on AI Delete';
    const fallbackBody =
      'We just added a new AI Delete button to strtupify.io. It sits next to Delete and works the same for now.';
    const body = (tpl?.body || fallbackBody).trim();
    const emailId = `vlad-ai-delete-${Date.now()}`;
    const timestampIso = new Date(
      Math.max(this.simDate.getTime(), sendAt || this.simDate.getTime())
    ).toISOString();
    try {
      await this.saveInboxEmail(emailId, {
        from,
        subject,
        message: body,
        deleted: tpl?.deleted ?? false,
        banner: tpl?.banner ?? false,
        timestamp: timestampIso,
        threadId: emailId,
        to: this.meAddress,
        category: 'vlad',
        avatarUrl: this.vladDefaultAvatar,
        avatarMood: 'neutral',
      });
      this.aiDeleteEmailSent = true;
      this.aiDeleteSendTime = null;
      await updateDoc(ref, {
        aiDeleteEmailSent: true,
        aiDeleteEmailInProgress: false,
        aiDeleteEmailAt: sendAt,
      });
    } catch {
      try {
        await updateDoc(ref, { aiDeleteEmailInProgress: false });
      } catch {}
    } finally {
      this.aiDeleteProcessing = false;
    }
  }

  private async checkVladNightEmail(): Promise<void> {
    if (!this.vladNightSendTime) return;
    if (this.simDate.getTime() < this.vladNightSendTime) return;
    if (this.vladNightProcessing) return;
    this.vladNightProcessing = true;
    const ref = doc(db, `companies/${this.companyId}`);
    let sendAt = this.vladNightSendTime;
    let proceed = false;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const d = (snap && (snap.data() as any)) || {};
        if (d.vladNightEmailSent || d.vladNightEmailInProgress) return;
        const at =
          typeof d.vladNightEmailAt === 'number'
            ? d.vladNightEmailAt
            : this.vladNightSendTime;
        if (!at || this.simDate.getTime() < at) return;
        sendAt = at;
        tx.update(ref, { vladNightEmailInProgress: true });
        proceed = true;
      });
    } catch {}
    if (!proceed) {
      this.vladNightProcessing = false;
      return;
    }
    const tpl = this.vladNightTemplate || this.parseEmailTemplate('');
    const from = tpl?.from || 'vlad@strtupify.io';
    const subject = tpl?.subject || 'Late night update';
    const fallbackBody =
      'It is way too late and I am still working. You are basically my best friend for even listening to this.' +
      " Between you and me, I've been building a game on the side during the day. It's going to be huge and people will finally respect me.";
    const body = (tpl?.body || fallbackBody).trim();
    const emailId = `vlad-night-${Date.now()}`;
    const timestampIso = new Date(
      Math.max(this.simDate.getTime(), sendAt || this.simDate.getTime())
    ).toISOString();
    const blitzedStamp = new Date(timestampIso).getTime();
    const openAt =
      this.startOfDay(new Date(blitzedStamp)).getTime() + 24 * 60 * 60 * 1000;
    try {
      await this.saveInboxEmail(emailId, {
        from,
        subject,
        message: body,
        deleted: tpl?.deleted ?? false,
        banner: tpl?.banner ?? false,
        timestamp: timestampIso,
        threadId: emailId,
        to: this.meAddress,
        category: 'vlad',
        avatarUrl: this.vladBlitzedAvatar,
        avatarMood: 'neutral',
      });
      this.vladNightEmailSent = true;
      this.vladNightSendTime = null;
      this.vladBlitzedAt = blitzedStamp;
      this.vladOpenToWorkAt = openAt;
      await updateDoc(ref, {
        vladNightEmailSent: true,
        vladNightEmailInProgress: false,
        vladNightEmailAt: blitzedStamp,
        vladBlitzedAt: blitzedStamp,
        vladOpenToWorkAt: openAt,
      });
    } catch {
      try {
        await updateDoc(ref, { vladNightEmailInProgress: false });
      } catch {}
    } finally {
      this.vladNightProcessing = false;
    }
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
    const timestampIso = new Date(
      Math.max(this.simDate.getTime(), Date.now())
    ).toISOString();
    try {
      await this.saveInboxEmail(emailId, {
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
              avatarUrl: 'assets/mom.jpg',
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
