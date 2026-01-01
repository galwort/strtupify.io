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
  updateDoc,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import {
  EMPLOYEE_COLOR_PALETTE,
  assignEmployeeColors,
  fallbackEmployeeColor,
  normalizeEmployeeColor,
} from 'src/app/utils/employee-colors';

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
  calendarLocked = false;
  private calendarSubmittedWeekStart: number | null = null;
  private storedWeekStart: number | null = null;
  private storedMeetings: CalendarMeeting[] = [];

  private simTime = Date.now();
  private unsubCompany: (() => void) | null = null;
  private unsubEmployees: (() => void) | null = null;
  private scheduleSeed = '';
  private readonly palette = EMPLOYEE_COLOR_PALETTE;
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
    if (this.calendarLocked) {
      this.statusMessage = 'Already submitted for this week.';
      this.statusError = '';
      return;
    }
    const currentWeekStart = this.weekStart?.getTime() || null;
    if (currentWeekStart === null) {
      this.statusError = 'Unable to determine the current week. Please try again.';
      this.statusMessage = '';
      return;
    }
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
      const added = await this.persistFocusPoints(
        this.focusPointEstimate,
        currentWeekStart
      );
      if (added > 0) {
        this.statusMessage = `Submitted and banked ${added.toLocaleString()} focus points.`;
        this.lastEarnedPoints = added;
      } else {
        this.statusMessage = 'Submitted your reschedule plan for scoring.';
      }
      this.calendarSubmittedWeekStart = currentWeekStart;
      this.applyCalendarLock();
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
      }
      const scheduleWeek =
        typeof data.calendarScheduleWeekStart === 'number'
          ? data.calendarScheduleWeekStart
          : null;
      const scheduleData = Array.isArray((data as any).calendarSchedule)
        ? (data as any).calendarSchedule
        : null;
      this.readStoredSchedule(scheduleData, scheduleWeek);
      const submittedWeek =
        typeof data.calendarSubmittedWeekStart === 'number'
          ? data.calendarSubmittedWeekStart
          : null;
      this.calendarSubmittedWeekStart = submittedWeek;
      this.updateWeekIfNeeded();
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
        const colorMap = assignEmployeeColors(
          snap.docs,
          this.companyId || 'color-seed'
        );
        void this.persistEmployeeColors(snap.docs, colorMap);
        this.employees = snap.docs
          .map((d) => {
            const data = (d.data() as any) || {};
            const name = String(data.name || '').trim() || 'Teammate';
            const color =
              colorMap.get(d.id) ||
              fallbackEmployeeColor(d.id, this.palette);
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

  private readStoredSchedule(raw: any, weekStart: number | null): void {
    if (!Array.isArray(raw) || weekStart === null) {
      this.storedWeekStart = null;
      this.storedMeetings = [];
      return;
    }
    const normalized = raw
      .map((m) => this.normalizeStoredMeeting(m))
      .filter((m): m is CalendarMeeting => !!m);
    this.storedWeekStart = normalized.length ? weekStart : null;
    this.storedMeetings = normalized.length ? normalized : [];
  }

  private async persistEmployeeColors(
    docs: Array<{ id: string; data(): any }>,
    colors: Map<string, string>
  ): Promise<void> {
    if (!this.companyId) return;
    const updates = docs
      .map((d) => {
        const data = (d.data() as any) || {};
        const stored = normalizeEmployeeColor(data.calendarColor || data.color);
        const assigned = colors.get(d.id);
        if (!assigned || (stored && stored === assigned)) return null;
        return updateDoc(
          doc(db, `companies/${this.companyId}/employees/${d.id}`),
          { calendarColor: assigned }
        ).catch((err) => console.error('Failed to store employee color', err));
      })
      .filter((p): p is Promise<void> => !!p);
    if (!updates.length) return;
    await Promise.all(updates);
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
      const stored = this.useStoredSchedule(nextWeek.getTime());
      if (stored) {
        this.applyMeetings(stored);
      } else {
        this.buildMeetings();
      }
    } else {
      this.recomputeVisuals();
      this.computeFocusScore();
    }
    this.applyCalendarLock();
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

  private applyMeetings(list: CalendarMeeting[]): void {
    this.meetings = [];
    this.calendarByPerson.clear();
    for (const m of list) {
      this.addMeeting({ ...m, participants: [...m.participants] });
    }
    this.syncSelection();
    this.recomputeVisuals();
    this.computeFocusScore();
  }

  private useStoredSchedule(weekStartMs: number): CalendarMeeting[] | null {
    if (
      this.storedWeekStart === null ||
      this.storedWeekStart !== weekStartMs ||
      !this.storedMeetings.length
    ) {
      return null;
    }
    return this.cloneMeetings(this.storedMeetings);
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
    const attendees = this.attendeesOf(m);
    for (const p of attendees) {
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
    const oldAttendees = this.attendeesOf(meeting);
    for (const p of oldAttendees) {
      const list = this.calendarByPerson.get(p) || [];
      this.calendarByPerson.set(
        p,
        list.filter((m) => m.id !== meeting.id)
      );
    }
    meeting.dayIndex = dayIndex;
    meeting.start = startMs;
    meeting.end = endMs;
    const newAttendees = this.attendeesOf(meeting);
    for (const p of newAttendees) {
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
    const visible = new Set<string>(this.selectedEmployees);
    const byDay: VisualMeeting[][] = [[], [], [], [], []];
    for (const meeting of this.meetings) {
      const attendees = this.attendeesOf(meeting).filter((p) => p !== 'me');
      const shouldShow =
        !attendees.length || attendees.every((p) => visible.has(p));
      if (!shouldShow) continue;
      const { top, height } = this.computeBlockPosition(
        meeting.dayIndex,
        meeting.start,
        meeting.end
      );
      const bg = meeting.owner === 'me' ? '#fff' : this.colorFor(meeting.owner);
      const border =
        meeting.owner === 'me' ? '#d8e2ec' : this.colorFor(meeting.owner);
      const dots = meeting.participants
        .filter((p) => p !== meeting.owner)
        .map((p) => this.colorFor(p));
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
    if (this.calendarLocked) return;
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
    if (this.calendarLocked) return;
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
    if (this.calendarLocked) return;
    if (this.dragPreview && this.dragPreview.dayIndex === dayIndex) {
      this.dragPreview = null;
    }
  }

  onDayDrop(event: DragEvent, dayIndex: number): void {
    if (this.calendarLocked) return;
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
      meeting,
      dayIndex,
      startMs,
      endMs
    );
    const { top, height } = this.computeBlockPosition(
      dayIndex,
      startMs,
      endMs
    );
    return { startMs, endMs, conflict, outOfBounds, top, height };
  }

  private attendeesOf(meeting: CalendarMeeting): string[] {
    return Array.from(new Set([meeting.owner, ...meeting.participants]));
  }

  private hasParticipantOverlap(
    meeting: CalendarMeeting,
    dayIndex: number,
    start: number,
    end: number
  ): boolean {
    const attendees = this.attendeesOf(meeting);
    for (const p of attendees) {
      const list = this.calendarByPerson.get(p) || [];
      for (const m of list) {
        if (m.id === meeting.id) continue;
        if (m.dayIndex !== dayIndex) continue;
        if (m.start < end && start < m.end) return true;
      }
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

  private serializeMeetings(): Array<{
    id: string;
    owner: string;
    participants: string[];
    dayIndex: number;
    start: number;
    end: number;
  }> {
    return this.meetings.map((m) => ({
      id: m.id,
      owner: m.owner,
      participants: [...m.participants],
      dayIndex: m.dayIndex,
      start: m.start,
      end: m.end,
    }));
  }

  private cloneMeetings(list: CalendarMeeting[]): CalendarMeeting[] {
    return list.map((m) => ({
      ...m,
      participants: [...m.participants],
    }));
  }

  private async persistFocusPoints(
    earned: number,
    submittedWeekStart?: number
  ): Promise<number> {
    if (!this.companyId) return 0;
    const ref = doc(db, `companies/${this.companyId}`);
    const serializedSchedule =
      submittedWeekStart !== undefined ? this.serializeMeetings() : null;
    const result = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = (snap && (snap.data() as any)) || {};
      const current = Number.isFinite(Number(data.focusPoints))
        ? Math.max(0, Math.round(Number(data.focusPoints)))
        : 0;
      const delta = Math.max(0, Math.round(earned));
      const next = current + delta;
      const update: any = {
        focusPoints: next,
        lastFocusScore: this.focusScore,
        lastFocusHours: this.focusHours,
        lastFocusPointsEarned: delta,
        focusPointsUpdatedAt: serverTimestamp(),
      };
      if (submittedWeekStart !== undefined) {
        update.calendarSubmittedWeekStart = submittedWeekStart;
        update.calendarSubmittedAt = serverTimestamp();
        update.lastFocusScheduleWeekStart = submittedWeekStart;
        update.calendarScheduleWeekStart = submittedWeekStart;
        update.calendarSchedule = serializedSchedule;
      }
      tx.set(ref, update, { merge: true });
      return { current, next };
    });
    this.focusPoints = result.next;
    if (submittedWeekStart !== undefined) {
      this.storedWeekStart = submittedWeekStart;
      this.storedMeetings = this.cloneMeetings(this.meetings);
    }
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
    if (idx === -1) return fallbackEmployeeColor(id, this.palette);
    return this.employees[idx].color;
  }

  private applyCalendarLock(): void {
    const currentWeekStart = this.weekStart?.getTime() ?? null;
    this.calendarLocked =
      currentWeekStart !== null &&
      this.calendarSubmittedWeekStart !== null &&
      currentWeekStart === this.calendarSubmittedWeekStart;
  }

  private normalizeStoredMeeting(raw: any): CalendarMeeting | null {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id : null;
    const owner = typeof raw.owner === 'string' ? raw.owner : null;
    const participants = Array.isArray((raw as any).participants)
      ? (raw as any).participants.filter((p: any) => typeof p === 'string')
      : [];
    const dayIndex = Number((raw as any).dayIndex);
    const start = Number((raw as any).start);
    const end = Number((raw as any).end);
    if (!id || !owner) return null;
    if (!Number.isFinite(dayIndex) || dayIndex < 0 || dayIndex > 4) return null;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }
    return { id, owner, participants, dayIndex, start, end };
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
