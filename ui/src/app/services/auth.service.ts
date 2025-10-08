import { EnvironmentInjector, Injectable, runInInjectionContext } from '@angular/core';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { Observable, firstValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';
import { AngularFirestore } from '@angular/fire/compat/firestore';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  constructor(
    private afAuth: AngularFireAuth,
    private firestore: AngularFirestore,
    private environmentInjector: EnvironmentInjector
  ) {}

  async login(
    email: string,
    password: string
  ): Promise<firebase.auth.UserCredential> {
    const credential = await this.afAuth.signInWithEmailAndPassword(
      email,
      password
    );
    if (credential.user) {
      await this.createUserIfNotExists(credential.user);
    }
    return credential;
  }

  async register(
    email: string,
    password: string,
    displayName?: string | null
  ): Promise<firebase.auth.UserCredential> {
    const credential = await this.afAuth.createUserWithEmailAndPassword(
      email,
      password
    );

    const user = credential.user;
    if (user) {
      const nextDisplayName = displayName?.trim() || user.displayName || null;
      if (nextDisplayName && user.displayName !== nextDisplayName) {
        await user.updateProfile({ displayName: nextDisplayName });
      }
      await this.createUserIfNotExists(user, nextDisplayName || undefined);
    }

    return credential;
  }

  async loginWithGoogle(): Promise<void> {
    const provider = new firebase.auth.GoogleAuthProvider();
    const credential = await this.afAuth.signInWithPopup(provider);
    const user = credential.user;

    if (user) {
      await this.createUserIfNotExists(user);
    }
  }

  async createUserIfNotExists(
    user: firebase.User,
    fallbackDisplayName?: string
  ): Promise<void> {
    const userRef = runInInjectionContext(this.environmentInjector, () =>
      this.firestore.doc(`users/${user.uid}`)
    );

    try {
      const doc = await firstValueFrom(userRef.get());

      if (doc && !doc.exists) {
        await userRef.set({
          email: user.email,
          loginUsername: user.displayName || fallbackDisplayName || '',
          username: user.displayName || fallbackDisplayName || '',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (error) {
      console.error('Error creating user document:', error);
    }
  }

  logout(): Promise<void> {
    return this.afAuth.signOut();
  }

  getAuthState(): Observable<firebase.User | null> {
    return this.afAuth.authState;
  }

  isAuthenticated(): Observable<boolean> {
    return this.afAuth.authState.pipe(map((user) => user !== null));
  }
}
