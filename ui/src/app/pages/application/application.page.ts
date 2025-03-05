import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AlertController } from '@ionic/angular';

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
    private alertController: AlertController
  ) {}

  ngOnInit() {}

  async onSubmit() {
    if (!this.companyName || this.companyName.trim().length === 0) {
      const alert = await this.alertController.create({
        header: 'Business Application Rejected',
        message: 'No company name listed',
        buttons: ['OK'],
      });
      await alert.present();
      return;
    }
    const url = 'https://fa-strtupifyio.azurewebsites.net/api/jobs';
    const body = { company_description: this.companyDescription };
    this.http.post(url, body).subscribe({
      next: async (response: any) => {
        if (response.error) {
          await this.presentErrorAlert(response.error);
        } else {
          console.log(response);
        }
      },
      error: (err) => {
        console.error('Error:', err);
        this.presentErrorAlert(
          'An unexpected error occurred. Please try again.'
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
