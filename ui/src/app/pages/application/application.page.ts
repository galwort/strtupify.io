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
  getDoc,
  serverTimestamp,
  updateDoc,
  arrayUnion,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { firstValueFrom } from 'rxjs';
import { getAuth } from 'firebase/auth';

export const app = initializeApp(environment.firebase);
export const db = getFirestore(app);
const auth = getAuth(app);

@Component({
  selector: 'app-application',
  templateUrl: './application.page.html',
  styleUrls: ['./application.page.scss'],
  standalone: false,
})
export class ApplicationPage implements OnInit {
  companyName: string = '';
  companyDescription: string = '';
  showDecision = false;
  logoValue: string = '';
  fundingDecision: { approved: boolean; amount: number; grace_period_days: number; first_payment: number } | null = null;
  private pendingRoles: string[] = [];
  private originalApplicationText: string = '';

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

    try {
      const baseDescription = (this.companyDescription || '').trim();
      const normalizedBase = baseDescription.replace(/^Using the power of AI,\s*/i, '').trim();
      if (!this.originalApplicationText) {
        this.originalApplicationText = normalizedBase || baseDescription;
      }

      const logoUrl = 'https://fa-strtupifyio.azurewebsites.net/api/logo';
      const logoBody = { input: this.companyDescription };
      const logoResponse = await firstValueFrom(this.http.post(logoUrl, logoBody, { responseType: 'text' as 'json' }));
      this.logoValue = (logoResponse as unknown as string) || '';

      const fundingUrl = 'https://fa-strtupifyio.azurewebsites.net/api/funding';
      const jobsUrl = 'https://fa-strtupifyio.azurewebsites.net/api/jobs';

      const [funding, jobs] = await Promise.all([
        firstValueFrom(this.http.post<any>(fundingUrl, { company_description: this.companyDescription })),
        firstValueFrom(this.http.post<any>(jobsUrl, { company_description: this.companyDescription })),
      ]);


      this.pendingRoles = Array.isArray(jobs?.jobs) ? jobs.jobs : [];
      const insufficientRoles = !this.pendingRoles || this.pendingRoles.length === 0;

      const computedDecision = {
        approved: !!funding?.approved && !insufficientRoles,
        amount: Number(funding?.amount || 0),
        grace_period_days: Number(funding?.grace_period_days || 0),
        first_payment: Number(funding?.first_payment || 0),
      };
      if (insufficientRoles) {

        computedDecision.approved = false;
        computedDecision.amount = 0;
        computedDecision.grace_period_days = 0;
        computedDecision.first_payment = 0;
      }

      this.fundingDecision = computedDecision;
      this.showDecision = true;
    } catch (e) {
      this.presentErrorAlert('An unexpected error occurred. Please try again.');
    } finally {
      await loading.dismiss();
    }
  }

  async checkIfCompanyExists(companyId: string): Promise<boolean> {
    const docRef = doc(db, 'companies', companyId);
    const docSnap = await getDoc(docRef);
    return docSnap.exists();
  }

  async presentErrorAlert(errorMessage: string) {
    const alert = await this.alertController.create({
      header: 'Business Application Rejected',
      message: errorMessage,
      buttons: ['OK'],
    });
    await alert.present();
  }

  editApplication() {
    this.showDecision = false;
  }

  newApplication() {
    this.companyName = '';
    this.companyDescription = '';
    this.logoValue = '';
    this.fundingDecision = null;
    this.showDecision = false;
    this.pendingRoles = [];
    this.originalApplicationText = '';
  }

  generateHighPotential() {
    const base = (this.originalApplicationText || this.companyDescription || '')
      .replace(/^Using the power of AI,\s*/i, '')
      .trim();
    const highPotential = base ? `Using the power of AI, ${base}` : 'Using the power of AI';
    this.companyDescription = highPotential;
    this.showDecision = false;
    this.fundingDecision = null;
  }

  async acceptLoan() {
    const loading = await this.loadingController.create();
    await loading.present();
    try {
      const user = auth.currentUser;
      if (!user) {
        throw new Error('You must be signed in to accept funding.');
      }

      let cleanedName = this.companyName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      let uniqueName = cleanedName || 'company';
      let counter = 2;
      while (await this.checkIfCompanyExists(uniqueName)) {
        uniqueName = `${cleanedName}${counter}`;
        counter++;
      }
      const docRef = doc(db, 'companies', uniqueName);
      await setDoc(docRef, {
        company_name: this.companyName,
        description: this.companyDescription,
        logo: this.logoValue,
        colors: '',
        funding: this.fundingDecision,
        speed: 1,
        simTime: Date.now(),
        created: serverTimestamp(),
        updated: serverTimestamp(),
        ownerId: user.uid,
        ownerEmail: user.email || null,
        memberIds: [user.uid],
      });
      await setDoc(
        doc(db, 'users', user.uid),
        {
          companyIds: arrayUnion(uniqueName),
        },
        { merge: true }
      );
      const roles = Array.isArray(this.pendingRoles) ? this.pendingRoles : [];
      for (const role of roles) {
        await addDoc(collection(db, `companies/${uniqueName}/roles`), {
          title: role,
          created: serverTimestamp(),
          updated: serverTimestamp(),
        });
      }
      await loading.dismiss();
      this.router.navigateByUrl(`/company/${uniqueName}`);
    } catch (e) {
      await loading.dismiss();
      this.presentErrorAlert('An unexpected error occurred. Please try again.');
    }
  }
}
