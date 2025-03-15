import { Component, OnInit } from '@angular/core';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  updateDoc,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';

export const app = initializeApp(environment.firebase);
export const db = getFirestore(app);

@Component({
  selector: 'app-resumes',
  templateUrl: './resumes.component.html',
  styleUrls: ['./resumes.component.scss'],
  imports: [CommonModule],
})
export class ResumesComponent implements OnInit {
  companyId: string = '';
  employees: any[] = [];
  currentIndex = 0;
  roles: any[] = [];

  constructor(private route: ActivatedRoute, private router: Router) {}

  async ngOnInit() {
    let segments = this.router.url.split('/');
    this.companyId = segments.length > 2 ? segments[2] : '';
    if (!this.companyId) return;
    let rolesQuery = await getDocs(
      collection(db, 'companies/' + this.companyId + '/roles')
    );
    this.roles = rolesQuery.docs.map((r) => ({ id: r.id, ...r.data() }));
    let employeesQuery = await getDocs(
      collection(db, 'companies/' + this.companyId + '/employees')
    );
    let employeesData: { id: string; skills: any[]; [key: string]: any }[] =
      employeesQuery.docs.map((e) => ({
        id: e.id,
        skills: [],
        ...e.data(),
      }));
    for (let e of employeesData) {
      let skillsSnapshot = await getDocs(
        collection(
          db,
          'companies/' + this.companyId + '/employees/' + e.id + '/skills'
        )
      );
      e.skills = skillsSnapshot.docs.map((s) => ({ id: s.id, ...s.data() }));
    }
    this.employees = employeesData.filter((e) => e['hired'] === false);
  }

  get currentEmployee() {
    return this.employees[this.currentIndex];
  }

  get currentEmployeeSkills() {
    return this.currentEmployee ? this.currentEmployee.skills || [] : [];
  }

  async hireEmployee() {
    if (!this.currentEmployee) return;
    let role = this.roles.find((r) => r.title === this.currentEmployee.title);
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
      {
        hired: true,
      }
    );
    this.employees.splice(this.currentIndex, 1);
    if (this.currentIndex >= this.employees.length) {
      this.currentIndex = this.employees.length - 1;
    }
  }

  nextResume() {
    if (this.currentIndex < this.employees.length - 1) {
      this.currentIndex++;
    }
  }

  prevResume() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
    }
  }
}
