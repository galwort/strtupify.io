import { Component, OnInit, Output, EventEmitter } from '@angular/core';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  updateDoc,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { buildAvatarUrl } from 'src/app/utils/avatar';
import {
  EMPLOYEE_COLOR_PALETTE,
  assignEmployeeColors,
  fallbackEmployeeColor,
  normalizeEmployeeColor,
} from 'src/app/utils/employee-colors';

export const app = initializeApp(environment.firebase);
export const db = getFirestore(app);

interface Skill {
  id: string;
  skill: string;
  level: number;
}

interface Employee {
  id: string;
  name: string;
  title: string;
  salary: number;
  personality: string;
  hired: boolean;
  skills: Skill[];
   gender?: string;
   avatar?: string;
   avatarUrl?: string;
  color?: string;
}

interface Role {
  id: string;
  title: string;
  openings: number;
  skills?: string[];
}

@Component({
  selector: 'app-resumes',
  templateUrl: './resumes.component.html',
  styleUrls: ['./resumes.component.scss'],
  standalone: true,
  imports: [CommonModule],
})
export class ResumesComponent implements OnInit {
  @Output() hiringFinished = new EventEmitter<void>();

  companyId = '';
  employees: Employee[] = [];
  roles: Role[] = [];
  currentIndex = 0;
  private doneEmitted = false;
  private hiredCount = 0;
  autoHiring = false;
  private roleDisplaySnapshot: Role[] = [];
  private frozenEmployee: Employee | null = null;
  private freezeDisplay = false;
  private avatarColorCache = new Map<string, string>();
  private pendingAvatarFetches = new Map<string, Promise<void>>();
  displayedAvatarUrl = '';

  constructor(private router: Router) {}

