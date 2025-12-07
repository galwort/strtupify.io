import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { initializeApp, getApps } from 'firebase/app';
import {
  collection,
  doc,
  getFirestore,
  onSnapshot,
  query,
  where,
  DocumentData,
  QuerySnapshot,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';

type CalendarEmployee = {
  id: string;
  name: string;
  color: string;
};

type CalendarMeeting = {
  id: string;
  owner: string;
  participants: string[];
  dayIndex: number;
  start: number;
  end: number;
};

type VisualMeeting = CalendarMeeting & {
  top: number;
  height: number;
  left: number;
  width: number;
  bg: string;
  border: string;
  participantDots: string[];
};

type DragPreview = {
  dayIndex: number;
  top: number;
  height: number;
  conflict: boolean;
};

const fbApp = getApps().length
  ? getApps()[0]
  : initializeApp(environment.firebase);
const db = getFirestore(fbApp);

@Component({
  selector: 'app-calendar',
  standalone: true,
  templateUrl: './calendar.component.html',
  styleUrls: ['./calendar.component.scss'],
  imports: [CommonModule, FormsModule],
})
export class CalendarComponent implements OnInit, OnDestroy {
  @Input() companyId = '';

  employees: CalendarEmployee[] = [];
  selectedEmployees = new Set<string>();
  meetings: CalendarMeeting[] = [];
  visualByDay: VisualMeeting[][] = [[], [], [], [], []];
  weekStart: Date | null = null;
  weekDays: Date[] = [];
  weekLabel = '';
  selectedMeetingId: string | null = null;
  statusMessage = '';
  statusError = '';
  submittedScore: number | null = null;
  focusScore = 0;
  focusHours = 0;
  focusPoints = 0;
  lastEarnedPoints: number | null = null;
  isSubmitting = false;
  timeTicks: string[] = [];

  private simTime = Date.now();
  private unsubCompany: (() => void) | null = null;
  private unsubEmployees: (() => void) | null = null;
  private scheduleSeed = '';
  private readonly palette = [
    '#f9c74f', // warm yellow
    '#ef476f', // vivid pink-red
    '#118ab2', // deep teal-blue
    '#9b5de5', // purple
    '#06d6a0', // mint green
    '#ff8fab', // soft rose
    '#ffd166', // golden orange
    '#5c7aff', // clear blue
  ];
  private readonly workdayStartHour = 8;
  private readonly workdayEndHour = 17;
  private readonly workMinutes =
    (this.workdayEndHour - this.workdayStartHour) * 60;
  private readonly calendarByPerson = new Map<string, CalendarMeeting[]>();
  draggingMeetingId: string | null = null;
  dragPreview: DragPreview | null = null;

  ngOnInit(): void {
    this.buildTimeSlots();
    if (!this.companyId) return;
    this.subscribeToCompany();
    this.subscribeToEmployees();
  }

  ngOnDestroy(): void {
    if (this.unsubCompany) this.unsubCompany();
    if (this.unsubEmployees) this.unsubEmployees();
  }

  get userMeetings(): CalendarMeeting[] {
    return this.meetings.filter((m) => m.owner === 'me');
  }

  toggleEmployee(id: string, checked: boolean): void {
    if (checked) this.selectedEmployees.add(id);
    else this.selectedEmployees.delete(id);
    this.selectedEmployees = new Set(this.selectedEmployees);
    this.recomputeVisuals();
  }

  onMeetingClick(ev: VisualMeeting): void {
    if (ev.owner !== 'me') return;
    this.selectedMeetingId = ev.id;
    this.statusMessage = '';
    this.statusError = '';
  }

  get focusPointEstimate(): number {
    return Math.max(0, Math.round(this.focusScore));
  }

  async submitSchedule(): Promise<void> {
    this.submittedScore = this.focusScore;
    this.lastEarnedPoints = this.focusPointEstimate;
    this.statusError = '';
    this.statusMessage = 'Submitting your reschedule plan...';
    if (!this.companyId) {
      this.statusError = 'No company selected.';
      this.statusMessage = '';
      return;
    }
    this.isSubmitting = true;
    try {
      const added = await this.persistFocusPoints(this.focusPointEstimate);
      if (added > 0) {
        this.statusMessage = `Submitted and banked ${added.toLocaleString()} focus points.`;
        this.lastEarnedPoints = added;
      } else {
        this.statusMessage = 'Submitted your reschedule plan for scoring.';
      }
    } catch (err) {
      console.error('Failed to store focus points', err);
      this.statusError = 'Failed to store focus points. Please try again.';
      this.statusMessage = '';
    } finally {
      this.isSubmitting = false;
    }
  }

  meetingTitle(ev: VisualMeeting): string {
    const others = ev.participants
      .filter((p) => p !== 'me')
      .map((p) => this.employeeName(p));
    return others.length ? `With ${others.join(', ')}` : 'Solo work block';
  }

  dayLabel(d: Date | null): string {
    if (!d) return '';
    const fmt = d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    return fmt;
  }

  private subscribeToCompany(): void {
    if (this.unsubCompany) {
      this.unsubCompany();
      this.unsubCompany = null;
    }
    const ref = doc(db, `companies/${this.companyId}`);
    this.unsubCompany = onSnapshot(ref, (snap) => {
      const data = (snap && (snap.data() as any)) || {};
      const st = Number(data.simTime || Date.now());
      if (Number.isFinite(st)) {
        this.simTime = st;
        this.updateWeekIfNeeded();
      }
      const fp = Number(data.focusPoints || 0);
      this.focusPoints = Number.isFinite(fp) ? Math.max(0, Math.round(fp)) : 0;
    });
  }

  private subscribeToEmployees(): void {
    if (this.unsubEmployees) {
      this.unsubEmployees();
      this.unsubEmployees = null;
    }
    const ref = query(
      collection(db, `companies/${this.companyId}/employees`),
      where('hired', '==', true)
    );
    this.unsubEmployees = onSnapshot(
      ref,
      (snap: QuerySnapshot<DocumentData>) => {
        const existingSelection = new Set(this.selectedEmployees);
        this.employees = snap.docs
          .map((d) => {
            const data = (d.data() as any) || {};
            const name = String(data.name || '').trim() || 'Teammate';
            const color = this.palette[this.colorIndex(d.id)];
            return { id: d.id, name, color } as CalendarEmployee;
          })
          .sort((a, b) => a.name.localeCompare(b.name));

        if (!existingSelection.size && this.employees.length) {
          this.employees
            .slice(0, Math.min(3, this.employees.length))
            .forEach((e) => existingSelection.add(e.id));
        }
        this.selectedEmployees = new Set(
          [...existingSelection].filter((id) =>
            this.employees.some((e) => e.id === id)
          )
        );
        if (!this.selectedEmployees.size && this.employees.length) {
          this.selectedEmployees.add(this.employees[0].id);
        }
        this.updateWeekIfNeeded(true);
      }
    );
  }

  private updateWeekIfNeeded(force: boolean = false): void {
    const nextWeek = this.computeNextWeekStart();
    if (!nextWeek) return;
    const seedKey = `${nextWeek.getTime()}-${this.employees
      .map((e) => e.id)
      .join('|')}`;
    const weekChanged =
      !this.weekStart || this.weekStart.getTime() !== nextWeek.getTime();
    const seedChanged = this.scheduleSeed !== seedKey;
    if (force || weekChanged || seedChanged) {
      this.weekStart = nextWeek;
      this.weekDays = this.buildWeekDays(nextWeek);
      this.weekLabel = this.formatRangeLabel(
        this.weekDays[0],
        this.weekDays[this.weekDays.length - 1]
      );
      this.scheduleSeed = seedKey;
      this.buildMeetings();
    } else {
      this.recomputeVisuals();
      this.computeFocusScore();
    }
  }

  private computeNextWeekStart(): Date | null {
    const base = new Date(this.simTime);
    if (Number.isNaN(base.getTime())) return null;
    const day = base.getDay(); // 0 = Sunday
    const daysToNextMonday = (8 - day) % 7 || 7;
    const nextMonday = new Date(base);
    nextMonday.setHours(0, 0, 0, 0);
    nextMonday.setDate(base.getDate() + daysToNextMonday);
    return nextMonday;
  }

  private buildWeekDays(start: Date): Date[] {
    const days: Date[] = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(start.getTime());
      d.setDate(start.getDate() + i);
      days.push(d);
    }
    return days;
  }

  private formatRangeLabel(start: Date | null, end: Date | null): string {
    if (!start || !end) return '';
    const fmt = (d: Date) =>
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${fmt(start)} - ${fmt(end)}`;
  }

  private buildTimeSlots(): void {
    this.timeTicks = [];
    for (let h = this.workdayStartHour; h < this.workdayEndHour; h++) {
      const am = h < 12;
      const base = h % 12 === 0 ? 12 : h % 12;
      this.timeTicks.push(`${base} ${am ? 'AM' : 'PM'}`);
    }
  }

  private buildMeetings(): void {
    this.meetings = [];
    this.calendarByPerson.clear();
    const seed = `${this.companyId}-${this.weekStart?.toISOString() || ''}-${
      this.employees.length
    }`;
    const rng = this.makeRng(seed);
    const durations = [30, 60];

    for (let dayIndex = 0; dayIndex < 5; dayIndex++) {
      const userCount = this.employees.length
        ? 3 + Math.floor(rng() * 4) // 3-6
        : 2 + Math.floor(rng() * 2); // 2-3
      for (let i = 0; i < userCount; i++) {
        const participantCount = this.employees.length
          ? 1 + Math.floor(rng() * Math.min(3, this.employees.length))
          : 0;
        const participants = [
          'me',
          ...this.pickParticipants(participantCount, rng),
        ];
        const duration = durations[Math.floor(rng() * durations.length)];
        this.placeMeeting('me', participants, dayIndex, duration, rng);
      }

      const teamCount = this.employees.length ? 2 + Math.floor(rng() * 3) : 1;
      for (let j = 0; j < teamCount; j++) {
        const group = this.pickParticipants(
          1 +
            Math.floor(
              rng() * Math.min(3, Math.max(0, this.employees.length - 1))
            ),
          rng
        );
        if (!group.length) continue;
        const owner = group[0];
        const duration = durations[(j + dayIndex) % durations.length];
        this.placeMeeting(owner, [owner, ...group.slice(1)], dayIndex, duration, rng);
      }
    }

    this.syncSelection();
    this.recomputeVisuals();
    this.computeFocusScore();
  }

  private placeMeeting(
    owner: string,
    participants: string[],
    dayIndex: number,
    durationMinutes: number,
    rng: () => number
  ): void {
    if (!this.weekStart) return;
    const attempts = 24;
    const dayStart = this.dayStartMs(dayIndex);
    const latestStart = this.workMinutes - durationMinutes;
    if (latestStart < 0) return;
    for (let i = 0; i < attempts; i++) {
      const slot = Math.floor(rng() * (latestStart + 1));
      const roundedSlot = Math.floor(slot / 30) * 30;
      const startMs = dayStart + roundedSlot * 60000;
      const endMs = startMs + durationMinutes * 60000;
      if (endMs > dayStart + this.workMinutes * 60000) continue;
      const party = Array.from(new Set([owner, ...participants]));
      if (this.hasConflict(party, dayIndex, startMs, endMs)) continue;
      const meeting: CalendarMeeting = {
        id: `${owner}-${dayIndex}-${startMs}-${endMs}-${Math.floor(
          rng() * 1_000_000
        )}`,
        owner,
        participants: party,
        dayIndex,
        start: startMs,
        end: endMs,
      };
      this.addMeeting(meeting);
      return;
    }
  }

  private addMeeting(m: CalendarMeeting): void {
    this.meetings.push(m);
    for (const p of m.participants) {
      const list = this.calendarByPerson.get(p) || [];
      list.push(m);
      this.calendarByPerson.set(p, list);
    }
  }

  private hasConflict(
    participants: string[],
    dayIndex: number,
    start: number,
    end: number,
    ignoreId?: string
  ): boolean {
    for (const p of participants) {
      const list = this.calendarByPerson.get(p) || [];
      for (const meeting of list) {
        if (ignoreId && meeting.id === ignoreId) continue;
        if (meeting.dayIndex !== dayIndex) continue;
        const overlap = meeting.start < end && start < meeting.end;
        if (overlap) return true;
      }
    }
    return false;
  }

  private updateMeetingTime(
    meeting: CalendarMeeting,
    dayIndex: number,
    startMs: number,
    endMs: number
  ): void {
    const oldParticipants = [...meeting.participants];
    for (const p of oldParticipants) {
      const list = this.calendarByPerson.get(p) || [];
      this.calendarByPerson.set(
        p,
        list.filter((m) => m.id !== meeting.id)
      );
    }
    meeting.dayIndex = dayIndex;
    meeting.start = startMs;
    meeting.end = endMs;
    for (const p of oldParticipants) {
      const list = this.calendarByPerson.get(p) || [];
      list.push(meeting);
      this.calendarByPerson.set(p, list);
    }
  }

  private computeBlockPosition(
    dayIndex: number,
    startMs: number,
    endMs: number
  ): { top: number; height: number } {
    const startMinutes = (startMs - this.dayStartMs(dayIndex)) / 60000;
    const duration = (endMs - startMs) / 60000;
    const dayHeightPx = 720;
    const pxPerMinute = dayHeightPx / this.workMinutes;
    const gapPx = 3;
    let startPx = startMinutes * pxPerMinute + gapPx;
    let heightPx = Math.max(10, duration * pxPerMinute - gapPx * 2);
    if (startPx + heightPx > dayHeightPx) {
      heightPx = Math.max(10, dayHeightPx - startPx);
    }
    const top = (startPx / dayHeightPx) * 100;
    const height = Math.max(4, (heightPx / dayHeightPx) * 100);
    return { top, height };
  }

  private recomputeVisuals(): void {
    const visible = new Set<string>(['me', ...this.selectedEmployees]);
    const byDay: VisualMeeting[][] = [[], [], [], [], []];
    for (const meeting of this.meetings) {
      const ownerVisible = visible.has(meeting.owner);
      const participantVisible = meeting.participants.some((p) =>
        visible.has(p)
      );
      if (!ownerVisible && !participantVisible) continue;
      const { top, height } = this.computeBlockPosition(
        meeting.dayIndex,
        meeting.start,
        meeting.end
      );
      const bg = meeting.owner === 'me' ? '#fff' : this.colorFor(meeting.owner);
      const border =
        meeting.owner === 'me' ? '#d8e2ec' : this.colorFor(meeting.owner);
      const dots =
        meeting.owner === 'me'
          ? meeting.participants
              .filter((p) => p !== 'me')
              .map((p) => this.colorFor(p))
          : [];
      const v: VisualMeeting = {
        ...meeting,
        top,
        height,
        left: 0,
        width: 100,
        bg,
        border,
        participantDots: dots,
      };
      byDay[meeting.dayIndex].push(v);
    }
    for (let i = 0; i < byDay.length; i++) {
      byDay[i] = this.layoutDay(byDay[i]);
    }
    this.visualByDay = byDay;
  }

  onMeetingDragStart(event: DragEvent, meeting: VisualMeeting): void {
    if (meeting.owner !== 'me') return;
    this.draggingMeetingId = meeting.id;
    this.dragPreview = null;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', meeting.id);
    }
  }

  onMeetingDragEnd(): void {
    this.draggingMeetingId = null;
    this.dragPreview = null;
  }

  onDayDragOver(event: DragEvent, dayIndex: number): void {
    if (!this.draggingMeetingId) return;
    const meeting = this.meetings.find(
      (m) => m.id === this.draggingMeetingId && m.owner === 'me'
    );
    if (!meeting) {
      this.dragPreview = null;
      return;
    }
    event.preventDefault();
    event.dataTransfer && (event.dataTransfer.dropEffect = 'move');
    const placement = this.computeDropPlacement(event, meeting, dayIndex);
    if (!placement || placement.outOfBounds) {
      this.dragPreview = null;
      return;
    }
    this.dragPreview = {
      dayIndex,
      top: placement.top,
      height: placement.height,
      conflict: placement.conflict,
    };
  }

  onDayDragLeave(_: DragEvent, dayIndex: number): void {
    if (this.dragPreview && this.dragPreview.dayIndex === dayIndex) {
      this.dragPreview = null;
    }
  }

  onDayDrop(event: DragEvent, dayIndex: number): void {
    if (!this.draggingMeetingId) return;
    event.preventDefault();
    const meeting = this.meetings.find(
      (m) => m.id === this.draggingMeetingId && m.owner === 'me'
    );
    if (!meeting) {
      this.draggingMeetingId = null;
      this.dragPreview = null;
      return;
    }
    const placement = this.computeDropPlacement(event, meeting, dayIndex);
    this.dragPreview = null;
    if (!placement || placement.outOfBounds || placement.conflict) {
      this.draggingMeetingId = null;
      return;
    }
    this.updateMeetingTime(meeting, dayIndex, placement.startMs, placement.endMs);
    this.statusError = '';
    this.statusMessage = '';
    this.draggingMeetingId = null;
    this.recomputeVisuals();
    this.computeFocusScore();
  }

  private layoutDay(events: VisualMeeting[]): VisualMeeting[] {
    const sorted = events
      .slice()
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const active: VisualMeeting[] = [];
    for (const ev of sorted) {
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].end <= ev.start) active.splice(i, 1);
      }
      const used = new Set(
        active.map((e) => ((e as any).leftSlot as number) || 0)
      );
      let column = 0;
      while (used.has(column)) column++;
      (ev as any).leftSlot = column;
      active.push(ev);
      const columnsNow =
        Math.max(...active.map((e) => (e as any).leftSlot as number)) + 1;
      for (const a of active) {
        (a as any).colCount = Math.max((a as any).colCount || 1, columnsNow);
      }
    }
    return sorted.map((ev) => {
      const colCount = Math.max(1, ((ev as any).colCount as number) || 1);
      const column = ((ev as any).leftSlot as number) || 0;
      const colWidth = 100 / colCount;
      const gutter = 1; // percentage gutter between side-by-side events
      const width = Math.max(1, colWidth - gutter);
      const left = column * colWidth + gutter / 2;
      return { ...ev, width, left };
    });
  }

  private computeDropPlacement(
    event: DragEvent,
    meeting: CalendarMeeting,
    dayIndex: number
  ):
    | {
        startMs: number;
        endMs: number;
        top: number;
        height: number;
        conflict: boolean;
        outOfBounds: boolean;
      }
    | null {
    if (!this.weekStart) return null;
    const targetEl = event.currentTarget as HTMLElement | null;
    if (!targetEl) return null;
    const rect = targetEl.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const clampedY = Math.max(0, Math.min(rect.height, y));
    const minutes = (clampedY / rect.height) * this.workMinutes;
    const durationMs = Math.max(30 * 60000, meeting.end - meeting.start);
    const durationMinutes = Math.round(durationMs / 60000);
    const maxStartMinutes = Math.max(0, this.workMinutes - durationMinutes);
    const snapMinutesRaw = Math.floor(minutes / 30) * 30;
    const snappedMinutes = Math.max(0, Math.min(maxStartMinutes, snapMinutesRaw));
    const dayStart = this.dayStartMs(dayIndex);
    const dayEnd = dayStart + this.workMinutes * 60000;
    const desiredStart = dayStart + snappedMinutes * 60000;
    const maxStartMs = dayEnd - durationMs;
    const startMs = Math.min(Math.max(dayStart, desiredStart), maxStartMs);
    const endMs = startMs + durationMs;
    const outOfBounds = endMs > dayEnd || startMs >= dayEnd;
    const conflict = this.hasParticipantOverlap(
      meeting.participants,
      dayIndex,
      startMs,
      endMs,
      meeting.id
    );
    const { top, height } = this.computeBlockPosition(
      dayIndex,
      startMs,
      endMs
    );
    return { startMs, endMs, conflict, outOfBounds, top, height };
  }

  private hasParticipantOverlap(participants: string[], dayIndex: number, start: number, end: number, ignoreId?: string): boolean {
    const partSet = new Set(participants);
    for (const m of this.meetings) {
      if (ignoreId && m.id === ignoreId) continue;
      if (m.dayIndex !== dayIndex) continue;
      if (!(m.start < end && start < m.end)) continue;
      const shares = m.participants.some((p) => partSet.has(p));
      if (shares) return true;
    }
    return false;
  }

  private computeFocusScore(): void {
    let freeHours = 0;
    let score = 0;
    for (let dayIndex = 0; dayIndex < 5; dayIndex++) {
      const blocks = this.userMeetings
        .filter((m) => m.dayIndex === dayIndex)
        .sort((a, b) => a.start - b.start);
      const merged: Array<{ start: number; end: number }> = [];
      for (const m of blocks) {
        if (!merged.length || m.start > merged[merged.length - 1].end) {
          merged.push({ start: m.start, end: m.end });
        } else {
          merged[merged.length - 1].end = Math.max(
            merged[merged.length - 1].end,
            m.end
          );
        }
      }
      let cursor = this.dayStartMs(dayIndex);
      const dayEnd = cursor + this.workMinutes * 60000;
      for (const b of merged) {
        if (b.start > cursor) {
          const gap = b.start - cursor;
          const hours = gap / 3_600_000;
          freeHours += hours;
          score += hours * hours;
        }
        cursor = Math.max(cursor, b.end);
      }
      if (cursor < dayEnd) {
        const gap = dayEnd - cursor;
        const hours = gap / 3_600_000;
        freeHours += hours;
        score += hours * hours;
      }
    }
    this.focusHours = Math.round(freeHours * 10) / 10;
    this.focusScore = Math.round(score * 10) / 10;
  }

  private async persistFocusPoints(earned: number): Promise<number> {
    if (!this.companyId || earned <= 0) return 0;
    const ref = doc(db, `companies/${this.companyId}`);
    const result = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = (snap && (snap.data() as any)) || {};
      const current = Number.isFinite(Number(data.focusPoints))
        ? Math.max(0, Math.round(Number(data.focusPoints)))
        : 0;
      const next = current + earned;
      tx.set(
        ref,
        {
          focusPoints: next,
          lastFocusScore: this.focusScore,
          lastFocusHours: this.focusHours,
          lastFocusPointsEarned: earned,
          focusPointsUpdatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      return { current, next };
    });
    this.focusPoints = result.next;
    return Math.max(0, result.next - result.current);
  }

  private syncSelection(): void {
    const userList = this.userMeetings;
    if (!userList.length) {
      this.selectedMeetingId = null;
      return;
    }
    const existing = userList.find((m) => m.id === this.selectedMeetingId);
    const pick = existing || userList[0];
    this.selectedMeetingId = pick.id;
  }

  private pickParticipants(count: number, rng: () => number): string[] {
    const pool = this.employees.map((e) => e.id);
    const selected: string[] = [];
    for (let i = 0; i < count; i++) {
      if (!pool.length) break;
      const idx = Math.floor(rng() * pool.length);
      selected.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return selected;
  }

  private dayStartMs(dayIndex: number): number {
    if (!this.weekStart) return 0;
    const start = new Date(this.weekStart.getTime());
    start.setDate(this.weekStart.getDate() + dayIndex);
    start.setHours(this.workdayStartHour, 0, 0, 0);
    return start.getTime();
  }

  private employeeName(id: string): string {
    if (id === 'me') return 'You';
    const emp = this.employees.find((e) => e.id === id);
    return emp ? emp.name : 'Teammate';
  }

  private colorFor(id: string): string {
    if (id === 'me') return '#ffffff';
    const idx = this.employees.findIndex((e) => e.id === id);
    if (idx === -1) return '#c8d6df';
    return this.employees[idx].color;
  }

  private colorIndex(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = (h * 31 + id.charCodeAt(i)) >>> 0;
    }
    return h % this.palette.length;
  }

  private makeRng(seed: string): () => number {
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    }
    return () => {
      h = (h * 1664525 + 1013904223) >>> 0;
      return (h >>> 0) / 0xffffffff;
    };
  }

  private pad(num: number): string {
    return num < 10 ? `0${num}` : `${num}`;
  }

  private formatTimeValue(ms: number): string {
    const d = new Date(ms);
    const hh = this.pad(d.getHours());
    const mm = this.pad(d.getMinutes());
    return `${hh}:${mm}`;
  }

  private parseMinutes(time: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(time || '');
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
    if (h < this.workdayStartHour || h > this.workdayEndHour) return null;
    if (min !== 0 && min !== 30) return null;
    return (h - this.workdayStartHour) * 60 + min;
  }
}
