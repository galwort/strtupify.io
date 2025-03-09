import { Injectable } from '@angular/core';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import firebase from 'firebase/compat/app';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { AngularFirestore } from '@angular/fire/compat/firestore';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  constructor(
    private afAuth: AngularFireAuth,
    private firestore: AngularFirestore
  ) {}

  login(
    email: string,
    password: string
  ): Promise<firebase.auth.UserCredential> {
    return this.afAuth.signInWithEmailAndPassword(email, password);
  }

  register(
    email: string,
    password: string
  ): Promise<firebase.auth.UserCredential> {
    return this.afAuth.createUserWithEmailAndPassword(email, password);
  }

  async loginWithGoogle(): Promise<void> {
    const provider = new firebase.auth.GoogleAuthProvider();
    const credential = await this.afAuth.signInWithPopup(provider);
    const user = credential.user;

    if (user) {
      await this.createUserIfNotExists(user);
    }
  }

  async createUserIfNotExists(user: firebase.User): Promise<void> {
    const userRef = this.firestore.collection('users').doc(user.uid);

    try {
      const doc = await userRef.get().toPromise();

      if (doc && !doc.exists) {
        await userRef.set({
          email: user.email,
          loginUsername: user.displayName,
          username: user.displayName,
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
