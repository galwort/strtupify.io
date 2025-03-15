import { Component, OnInit, Output, EventEmitter, NgZone } from '@angular/core';
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
import { FormsModule } from '@angular/forms';

export const app = initializeApp(environment.firebase);
export const db = getFirestore(app);

function generateResumeCount(openings: number, cap: number = 20): number {
  const maxMultiplier = 1.5 + (2.5 - 2.5 * (openings / cap));
  const multiplier = Math.random() * (Math.max(1.2, maxMultiplier) - 1.1) + 1.1;
  const resumes = Math.max(openings + 1, Math.round(openings * multiplier));
  return Math.min(resumes, cap);
}

@Component({
  selector: 'app-roles',
  templateUrl: './roles.component.html',
  styleUrls: ['./roles.component.scss'],
  imports: [CommonModule, FormsModule],
})
export class RolesComponent implements OnInit {
  @Output() loadingStateChange = new EventEmitter<{
    show: boolean;
    totalTasks: number;
    completedTasks: number;
  }>();
  roles: { id: string; title: string; count: number; skills?: string[] }[] = [];
  companyId: string = '';

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private zone: NgZone
  ) {}

  async ngOnInit() {
    let segments = this.router.url.split('/');
    this.companyId = segments.length > 2 ? segments[2] : '';
    if (!this.companyId) return;
    let querySnapshot = await getDocs(
      collection(db, 'companies/' + this.companyId + '/roles')
    );
    this.roles = querySnapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      title: docSnap.data()['title'],
      count: 0,
    }));
  }

  async fetchSkills(jobTitle: string): Promise<string[]> {
    const response = await fetch(
      'https://fa-strtupifyio.azurewebsites.net/api/skills',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_title: jobTitle }),
      }
    );
    const data = await response.json();
    return data.skills;
  }

  async screen() {
    if (!this.companyId) return;
    const filtered = this.roles.filter((r) => r.count > 0);
    let totalTasks = 0;
    for (const role of filtered) {
      totalTasks += 4;
      totalTasks += generateResumeCount(role.count);
    }
    let completedTasks = 0;
    this.loadingStateChange.emit({ show: true, totalTasks, completedTasks });
    const timestamp = new Date().toISOString();
    for (const role of filtered) {
      await this.delayStep(async () => {
        role.skills = await this.fetchSkills(role.title);
      });
      this.updateProgress(++completedTasks, totalTasks);
      await this.delayStep(async () => {
        await updateDoc(doc(db, `companies/${this.companyId}/roles`, role.id), {
          openings: role.count,
        });
      });
      this.updateProgress(++completedTasks, totalTasks);
      await this.delayStep(async () => {
        await updateDoc(doc(db, `companies/${this.companyId}/roles`, role.id), {
          skills: role.skills,
        });
      });
      this.updateProgress(++completedTasks, totalTasks);
      await this.delayStep(async () => {
        await updateDoc(doc(db, `companies/${this.companyId}/roles`, role.id), {
          updated: timestamp,
        });
      });
      this.updateProgress(++completedTasks, totalTasks);
      const resumeCount = generateResumeCount(role.count);
      for (let i = 0; i < resumeCount; i++) {
        await this.delayStep(async () => {
          await fetch('https://fa-strtupifyio.azurewebsites.net/api/resumes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              company: this.companyId,
              job_title: role.title,
            }),
          });
        });
        this.updateProgress(++completedTasks, totalTasks);
      }
    }
    this.loadingStateChange.emit({
      show: false,
      totalTasks: 0,
      completedTasks: 0,
    });
    alert('Resumé screening has begun!');
  }

  async delayStep(stepFn: () => Promise<void>) {
    await stepFn();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  updateProgress(done: number, total: number) {
    this.zone.run(() => {
      this.loadingStateChange.emit({
        show: true,
        totalTasks: total,
        completedTasks: done,
      });
    });
  }
}
