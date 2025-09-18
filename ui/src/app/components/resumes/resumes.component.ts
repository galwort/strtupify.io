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
}

interface Role {
  id: string;
  title: string;
  openings: number;
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
      const data = d.data() as Omit<Employee, 'id' | 'skills'>;
      return { ...data, id: d.id, skills: [] as Skill[] };
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
  }

  get rolesWithOpenings() {
    return this.roles.filter((r) => r.openings > 0);
  }

  get currentEmployee() {
    return this.employees[this.currentIndex];
  }

  get currentEmployeeSkills() {
    return this.currentEmployee ? this.currentEmployee.skills : [];
  }

  async hireEmployee() {
    if (!this.currentEmployee) return;

    const role = this.roles.find((r) => r.title === this.currentEmployee.title);
    if (role && role.openings > 0) {
      role.openings -= 1;
      await updateDoc(doc(db, 'companies', this.companyId, 'roles', role.id), {
        openings: role.openings,
      });
    }

    await updateDoc(
      doc(
        db,
        'companies',
        this.companyId,
        'employees',
        this.currentEmployee.id
      ),
      { hired: true }
    );

    this.hiredCount++;

    this.employees.splice(this.currentIndex, 1);
    this.applyRoleFilters();
    if (this.currentIndex >= this.employees.length)
      this.currentIndex = this.employees.length - 1;
    this.checkComplete();
  }

  nextResume() {
    if (this.currentIndex < this.employees.length - 1) this.currentIndex++;
  }

  prevResume() {
    if (this.currentIndex > 0) this.currentIndex--;
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

  private checkComplete() {
    const stillNeeded = this.roles.some((r) => r.openings > 0);
    const enoughHires = this.hiredCount >= 2;
    if (!stillNeeded && enoughHires && !this.doneEmitted) {
      this.doneEmitted = true;
      this.hiringFinished.emit();
    }
  }
}
