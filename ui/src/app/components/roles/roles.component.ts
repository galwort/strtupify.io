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
import { FormsModule } from '@angular/forms';

export const app = initializeApp(environment.firebase);
export const db = getFirestore(app);

@Component({
  selector: 'app-roles',
  templateUrl: './roles.component.html',
  styleUrls: ['./roles.component.scss'],
  imports: [CommonModule, FormsModule],
})
export class RolesComponent implements OnInit {
  roles: { id: string; title: string; count: number }[] = [];
  companyId: string = '';

  constructor(private route: ActivatedRoute, private router: Router) {}

  async ngOnInit() {
    let segments = this.router.url.split('/');
    this.companyId = segments.length > 2 ? segments[2] : '';
    if (!this.companyId) {
      return;
    }

    let querySnapshot = await getDocs(
      collection(db, 'companies/' + this.companyId + '/roles')
    );

    this.roles = querySnapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      title: docSnap.data()['title'],
      count: 0,
    }));
  }

  async screen() {
    if (!this.companyId) return;

    const timestamp = new Date().toISOString();

    for (let role of this.roles) {
      const roleRef = doc(db, `companies/${this.companyId}/roles`, role.id);
      await updateDoc(roleRef, {
        openings: role.count,
        updated: timestamp,
      });
    }

    alert('Resumé screening has begun!');
  }
}
