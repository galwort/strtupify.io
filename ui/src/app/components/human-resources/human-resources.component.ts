import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { initializeApp, getApps } from 'firebase/app';
import {
  collection,
  getFirestore,
  onSnapshot,
  QuerySnapshot,
  DocumentData,
  where,
  query,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';

interface EmployeeStress {
  id: string;
  name: string;
  title: string;
  stress: number;
  status: 'Active' | 'Burnout';
  load: number;
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

  employees: EmployeeStress[] = [];
  private unsub: (() => void) | null = null;

  ngOnInit(): void {
    if (!this.companyId) return;
    const ref = query(
      collection(db, `companies/${this.companyId}/employees`),
      where('hired', '==', true)
    );
    this.unsub = onSnapshot(ref, (snap: QuerySnapshot<DocumentData>) => {
      this.employees = snap.docs
        .map((d) => {
          const data = (d.data() as any) || {};
          const stress = Math.max(0, Math.min(100, Number(data.stress || 0)));
          const status: 'Active' | 'Burnout' = String(data.status || 'Active') === 'Burnout' ? 'Burnout' : 'Active';
          const load = Math.max(0, Number(data.load || 0));
          return {
            id: d.id,
            name: String(data.name || ''),
            title: String(data.title || ''),
            stress,
            status,
            load,
          } as EmployeeStress;
        })
        .sort((a, b) => b.stress - a.stress);
    });
  }

  ngOnDestroy(): void {
    if (this.unsub) this.unsub();
  }

  statusLabel(emp: EmployeeStress): string {
    if (emp.stress <= 10) return 'Has Bandwidth';
    if (emp.stress >= 90) return 'Burnout';
    return 'Active';
  }

  statusClass(emp: EmployeeStress): 'bandwidth' | 'active' | 'burnout' {
    if (emp.stress <= 10) return 'bandwidth';
    if (emp.stress >= 90) return 'burnout';
    return 'active';
  }

}
