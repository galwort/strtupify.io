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
  imports: [CommonModule],
})
export class ResumesComponent implements OnInit {
  @Output() hiringFinished = new EventEmitter<void>();

  companyId = '';
  employees: Employee[] = [];
  roles: Role[] = [];
  currentIndex = 0;
  private doneEmitted = false;

  constructor(private router: Router) {}

  async ngOnInit() {
    const segments = this.router.url.split('/');
    this.companyId = segments.length > 2 ? segments[2] : '';
    if (!this.companyId) return;

    const rolesSnap = await getDocs(
      collection(db, `companies/${this.companyId}/roles`)
    );
    this.roles = rolesSnap.docs.map(
      (d) => ({ id: d.id, ...d.data() } as Role)
    );

    const empSnap = await getDocs(
      collection(db, `companies/${this.companyId}/employees`)
    );

    const temp: Employee[] = empSnap.docs.map((d) => {
      const data = d.data() as Omit<Employee, 'id' | 'skills'>;
      return { ...data, id: d.id, skills: [] as Skill[] };
    });

    for (const e of temp) {
      const sSnap = await getDocs(
        collection(db, `companies/${this.companyId}/employees/${e.id}/skills`)
      );
      e.skills = sSnap.docs
        .map((s) => {
          const sd = s.data() as Omit<Skill, 'id'>;
          return { ...sd, id: s.id } as Skill;
        })
        .sort((a, b) => a.skill.localeCompare(b.skill));
    }

    this.employees = temp.filter((x) => !x.hired);
    this.checkComplete();
  }

  get rolesWithOpenings() {
    return this.roles.filter((r) => typeof r.openings === 'number' && r.openings > 0);
  }

  get currentEmployee() {
    return this.employees[this.currentIndex];
  }

  get currentEmployeeSkills() {
    return this.currentEmployee ? this.currentEmployee.skills : [];
  }

  async hireEmployee() {
    if (!this.currentEmployee) return;

    const role = this.roles.find(
      (r) => r.title === this.currentEmployee.title
    );
    if (role && role.openings > 0) {
      role.openings -= 1;
      await updateDoc(
        doc(db, 'companies', this.companyId, 'roles', role.id),
        { openings: role.openings }
      );
    }

    await updateDoc(
      doc(db, 'companies', this.companyId, 'employees', this.currentEmployee.id),
      { hired: true }
    );

    this.employees.splice(this.currentIndex, 1);
    if (this.currentIndex >= this.employees.length)
      this.currentIndex = this.employees.length - 1;

    console.log('openings left:', this.roles.map(r => `${r.title}:${r.openings}`));
    this.checkComplete();
  }

  nextResume() {
    if (this.currentIndex < this.employees.length - 1) this.currentIndex++;
  }

  prevResume() {
    if (this.currentIndex > 0) this.currentIndex--;
  }

  private checkComplete() {
    const stillNeeded = this.roles.filter(
      (r) => typeof r.openings === 'number' && r.openings > 0
    );
    if (!this.doneEmitted && stillNeeded.length === 0) {
      this.doneEmitted = true;
      this.hiringFinished.emit();
    }
  }
}
