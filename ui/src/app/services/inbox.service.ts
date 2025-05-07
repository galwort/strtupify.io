import { Injectable } from '@angular/core';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, setDoc, getDoc, onSnapshot, QuerySnapshot, DocumentData } from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { Observable } from 'rxjs';

const fbApp = initializeApp(environment.firebase);
const db = getFirestore(fbApp);

export interface Email {
  id: string;
  sender: string;
  subject: string;
  body: string;
  preview: string;
  deleted: boolean;
  banner: boolean;
}

@Injectable({ providedIn: 'root' })
export class InboxService {
  ensureWelcomeEmail(companyId: string): Promise<void> {
    const welcomeRef = doc(db, `companies/${companyId}/inbox/welcome-vlad`);
    return getDoc(welcomeRef).then(snapshot => {
      if (snapshot.exists()) {
        return;
      }
      const message = `Hello End User,

This is Vlad from IT Support at startupify.io. I've been asked to reach out to you to explain how to use your new inbox application. If you've used a computer, you should know how to email, but in case you don't, let me walk you through it...

On the left side of your screen you should see a list of emails... those are your emails. You can click them to see what your email says on the preview pane on the right...

If you want to reply to that email, we have added that feature in as well. You can click the reply icon on the top bar to reply to an email. If you are unsure of what the reply icon looks like, I have added in a feature of REPLY spelled out next to it. This was the most reported issue by end users last year... When you reply to a message, the person that you are replying to will see the email in their own inbox, where they also have the ability to reply if their inbox has that feature built out. You are not able to see other people's inboxes. This was a confusing issue for end users as well...

If you want to delete an email there is a garbage can icon listed next to the reply feature. It also lists out the word DELETE in case that is confusing. When you click the delete icon, it deletes the email...

If you want to see your deleted emails you can click the archive icon, which has the word ARCHIVE spelled out next to it...

Our leadership team at startupify.io wanted to add a clock feature to the application, so that has been added in the bottom right of the screen. If you are using a computer to access this inbox, which would be the only way to access this inbox, you should also see a clock somewhere on your screen. Leadership insisted that we needed a clock to compete with the computer companies. Let me know if you need a walkthrough of how a clock works...

I am very good at programming, so you should not see any errors with anything, like the clock moving faster than it should. But if you experience an error, the standard operating protocol procedure is to send me an email. I am very busy and have a large backlog of features that leadership wants added, so I might not get to your email immediately...

Thank you!
Vlad
IT Support
strtupify.io`;
      return setDoc(welcomeRef, {
        from: 'vlad@strtupify.io',
        subject: 'How to email',
        message,
        deleted: false,
        banner: false
      });
    });
  }

  getInbox(companyId: string, includeDeleted: boolean = false): Observable<Email[]> {
    return new Observable<Email[]>(subscriber => {
      const inboxRef = collection(db, `companies/${companyId}/inbox`);
      const unsub = onSnapshot(inboxRef, (snap: QuerySnapshot<DocumentData>) => {
        const emails: Email[] = snap.docs
          .map(d => {
            const data = d.data() as any;
            return {
              id: d.id,
              sender: data.from,
              subject: data.subject,
              body: data.message,
              preview: (data.message || '').substring(0, 60) + '...',
              deleted: data.deleted,
              banner: data.banner
            };
          })
          .filter(e => includeDeleted || !e.deleted);
        subscriber.next(emails);
      });
      return () => unsub();
    });
  }

  deleteEmail(companyId: string, emailId: string): Promise<void> {
    return setDoc(
      doc(db, `companies/${companyId}/inbox/${emailId}`),
      { deleted: true },
      { merge: true }
    );
  }

  undeleteEmail(companyId: string, emailId: string): Promise<void> {
    return setDoc(
      doc(db, `companies/${companyId}/inbox/${emailId}`),
      { deleted: false },
      { merge: true }
    );
  }
}