  async ngOnInit() {
    const segments = this.router.url.split('/');
    this.companyId = segments.length > 2 ? segments[2] : '';
    if (!this.companyId) return;

    const rolesSnap = await getDocs(
      collection(db, `companies/${this.companyId}/roles`)
    );
    this.roles = rolesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Role));

    const empSnap = await getDocs(
      collection(db, `companies/${this.companyId}/employees`)
    );

    const colorMap = assignEmployeeColors(
      empSnap.docs,
      this.companyId || 'color-seed',
      EMPLOYEE_COLOR_PALETTE
    );
    void this.persistEmployeeColors(empSnap.docs, colorMap);

    const temp: Employee[] = empSnap.docs.map((d) => {
      const data = d.data() as any;
      const avatarName = String(data?.avatar || '').trim();
      const gender = String(data?.gender || '').toLowerCase();
      const color =
        colorMap.get(d.id) ||
        normalizeEmployeeColor(data?.calendarColor || data?.color) ||
        fallbackEmployeeColor(d.id);
      const baseUrl = buildAvatarUrl(avatarName, 'neutral');
      return {
        ...(data || {}),
        id: d.id,
        skills: [] as Skill[],
        avatar: avatarName,
        gender,
        color,
        avatarUrl: baseUrl,
      } as Employee;
    });

    this.hiredCount = temp.filter((e) => e.hired).length;

    for (const e of temp) {
      const sSnap = await getDocs(
        collection(db, `companies/${this.companyId}/employees/${e.id}/skills`)
      );
      e.skills = sSnap.docs
        .map((s) => ({ ...(s.data() as Omit<Skill, 'id'>), id: s.id }))
        .sort((a, b) => a.skill.localeCompare(b.skill));
    }

    this.employees = temp.filter((x) => !x.hired);
    this.employees.forEach((e) => this.colorizeAvatar(e));
    this.applyRoleFilters();
    this.checkComplete();
    await this.ensureCurrentEmployeeSkillsLoaded();
    this.refreshDisplayedAvatar();
  }

  get rolesWithOpenings() {
    return this.roles.filter((r) => r.openings > 0);
  }

  get visibleRoles() {
    return this.roleDisplaySnapshot.length
      ? this.roleDisplaySnapshot
      : this.rolesWithOpenings;
  }

  get roleSelectionEnabled() {
    return !this.autoHiring && this.visibleRoles.length > 1;
  }

  get currentEmployee() {
    return this.employees[this.currentIndex];
  }

  get displayedEmployee() {
    if ((this.autoHiring || this.freezeDisplay) && this.frozenEmployee)
      return this.frozenEmployee;
    return this.currentEmployee;
  }

  get displayedEmployeeSkills() {
    return this.displayedEmployee ? this.displayedEmployee.skills : [];
  }

  get currentAvatarUrl(): string {
    return this.displayedAvatarUrl || this.displayedEmployee?.avatarUrl || '';
  }

  async hireEmployee() {
    if (!this.currentEmployee || this.autoHiring) return;
    await this.hireCandidate(this.currentEmployee);
    if (this.currentIndex >= this.employees.length)
      this.currentIndex = Math.max(0, this.employees.length - 1);
    this.checkComplete();
    await this.ensureCurrentEmployeeSkillsLoaded();
    this.refreshDisplayedAvatar();
  }

  async automateHiring() {
    if (
      this.autoHiring ||
      !this.companyId ||
      !this.rolesWithOpenings.length ||
      !this.employees.length
    )
      return;
    this.autoHiring = true;
    this.freezeDisplay = true;
    await this.ensureCurrentEmployeeSkillsLoaded();
    this.freezeCurrentResume();
    this.roleDisplaySnapshot = this.rolesWithOpenings.map((r) => ({ ...r }));
    try {
      const available: Employee[] = [...this.employees];
      for (const role of this.roles.filter((r) => r.openings > 0)) {
        while (role.openings > 0) {
          const best = this.findBestCandidateForRole(available, role);
          if (!best) break;
          await this.hireCandidate(best, role);
          const idx = available.findIndex((e) => e.id === best.id);
          if (idx >= 0) available.splice(idx, 1);
        }
      }
    } finally {
      this.autoHiring = false;
      if (this.currentIndex >= this.employees.length)
        this.currentIndex = Math.max(0, this.employees.length - 1);
      const finished = this.checkComplete();
      if (!finished) {
        this.roleDisplaySnapshot = [];
        this.freezeDisplay = false;
        this.frozenEmployee = null;
      }
      await this.ensureCurrentEmployeeSkillsLoaded();
    }
  }

  async selectRole(roleTitle: string) {
    if (!this.roleSelectionEnabled) return;
    const idx = this.employees.findIndex((e) => e.title === roleTitle);
    if (idx >= 0 && idx !== this.currentIndex) {
      this.displayedAvatarUrl = '';
      this.currentIndex = idx;
      this.refreshDisplayedAvatar();
      await this.ensureCurrentEmployeeSkillsLoaded();
    }
  }

  private applyRoleFilters() {
    const openTitles = new Set(
      this.roles.filter((r) => r.openings > 0).map((r) => r.title)
    );
    this.employees = this.employees.filter(
      (e) => openTitles.has(e.title) && !e.hired
    );
    if (this.currentIndex < 0) this.currentIndex = 0;
    if (this.employees.length === 0) this.currentIndex = 0;
    this.refreshDisplayedAvatar();
  }

  private checkComplete(): boolean {
    const stillNeeded = this.roles.some((r) => r.openings > 0);
    const enoughHires = this.hiredCount >= 2;
    const finished = !stillNeeded && enoughHires;
    if (finished && !this.doneEmitted) {
      this.doneEmitted = true;
      this.hiringFinished.emit();
    }
    return finished;
  }

  private freezeCurrentResume() {
    const src = this.currentEmployee;
    if (!src) {
      this.frozenEmployee = null;
      return;
    }
    const clonedSkills = (src.skills || []).map((s) => ({ ...s }));
    this.frozenEmployee = { ...src, skills: clonedSkills };
  }

  private buildSkillMap(employee: Employee): Map<string, number> {
    return new Map(
      (employee.skills || []).map((s) => [s.skill.toLowerCase(), s.level])
    );
  }

  private scoreCandidateForRole(candidate: Employee, role: Role): number {
    const skillMap = this.buildSkillMap(candidate);
    const required = (role.skills || []).map((s) => s.toLowerCase());
    if (required.length) {
      let matched = 0;
      let matchedLevelSum = 0;
      for (const skill of required) {
        const level = skillMap.get(skill) || 0;
        if (level > 0) matched++;
        matchedLevelSum += level;
      }
      const coverage = matched / required.length;
      const avgMatched = matched ? matchedLevelSum / matched : 0;
      const salaryPenalty = candidate.salary ? candidate.salary / 1000000 : 0;
      return coverage * 100 + matchedLevelSum + avgMatched - salaryPenalty;
    }
    const total = candidate.skills.reduce((sum, s) => sum + s.level, 0);
    const avg = candidate.skills.length ? total / candidate.skills.length : 0;
    const salaryPenalty = candidate.salary ? candidate.salary / 1000000 : 0;
    return total + avg - salaryPenalty;
  }

  private findBestCandidateForRole(
    candidates: Employee[],
    role: Role
  ): Employee | null {
    const matches = candidates.filter(
      (c) => c.title === role.title && !c.hired
    );
    if (!matches.length) return null;
    let best = matches[0];
    let bestScore = this.scoreCandidateForRole(best, role);
    for (let i = 1; i < matches.length; i++) {
      const score = this.scoreCandidateForRole(matches[i], role);
      if (score > bestScore) {
        best = matches[i];
        bestScore = score;
      }
    }
    return best;
  }

  private async hireCandidate(
    employee: Employee,
    roleOverride?: Role
  ): Promise<void> {
    const role =
      roleOverride || this.roles.find((r) => r.title === employee.title);
    if (role && role.openings > 0) {
      role.openings -= 1;
      await updateDoc(doc(db, 'companies', this.companyId, 'roles', role.id), {
        openings: role.openings,
      });
    }

    await updateDoc(
      doc(db, 'companies', this.companyId, 'employees', employee.id),
      { hired: true }
    );

    this.hiredCount++;
    employee.hired = true;

    this.employees = this.employees.filter((e) => e.id !== employee.id);
    this.applyRoleFilters();
    this.refreshDisplayedAvatar();
  }

  private async ensureCurrentEmployeeSkillsLoaded(): Promise<void> {
    const e = this.currentEmployee;
    if (!e || (e.skills && e.skills.length)) return;
    const sSnap = await getDocs(
      collection(db, `companies/${this.companyId}/employees/${e.id}/skills`)
    );
    e.skills = sSnap.docs
      .map((s) => ({ ...(s.data() as Omit<Skill, 'id'>), id: s.id }))
      .sort((a, b) => a.skill.localeCompare(b.skill));
  }

  async nextResume() {
    if (this.currentIndex < this.employees.length - 1) {
      this.displayedAvatarUrl = '';
      this.currentIndex++;
      this.refreshDisplayedAvatar();
      await this.ensureCurrentEmployeeSkillsLoaded();
    }
  }

  async prevResume() {
    if (this.currentIndex > 0) {
      this.displayedAvatarUrl = '';
      this.currentIndex--;
      this.refreshDisplayedAvatar();
      await this.ensureCurrentEmployeeSkillsLoaded();
    }
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

  private avatarCacheKey(emp: Employee, color: string): string {
    return `${emp.avatar || ''}|${color || ''}`;
  }

  private refreshDisplayedAvatar(): void {
    const emp = this.displayedEmployee;
    this.displayedAvatarUrl = emp?.avatarUrl || '';
  }

  private async colorizeAvatar(emp: Employee): Promise<void> {
    const color = normalizeEmployeeColor(emp.color);
    if (!color || !emp.avatar) return;
    const cacheKey = this.avatarCacheKey(emp, color);
    const cached = this.avatarColorCache.get(cacheKey);
    if (cached) {
      this.updateEmployeeAvatar(emp.id, cached);
      return;
    }
    if (this.pendingAvatarFetches.has(cacheKey)) {
      await this.pendingAvatarFetches.get(cacheKey);
      return;
    }
    const task = (async () => {
      try {
        const baseUrl = buildAvatarUrl(emp.avatar || '', 'neutral');
        if (!baseUrl) return;
        const resp = await fetch(baseUrl);
        if (!resp.ok) throw new Error(`avatar_status_${resp.status}`);
        const svg = await resp.text();
        const updated = svg.replace(/#262E33/gi, color);
        const uri = this.svgToDataUri(updated);
        this.avatarColorCache.set(cacheKey, uri);
        this.updateEmployeeAvatar(emp.id, uri);
      } catch (err) {
        console.error('Failed to recolor avatar', err);
      } finally {
        this.pendingAvatarFetches.delete(cacheKey);
      }
    })();
    this.pendingAvatarFetches.set(cacheKey, task);
    await task;
  }

  private updateEmployeeAvatar(empId: string, url: string): void {
    this.employees = this.employees.map((e) =>
      e.id === empId ? { ...e, avatarUrl: url } : e
    );
    if (this.frozenEmployee && this.frozenEmployee.id === empId) {
      this.frozenEmployee = { ...this.frozenEmployee, avatarUrl: url };
    }
    if (this.displayedEmployee && this.displayedEmployee.id === empId) {
      this.displayedAvatarUrl = url;
    }
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



