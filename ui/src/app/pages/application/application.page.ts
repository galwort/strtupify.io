import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AlertController, LoadingController } from '@ionic/angular';
import { Router } from '@angular/router';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  collection,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';

export const app = initializeApp(environment.firebase);
export const db = getFirestore(app);

@Component({
  selector: 'app-application',
  templateUrl: './application.page.html',
  styleUrls: ['./application.page.scss'],
  standalone: false,
})
export class ApplicationPage implements OnInit {
  companyName: string = '';
  companyDescription: string = '';

  constructor(
    private http: HttpClient,
    private alertController: AlertController,
    private loadingController: LoadingController,
    private router: Router
  ) {}

  ngOnInit() {}

  async onSubmit() {
    const loading = await this.loadingController.create();
    await loading.present();

    if (!this.companyName || this.companyName.trim().length === 0) {
      await loading.dismiss();
      const alert = await this.alertController.create({
        header: 'Business Application Rejected',
        message: 'No company name listed',
        buttons: ['OK'],
      });
      await alert.present();
      return;
    }
    const cleanedName = this.companyName
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();
    const logoUrl = 'https://fa-strtupifyio.azurewebsites.net/api/logo';
    const logoBody = { input: this.companyDescription };

    this.http.post(logoUrl, logoBody, { responseType: 'text' }).subscribe({
      next: (logoResponse) => {
        const logoValue = logoResponse || '';
        const url = 'https://fa-strtupifyio.azurewebsites.net/api/jobs';
        const body = { company_description: this.companyDescription };

        this.http.post(url, body).subscribe({
          next: async (response: any) => {
            const docRef = doc(db, 'companies', cleanedName);
            await setDoc(docRef, {
              company_name: this.companyName,
              description: this.companyDescription,
              logo: logoValue,
              colors: '',
              created: serverTimestamp(),
              updated: serverTimestamp(),
            });

            if (Array.isArray(response.jobs)) {
              for (const role of response.jobs) {
                await addDoc(collection(db, `companies/${cleanedName}/roles`), {
                  title: role,
                  created: serverTimestamp(),
                  updated: serverTimestamp(),
                });
              }
            }

            await loading.dismiss();
            this.router.navigateByUrl(`/company/${cleanedName}`);
          },
          error: async () => {
            await loading.dismiss();
            this.presentErrorAlert(
              'An unexpected error occurred. Please try again.'
            );
          },
        });
      },
      error: async () => {
        await loading.dismiss();
        this.presentErrorAlert(
          'An unexpected error occurred while generating the logo.'
        );
      },
    });
  }

  async presentErrorAlert(errorMessage: string) {
    const alert = await this.alertController.create({
      header: 'Business Application Rejected',
      message: errorMessage,
      buttons: ['OK'],
    });
    await alert.present();
  }
}
