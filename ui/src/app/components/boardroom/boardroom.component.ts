import {
  Component,
  Input,
  OnInit,
  ViewChild,
  ElementRef,
  AfterViewInit,
  ChangeDetectorRef,
  HostListener,
  Output,
  EventEmitter,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { BoardroomService } from '../../services/boardroom.service';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, updateDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { buildAvatarUrl } from 'src/app/utils/avatar';
import { fallbackEmployeeColor, normalizeEmployeeColor } from 'src/app/utils/employee-colors';
import { environment } from 'src/environments/environment';

const fbApp = getApps().length ? getApps()[0] : initializeApp(environment.firebase);
const db = getFirestore(fbApp);

interface TranscriptEntry {
  speaker: string;
  line: string;
  avatarUrl?: string | null;
  initials: string;
}

@Component({
  selector: 'app-boardroom',
  templateUrl: './boardroom.component.html',
  styleUrls: ['./boardroom.component.scss'],
  standalone: true,
  imports: [CommonModule],
})
export class BoardroomComponent implements OnInit, AfterViewInit {
  @Input() companyId = '';
  @Output() acceptedProduct = new EventEmitter<void>();
  @ViewChild('scrollBox') private scrollBox!: ElementRef<HTMLDivElement>;
  @ViewChild('headerBox') private headerBox!: ElementRef<HTMLDivElement>;
  @ViewChild('bottomBox') private bottomBox?: ElementRef<HTMLDivElement>;

  productId = '';
  transcript: TranscriptEntry[] = [];
  outcome = { name: '', description: '' };
  stage = 'INTRODUCTION';
  busy = false;
  finished = false;
  typing = false;
  showAiSummary = false;
  aiSummary = '';
  private employeeAvatars = new Map<string, string>();
  private avatarColorCache = new Map<string, string>();
  private pendingAvatarFetches = new Map<string, Promise<void>>();

  constructor(private api: BoardroomService, private cdr: ChangeDetectorRef) {}

  ngOnInit() {
    this.loadEmployeeAvatars();
    this.api.start(this.companyId).subscribe((r) => {
      this.productId = r.productId;
      this.transcript.push(this.buildTranscriptEntry(r.speaker, r.line));
      setTimeout(() => {
        this.updateLayout();
        this.scrollToBottom();
      });
      this.next();
    });
  }

  ngAfterViewInit() {
    this.updateLayout();
    this.scrollToBottom();
  }

  next() {
    if (this.busy || this.finished) return;
    this.busy = true;
    this.typing = true;
    this.cdr.detectChanges();
    this.scrollToBottom();

    setTimeout(() => {
      this.api
        .step(
          this.companyId,
          this.productId,
          this.stage,
          this.transcript.length
        )
        .subscribe((r) => {
          this.typing = false;
          this.transcript.push(this.buildTranscriptEntry(r.speaker, r.line));
          this.outcome = {
            name: r.outcome.product,
            description: r.outcome.description,
          };
          this.stage = r.stage;
          this.finished = r.done;
          this.busy = false;
          if (this.showAiSummary) {
            this.aiSummary = this.buildAiSummary();
          }

          this.cdr.detectChanges();
          setTimeout(() => {
            this.updateLayout();
            this.scrollToBottom();
          });
          if (!this.finished) {
            setTimeout(() => this.next(), 1000);
          }
        });
    }, 1000);
  }

  restart() {
    this.transcript = [];
    this.outcome = { name: '', description: '' };
    this.stage = 'INTRODUCTION';
    this.busy = false;
    this.finished = false;
    this.typing = false;
    this.showAiSummary = false;
    this.aiSummary = '';

    this.api.start(this.companyId).subscribe((r) => {
      this.productId = r.productId;
      this.transcript.push(this.buildTranscriptEntry(r.speaker, r.line));
      setTimeout(() => {
        this.updateLayout();
        this.scrollToBottom();
      });
      this.next();
    });
  }

  async accept() {
    await updateDoc(
      doc(db, `companies/${this.companyId}/products/${this.productId}`),
      { accepted: true }
    );
    this.acceptedProduct.emit();
  }

  summarizeWithAi(): void {
    this.aiSummary = this.buildAiSummary();
    this.showAiSummary = true;
    this.cdr.detectChanges();
    setTimeout(() => {
      this.updateLayout();
      this.scrollToBottom();
    });
  }

  private scrollToBottom(): void {
    const box = this.scrollBox.nativeElement;
    box.scrollTop = box.scrollHeight;
  }

  @HostListener('window:resize')
  onResize() {
    this.updateLayout();
  }

  private updateLayout(): void {
    if (!this.scrollBox || !this.headerBox) return;
    const scroll = this.scrollBox.nativeElement;
    const header = this.headerBox.nativeElement;
    const bottom = this.bottomBox?.nativeElement ?? null;

    const pageVerticalPadding = 40; 
    const gridGaps = bottom ? 40 : 20; 
    const safetyPadding = 12;

    const viewport = window.innerHeight || document.documentElement.clientHeight;
    const available = Math.max(
      0,
      viewport -
        pageVerticalPadding -
        header.offsetHeight -
        (bottom?.offsetHeight ?? 0) -
        gridGaps -
        safetyPadding
    );

    scroll.style.maxHeight = `${available}px`;
    scroll.style.overflowY = 'auto';
  }

  private async loadEmployeeAvatars(): Promise<void> {
    if (!this.companyId) return;
    try {
      const ref = query(
        collection(db, `companies/${this.companyId}/employees`),
        where('hired', '==', true)
      );
      const snap = await getDocs(ref);
      const map = new Map<string, string>();
      const tasks: Array<Promise<void>> = [];
      snap.docs.forEach((d) => {
        const data = (d.data() as any) || {};
        const name = String(data.name || '').trim();
        if (!name) return;
        const nameKey = name.toLowerCase();
        const avatarName = String(
          data.avatar || data.photo || data.photoUrl || data.image || ''
        ).trim();
        const directUrl = String(data.avatarUrl || data.avatar_url || '').trim();
        const color =
          normalizeEmployeeColor(data.calendarColor || data.color) ||
          fallbackEmployeeColor(d.id);
        const builtUrl = buildAvatarUrl(avatarName, 'neutral');
        const baseUrl = directUrl || builtUrl;
        if (baseUrl) map.set(nameKey, baseUrl);
        if (avatarName && color) {
          const colorBase = builtUrl || baseUrl || null;
          tasks.push(this.colorizeAvatar(nameKey, avatarName, color, colorBase));
        }
      });
      this.employeeAvatars = map;
      this.refreshTranscriptAvatars();
      if (tasks.length) await Promise.all(tasks);
    } catch (err) {
      console.error('Failed to load boardroom avatars', err);
    }
  }

  private refreshTranscriptAvatars(): void {
    this.transcript = this.transcript.map((line) => ({
      ...line,
      avatarUrl: this.avatarForSpeaker(line.speaker),
      initials: line.initials || this.initialsFor(line.speaker),
    }));
    this.cdr.detectChanges();
  }

  private buildTranscriptEntry(speaker: string, line: string): TranscriptEntry {
    return {
      speaker,
      line,
      avatarUrl: this.avatarForSpeaker(speaker),
      initials: this.initialsFor(speaker),
    };
  }

  private avatarForSpeaker(name: string): string | null {
    if (!name) return null;
    const key = name.trim().toLowerCase();
    return this.employeeAvatars.get(key) || null;
  }

  private initialsFor(name: string): string {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const first = parts[0].charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return `${first}${last}`.toUpperCase() || first.toUpperCase();
  }

  private buildAiSummary(): string {
    const participants = Array.from(
      new Set(this.transcript.map((t) => t.speaker).filter(Boolean))
    );
    const productName = this.outcome.name || 'a new product concept';
    const productDescription =
      (this.outcome.description || '').trim() || 'still being defined';

    const voices =
      participants.length === 0
        ? 'TBD'
        : participants.slice(0, 4).join(', ') +
          (participants.length > 4 ? ', and others' : '');

    return `This meeting's main focus was ${productName}, which is ${productDescription}. Key voices: ${voices}. Key insights: {AI_INSIGHTS}`;
  }

  private avatarCacheKey(avatarName: string, color: string): string {
    return `${avatarName || ''}|${color || ''}`;
  }

  private async colorizeAvatar(
    nameKey: string,
    avatarName: string,
    color: string,
    preferredBaseUrl: string | null
  ): Promise<void> {
    const normalizedColor = normalizeEmployeeColor(color);
    if (!normalizedColor) return;
    const cacheKey = this.avatarCacheKey(avatarName, normalizedColor);
    const cached = this.avatarColorCache.get(cacheKey);
    if (cached) {
      this.applyAvatarForName(nameKey, cached);
      return;
    }
    if (this.pendingAvatarFetches.has(cacheKey)) {
      await this.pendingAvatarFetches.get(cacheKey);
      return;
    }
    const baseUrl = preferredBaseUrl || buildAvatarUrl(avatarName, 'neutral');
    if (!baseUrl) return;
    const task = (async () => {
      try {
        const resp = await fetch(baseUrl);
        if (!resp.ok) throw new Error(`avatar_status_${resp.status}`);
        const svg = await resp.text();
        const updated = svg.replace(/#262E33/gi, normalizedColor);
        const uri = this.svgToDataUri(updated);
        this.avatarColorCache.set(cacheKey, uri);
        this.applyAvatarForName(nameKey, uri);
      } catch (err) {
        console.error('Failed to recolor avatar', err);
      } finally {
        this.pendingAvatarFetches.delete(cacheKey);
      }
    })();
    this.pendingAvatarFetches.set(cacheKey, task);
    await task;
  }

  private applyAvatarForName(nameKey: string, url: string): void {
    this.employeeAvatars.set(nameKey, url);
    this.refreshTranscriptAvatars();
  }

  private svgToDataUri(svg: string): string {
    const encoded = btoa(
      encodeURIComponent(svg).replace(/%([0-9A-F]{2})/g, (_m, p1) =>
        String.fromCharCode(parseInt(p1, 16))
      )
    );
    return `data:image/svg+xml;base64,${encoded}`;
  }
}
