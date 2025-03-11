import { Component, OnInit } from '@angular/core';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
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

  constructor(private route: ActivatedRoute, private router: Router) {}

  async ngOnInit() {
    let segments = this.router.url.split('/');
    let companyId = segments.length > 2 ? segments[2] : '';
    if (!companyId) {
      return;
    }
    let querySnapshot = await getDocs(
      collection(db, 'companies/' + companyId + '/roles')
    );
    querySnapshot.forEach((docSnap) => {
      this.roles.push({
        id: docSnap.id,
        title: docSnap.data()['title'],
        count: 0,
      });
    });
  }
}
