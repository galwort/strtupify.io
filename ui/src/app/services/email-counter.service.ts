import { Injectable } from '@angular/core';
import { getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { doc, getFirestore, increment, setDoc } from 'firebase/firestore';
import { environment } from 'src/environments/environment';

@Injectable({ providedIn: 'root' })
export class EmailCounterService {
  private readonly app = getApps().length ? getApps()[0] : initializeApp(environment.firebase);
  private readonly db = getFirestore(this.app);
  private readonly auth = getAuth(this.app);

  async recordInbound(delta = 1): Promise<void> {
    try {
      const user = this.auth.currentUser;
      if (!user) return;
      const count = Number.isFinite(delta) && delta > 0 ? Math.round(delta) : 1;
      await setDoc(
        doc(this.db, 'users', user.uid),
        { totalEmailCount: increment(count) },
        { merge: true }
      );
    } catch (err) {
      console.error('Failed to increment email counter', err);
    }
  }
}
