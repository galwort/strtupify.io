import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AlertController, LoadingController } from '@ionic/angular';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
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
    private loadingController: LoadingController
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
    const logoUrl = 'https://fa-strtupifyio.azurewebsites.net/api/logo';
    const logoBody = { input: this.companyDescription };
    this.http.post(logoUrl, logoBody).subscribe({
      next: (logoResponse) => {
        const logoValue = logoResponse || '';
        const url = 'https://fa-strtupifyio.azurewebsites.net/api/jobs';
        const body = { company_description: this.companyDescription };
        this.http.post(url, body).subscribe({
          next: async (response) => {
            await addDoc(collection(db, 'company'), {
              company: this.companyName,
              company_description: this.companyDescription,
              logo: logoValue,
              colors: '',
              created: serverTimestamp(),
              updated: serverTimestamp(),
            });
            await loading.dismiss();
            if ((response as any).error) {
              await this.presentErrorAlert((response as any).error);
            } else {
              console.log(response);
            }
          },
          error: async (err) => {
            await loading.dismiss();
            console.error(err);
            this.presentErrorAlert(
              'An unexpected error occurred. Please try again.'
            );
          },
        });
      },
      error: async (err) => {
        await loading.dismiss();
        console.error(err);
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
