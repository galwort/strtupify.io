import {
  Component,
  EnvironmentInjector,
  OnDestroy,
  OnInit,
  runInInjectionContext,
} from '@angular/core';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import firebase from 'firebase/compat/app';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { of, Subscription } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

interface AccountProfile {
  email?: string | null;
  username?: string | null;
  loginUsername?: string | null;
  companyIds?: string[];
  createdAt?: any;
}

interface AccountViewModel {
  user: firebase.User;
  profile: AccountProfile | null;
}

@Component({
  selector: 'app-account',
  templateUrl: './account.page.html',
  styleUrls: ['./account.page.scss'],
  standalone: false,
})
export class AccountPage implements OnInit, OnDestroy {
  viewModel: AccountViewModel | null = null;
  loading = true;
  errorMessage = '';
  signingOut = false;

  private authSub: Subscription | null = null;
  private profileSub: Subscription | null = null;

  constructor(
    private afAuth: AngularFireAuth,
    private firestore: AngularFirestore,
    private authService: AuthService,
    private router: Router,
    private environmentInjector: EnvironmentInjector
  ) {}

  ngOnInit(): void {
    this.authSub = this.afAuth.authState.subscribe((user) => {
      if (!user) {
        this.loading = false;
        this.viewModel = null;
        this.errorMessage = '';
        this.teardownProfile();
        this.router.navigate(['/login']);
        return;
      }

      this.bindProfile(user);
    });
  }

  ngOnDestroy(): void {
    if (this.authSub) {
      this.authSub.unsubscribe();
      this.authSub = null;
    }
    this.teardownProfile();
  }

  async signOut() {
    if (this.signingOut) return;
    this.signingOut = true;
    this.errorMessage = '';
    try {
      await this.authService.logout();
      await this.router.navigate(['/login']);
    } catch (error: any) {
      console.error(error);
      this.errorMessage =
        error?.message || 'Failed to sign out. Please try again later.';
    } finally {
      this.signingOut = false;
    }
  }

  private bindProfile(user: firebase.User) {
    this.teardownProfile();
    this.loading = true;
    this.errorMessage = '';

    const profileDoc = runInInjectionContext(
      this.environmentInjector,
      () => this.firestore.doc<AccountProfile>(`users/${user.uid}`)
    );

    this.profileSub = profileDoc
      .valueChanges()
      .pipe(
        map((profile) => profile || null),
        catchError((error) => {
          console.error('Failed to load account', error);
          this.errorMessage =
            'Unable to load your account right now. Please try again later.';
          return of(null);
        })
      )
      .subscribe((profile) => {
        this.viewModel = { user, profile };
        this.loading = false;
      });
  }

  private teardownProfile() {
    if (this.profileSub) {
      this.profileSub.unsubscribe();
      this.profileSub = null;
    }
  }
}
