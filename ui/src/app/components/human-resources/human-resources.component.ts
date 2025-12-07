import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { initializeApp, getApps } from 'firebase/app';
import {
  collection,
  getDocs,
  getFirestore,
  onSnapshot,
  QuerySnapshot,
  DocumentData,
  where,
  query,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { buildAvatarUrl } from 'src/app/utils/avatar';

interface EmployeeSkill {
  id: string;
  name: string;
  level: number;
}

interface EmployeeProfile {
  id: string;
  name: string;
  title: string;
  stress: number;
  status: 'Active' | 'Burnout';
  load: number;
  description: string;
  salary: number;
  avatarName: string;
  avatarUrl: string;
  gender?: string;
  skills: EmployeeSkill[];
}

const fbApp = getApps().length ? getApps()[0] : initializeApp(environment.firebase);
const db = getFirestore(fbApp);

@Component({
  selector: 'app-human-resources',
  standalone: true,
  templateUrl: './human-resources.component.html',
  styleUrls: ['./human-resources.component.scss'],
  imports: [CommonModule],
})
export class HumanResourcesComponent implements OnInit, OnDestroy {
  @Input() companyId = '';

  employees: EmployeeProfile[] = [];
  private unsub: (() => void) | null = null;
  private skillsToken = 0;

  ngOnInit(): void {
    if (!this.companyId) return;
    const ref = query(
      collection(db, `companies/${this.companyId}/employees`),
      where('hired', '==', true)
    );
    this.unsub = onSnapshot(ref, async (snap: QuerySnapshot<DocumentData>) => {
      const base = snap.docs
        .map((d) => {
          const data = (d.data() as any) || {};
          const stress = Math.max(0, Math.min(100, Number(data.stress || 0)));
          const status: 'Active' | 'Burnout' = String(data.status || 'Active') === 'Burnout' ? 'Burnout' : 'Active';
          const load = Math.max(0, Number(data.load || 0));
          const salaryRaw = Number(data.salary || 0);
          const salary = Number.isFinite(salaryRaw) ? Math.max(0, salaryRaw) : 0;
          const description = String(data.description || data.personality || '');
          const avatarName = String(data.avatar || data.photo || data.photoUrl || data.image || '');
          const avatarUrl = buildAvatarUrl(avatarName, 'neutral');
          const gender = String(data.gender || '').toLowerCase() || undefined;
          return {
            id: d.id,
            name: String(data.name || ''),
            title: String(data.title || ''),
            stress,
            status,
            load,
            salary,
            description,
            avatarName,
            avatarUrl,
            gender,
            skills: [],
          } as EmployeeProfile;
        })
        .sort((a, b) => b.stress - a.stress);

      this.employees = base;
      await this.loadSkills(base);
    });
  }

  ngOnDestroy(): void {
    if (this.unsub) this.unsub();
  }

  statusLabel(emp: EmployeeProfile): string {
    if (emp.stress <= 10) return 'Has Bandwidth';
    if (emp.stress >= 90) return 'Burnout';
    return 'Active';
  }

  statusClass(emp: EmployeeProfile): 'bandwidth' | 'active' | 'burnout' {
    if (emp.stress <= 10) return 'bandwidth';
    if (emp.stress >= 90) return 'burnout';
    return 'active';
  }

  private async loadSkills(list: EmployeeProfile[]) {
    if (!this.companyId || !list.length) return;
    const token = ++this.skillsToken;
    const results = await Promise.all(
      list.map(async (emp) => {
        try {
          const snap = await getDocs(collection(db, `companies/${this.companyId}/employees/${emp.id}/skills`));
          const skills: EmployeeSkill[] = snap.docs
            .map((d) => {
              const data = (d.data() as any) || {};
              const levelRaw = Number(data.level || 0);
              const level = Number.isFinite(levelRaw) ? Math.max(1, Math.min(10, levelRaw)) : 1;
              const name = String(data.skill || '').trim();
              return name
                ? {
                    id: d.id,
                    name,
                    level,
                  }
                : null;
            })
            .filter((s): s is EmployeeSkill => !!s);
          return { id: emp.id, skills };
        } catch {
          return { id: emp.id, skills: [] as EmployeeSkill[] };
        }
      })
    );
    if (token !== this.skillsToken) return;
    const skillsById = new Map(results.map((r) => [r.id, r.skills]));
    this.employees = this.employees.map((emp) => {
      const skills = skillsById.get(emp.id);
      return skills ? { ...emp, skills } : emp;
    });
  }
}
