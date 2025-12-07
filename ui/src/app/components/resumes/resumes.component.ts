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

    const temp: Employee[] = empSnap.docs.map((d) => {
      const data = d.data() as any;
      const avatarName = String(data?.avatar || '').trim();
      const gender = String(data?.gender || '').toLowerCase();
      return {
        ...(data || {}),
        id: d.id,
        skills: [] as Skill[],
        avatar: avatarName,
        gender,
        avatarUrl: buildAvatarUrl(avatarName, 'neutral'),
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
    this.applyRoleFilters();
    this.checkComplete();
    await this.ensureCurrentEmployeeSkillsLoaded();
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

  async hireEmployee() {
    if (!this.currentEmployee || this.autoHiring) return;
    await this.hireCandidate(this.currentEmployee);
    if (this.currentIndex >= this.employees.length)
      this.currentIndex = Math.max(0, this.employees.length - 1);
    this.checkComplete();
    await this.ensureCurrentEmployeeSkillsLoaded();
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
      this.currentIndex = idx;
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
      this.currentIndex++;
      await this.ensureCurrentEmployeeSkillsLoaded();
    }
  }

  async prevResume() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      await this.ensureCurrentEmployeeSkillsLoaded();
    }
  }
}



