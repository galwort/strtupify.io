import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  QuerySnapshot,
  DocumentData,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';
import { Observable } from 'rxjs';
import { AvatarMood } from '../utils/avatar';

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
  timestamp: string;
  read?: boolean;
  readAt?: string;
  threadId?: string;
  parentId?: string;
  to?: string;
  category?: string;
  senderName?: string;
  senderTitle?: string;
  avatarName?: string;
  avatarUrl?: string;
  avatarMood?: AvatarMood;
}

@Injectable({ providedIn: 'root' })
export class InboxService {
  constructor(private http: HttpClient) {}

  ensureWelcomeEmail(companyId: string): Promise<void> {
    const welcomeRef = doc(db, `companies/${companyId}/inbox/vlad-welcome`);
    return getDoc(welcomeRef).then((snapshot) => {
      const existing = snapshot.exists() ? (snapshot.data() as any) : null;
      if (snapshot.exists()) {
        const hasContent =
          existing &&
          typeof existing.subject === 'string' &&
          existing.subject.trim().length > 0 &&
          typeof existing.message === 'string' &&
          existing.message.trim().length > 0 &&
          typeof existing.from === 'string' &&
          existing.from.trim().length > 0;
        if (hasContent) return;
      }
      return new Promise<void>((resolve, reject) => {
        this.http
          .get('emails/vlad-welcome.md', { responseType: 'text' })
          .subscribe({
            next: async (text) => {
              const parsed = this.parseMarkdownEmail(text);
              const timestamp = new Date().toISOString();
              let toAddr = '';
              try {
                const companySnap = await getDoc(
                  doc(db, `companies/${companyId}`)
                );
                let domain = `${companyId}.com`;
                if (companySnap.exists()) {
                  const data = companySnap.data() as any;
                  if (data && data.company_name) {
                    domain =
                      String(data.company_name)
                        .replace(/\s+/g, '')
                        .toLowerCase() + '.com';
                  }
                }
                toAddr = `me@${domain}`;
              } catch {}
              try {
                const payload: any = {
                  from: parsed.from,
                  subject: parsed.subject,
                  message: parsed.body,
                  deleted: parsed.deleted ?? false,
                  banner: parsed.banner ?? false,
                  timestamp,
                  threadId: 'vlad-welcome',
                  to: toAddr,
                  category: 'vlad',
                  avatarUrl: 'assets/vlad.svg',
                };
                if (existing && existing.read !== undefined) {
                  payload.read = existing.read;
                }
                const existingReadAt =
                  (existing && (existing.readAt || existing.read_at)) || null;
                if (existingReadAt) {
                  payload.readAt = existingReadAt;
                }
                await setDoc(welcomeRef, {
                  ...payload,
                });
              resolve();
            } catch (e) {
              reject(e);
            }
            },
            error: (err) => reject(err),
          });
      });
    });
  }

  getInbox(
    companyId: string,
    includeDeleted: boolean = false
  ): Observable<Email[]> {
    return new Observable<Email[]>((subscriber) => {
      const inboxRef = collection(db, `companies/${companyId}/inbox`);
      const unsub = onSnapshot(
        inboxRef,
        (snap: QuerySnapshot<DocumentData>) => {
          const emails: Email[] = snap.docs
            .map((d) => {
              const data = d.data() as any;
              const readAtRaw = data.readAt || data.read_at;
              let readAt: string | undefined;
              if (readAtRaw && typeof readAtRaw.toDate === 'function') {
                readAt = readAtRaw.toDate().toISOString();
              } else if (readAtRaw instanceof Date) {
                readAt = readAtRaw.toISOString();
              } else if (typeof readAtRaw === 'number') {
                readAt = new Date(readAtRaw).toISOString();
              } else if (typeof readAtRaw === 'string') {
                readAt = readAtRaw;
              }
              return {
                id: d.id,
                sender: data.from,
                senderName: data.senderName || data.sender_name || '',
                senderTitle: data.senderTitle || data.sender_title || '',
                avatarName:
                  data.avatar ||
                  data.avatarName ||
                  data.photo ||
                  data.photoUrl ||
                  data.image ||
                  '',
                avatarUrl: data.avatarUrl || data.avatar_url || '',
                avatarMood:
                  typeof (data.avatarMood || data.avatar_mood) === 'string'
                    ? ((data.avatarMood || data.avatar_mood) as AvatarMood)
                    : undefined,
                subject: data.subject,
                body: data.message,
                preview: (data.message || '').substring(0, 60) + '...',
                deleted: data.deleted,
                banner: data.banner,
                timestamp: data.timestamp || '',
                threadId: data.threadId,
                parentId: data.parentId,
                to: data.to,
                category: data.category,
                read: !!(data.read || readAt),
                readAt: readAt || undefined,
              };
            })
            .filter((e) => includeDeleted || !e.deleted);
          subscriber.next(emails);
        }
      );
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

  markEmailRead(
    companyId: string,
    emailId: string,
    readAtIso?: string
  ): Promise<void> {
    const timestamp = readAtIso || new Date().toISOString();
    return setDoc(
      doc(db, `companies/${companyId}/inbox/${emailId}`),
      { read: true, readAt: timestamp },
      { merge: true }
    );
  }

  sendReply(
    companyId: string,
    opts: {
      threadId: string;
      subject: string;
      message: string;
      parentId?: string;
      from?: string;
      timestamp?: string;
      to?: string;
      category?: string;
    }
  ): Promise<string> {
    const emailId = `reply-${Date.now()}`;
    const payload: any = {
      from: opts.from || 'You',
      to: opts.to || '',
      subject: opts.subject,
      message: opts.message,
      deleted: false,
      banner: false,
      timestamp: opts.timestamp || new Date().toISOString(),
      threadId: opts.threadId,
      category: opts.category || undefined,
    };
    if (opts.parentId) payload.parentId = opts.parentId;
    return setDoc(
      doc(db, `companies/${companyId}/inbox/${emailId}`),
      payload
    ).then(() => emailId);
  }

  sendEmail(
    companyId: string,
    opts: {
      threadId: string;
      subject: string;
      message: string;
      from: string;
      to: string;
      category?: string;
      timestamp?: string;
    }
  ): Promise<string> {
    const emailId = `outbound-${Date.now()}`;
    const payload: any = {
      from: opts.from || 'You',
      to: opts.to || '',
      subject: opts.subject || '',
      message: opts.message,
      deleted: false,
      banner: false,
      timestamp: opts.timestamp || new Date().toISOString(),
      threadId: opts.threadId,
      category: opts.category || undefined,
    };
    return setDoc(
      doc(db, `companies/${companyId}/inbox/${emailId}`),
      payload
    ).then(() => emailId);
  }

  private parseMarkdownEmail(text: string): {
    from?: string;
    subject?: string;
    banner?: boolean;
    deleted?: boolean;
    body: string;
  } {
    const lines = text.split(/\r?\n/);
    let i = 0;
    const meta: any = {};
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) {
        i++;
        break;
      }
      const idx = line.indexOf(':');
      if (idx > -1) {
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (key === 'from') meta.from = value;
        else if (key === 'subject') meta.subject = value;
        else if (key === 'banner') meta.banner = /^true$/i.test(value);
        else if (key === 'deleted') meta.deleted = /^true$/i.test(value);
      } else {
        break;
      }
      i++;
    }
    const body = lines.slice(i).join('\n').trim();
    return { ...meta, body };
  }
}
